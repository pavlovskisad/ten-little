// Minimal multiplayer game server. ws + http; no Colyseus yet. Each
// client opens a WebSocket and sends/receives JSON messages.
//
// Also serves the static client (plate-shapes.html, sim/, *.glb, *.mp3,
// etc.) from the repo root so one process is the whole game.
//
// Protocol (v0):
//   client → server:
//     { type: 'create', name?: string }    — create a fresh room, join it
//     { type: 'join', code: string }       — join an existing room by code
//     { type: 'input', dx: number, dy: number } — joystick state, [-1, 1]
//     { type: 'start' }                    — host begins the round early
//   server → client:
//     { type: 'joined', code, playerId }
//     { type: 'roster', code, count, max, host, countdownMs }
//     { type: 'start', humans, bots, seed, reason, bindings }
//     { type: 'state', state }
//     { type: 'end', eliminated, survivors }
//     { type: 'error', message }

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const { GameRoom, MAX_PLAYERS } = require('./GameRoom.js');
const { verifyAccessToken } = require('./privy.js');
const escrow = require('./escrow.js');

// Wake up the on-chain client. No-ops cleanly when
// ORACLE_KEYPAIR_JSON is unset (logs a clear "disabled" line).
escrow.init();

// v0 fixed entry fee. 0.01 SOL — locked-in number from the plan.
// Phase B5+ will tier this; for now every quickmatch costs the same.
const ENTRY_FEE_LAMPORTS = 10_000_000n;

// On-chain room id is a u64 distinct from the human-readable
// R-prefixed WS code. We seed from millisecond timestamp and bump
// per-room — same process can't issue two ids in the same ms reliably.
let _roomIdCounter = BigInt(Date.now()) * 1000n;
function nextRoomIdBigInt() {
  _roomIdCounter += 1n;
  return _roomIdCounter;
}

// Extensions where on-the-fly gzip is a meaningful win. Binary media
// (glb, mp3, png) is already compressed and gzipping it just burns
// CPU for no size reduction.
const GZIPPABLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.md']);

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 2570;
// Repo root: server/src/index.js → ../../
const STATIC_ROOT = path.resolve(__dirname, '..', '..');

// Cache-buster for auth.bundle.js. Mobile Safari sometimes holds on
// to an old bundle even with no-store headers; bumping the URL on
// every deploy forces a fresh fetch because the browser hasn't seen
// the new query string before. We rewrite plate-shapes.html on the
// fly to inject this version.
const BUNDLE_VERSION = (() => {
  try {
    const stat = fs.statSync(path.join(STATIC_ROOT, 'auth.bundle.js'));
    return String(Math.floor(stat.mtimeMs));
  } catch {
    return String(Date.now());
  }
})();
console.log('[static] bundle version =', BUNDLE_VERSION);

// Read plate-shapes.html once on startup, inject the cache-buster on
// every "./auth.bundle.js" reference, cache the result in memory.
// If the file isn't where we expect (shouldn't happen, but a deploy
// quirk could leave it elsewhere), keep PLATE_HTML null and the
// serve path falls back to plain file streaming.
let PLATE_HTML = null;
try {
  const raw = fs.readFileSync(path.join(STATIC_ROOT, 'plate-shapes.html'), 'utf8');
  PLATE_HTML = Buffer.from(
    raw.replace(/\.\/auth\.bundle\.js(?:\?[^"'\s]*)?/g, './auth.bundle.js?v=' + BUNDLE_VERSION)
  );
  console.log('[static] cached plate-shapes.html, bundle ?v=' + BUNDLE_VERSION);
} catch (err) {
  console.warn('[static] could not pre-cache plate-shapes.html:', err.message,
    '— falling back to streaming file (no cache-bust)');
}

const rooms = new Map();  // code → GameRoom
let playerSeq = 0;

function nextPlayerId() {
  return `P${(++playerSeq).toString(36).padStart(4, '0')}`;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Whitelist of extensions we'll serve, mapped to content types.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
};

// Serve the cache-busted in-memory plate-shapes.html. Honours
// Accept-Encoding: gzip the same as the file-streaming path. If the
// pre-cache failed at startup (PLATE_HTML === null), the caller's
// fallback path streams the file directly.
function servePlateHtml(req, res) {
  if (!PLATE_HTML) return false;
  const noCacheHeaders = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
  };
  const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  if (acceptsGzip) {
    const gz = zlib.gzipSync(PLATE_HTML);
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Content-Encoding': 'gzip',
      'Content-Length': gz.length,
      'Vary': 'Accept-Encoding',
      ...noCacheHeaders,
    });
    res.end(gz);
    return true;
  }
  res.writeHead(200, {
    'Content-Type': MIME['.html'],
    'Content-Length': PLATE_HTML.length,
    ...noCacheHeaders,
  });
  res.end(PLATE_HTML);
  return true;
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/plate-shapes.html';
  // Resolve and clamp inside STATIC_ROOT so '..' can't escape.
  const safe = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(STATIC_ROOT, safe);
  if (!filePath.startsWith(STATIC_ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  // Special case: plate-shapes.html is served from an in-memory buffer
  // with the auth.bundle.js URL cache-busted. If the pre-cache failed
  // (e.g., file not on disk where we expected at startup), servePlateHtml
  // returns false and we fall through to plain streaming.
  if (filePath === path.join(STATIC_ROOT, 'plate-shapes.html')) {
    if (servePlateHtml(req, res)) return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ct = MIME[ext];
    if (!ct) {
      res.writeHead(415).end('unsupported media type');
      return;
    }
    // Don't cache the HTML or sim modules during dev so reloads pick
    // up changes immediately. Long-cache the assets that don't change.
    // Use the belt-and-suspenders set of no-cache headers — mobile
    // Safari sometimes serves a cached HTML page on back/forward
    // navigation despite plain Cache-Control: no-store.
    const noCache = ext === '.html' || ext === '.js' || ext === '.json';
    const noCacheHeaders = noCache
      ? {
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0',
        }
      : { 'Cache-Control': 'public, max-age=300' };
    const total = stat.size;
    // HTTP Range support. Required for HTMLAudioElement.currentTime
    // seeking on the mp3 score: setting currentTime triggers a Range
    // request for the byte offset of the new playhead, and if the
    // server can't honor it the browser silently bails to byte 0.
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
        return;
      }
      const start = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
      if (start >= total || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': ct,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        ...noCacheHeaders,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    // gzip on the wire for text assets. Skipped for binary media
    // (already compressed) and for Range requests (Range + gzip is
    // its own headache; serve uncompressed). Drops auth.bundle.js
    // from ~3.6 MB raw to ~700 KB on the wire.
    const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
    if (acceptsGzip && GZIPPABLE.has(ext)) {
      res.writeHead(200, {
        'Content-Type': ct,
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding',
        'Accept-Ranges': 'bytes',
        ...noCacheHeaders,
      });
      fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      ...noCacheHeaders,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      players: [...rooms.values()].reduce((s, r) => s + r.players.size, 0),
    }));
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const playerId = nextPlayerId();
  let roomCode = null;
  // Privy identity bound by quickjoin (when the client includes a
  // token). Practice ('create' for solo) leaves this null.
  let privyUserId = null;
  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { send(ws, { type: 'error', message: 'invalid json' }); return; }

    if (msg.type === 'quickjoin') {
      // Quickmatch is gated on a verified Privy identity. The token
      // is bundled in the quickjoin message itself (atomic — no race
      // between separate 'auth' and 'quickjoin' messages).
      try {
        const { userId } = await verifyAccessToken(msg.token);
        privyUserId = userId;
      } catch (err) {
        console.warn('[auth] verify failed:', err.message);
        send(ws, { type: 'error', message: 'auth failed: ' + err.message });
        return;
      }
      // Smart matchmaking: pick the first lobby-phase room with
      // capacity; if none exists, spin up a fresh one. Friends who
      // both tap "join" within the same lobby window land together
      // without needing to coordinate a room code.
      let room = null;
      for (const r of rooms.values()) {
        if (r.state.phase !== 'lobby') continue;
        if (r.players.size >= MAX_PLAYERS) continue;
        room = r;
        break;
      }
      if (!room) {
        room = new GameRoom({});
        rooms.set(room.code, room);
        // First joiner of a fresh quickmatch room → spin up the
        // on-chain pot. Stays a no-op when escrow is disabled. We
        // block the joined response until init_pot confirms so the
        // client doesn't have to handle a delayed pot payload — devnet
        // finalization is ~1 s, acceptable for v0.
        if (escrow.isEnabled()) {
          try {
            const roomIdBigInt = nextRoomIdBigInt();
            const entryFee = ENTRY_FEE_LAMPORTS;
            const { signature, pot } = await escrow.initPot(roomIdBigInt, entryFee);
            room.escrow = {
              roomId: String(roomIdBigInt),
              pot,
              entryFee: String(entryFee),
              signature,
            };
            console.log('[escrow] init_pot', room.code, 'roomId=' + roomIdBigInt, '→ pot=' + pot);
          } catch (err) {
            console.warn('[escrow] init_pot failed for', room.code, ':', err.message);
            // Tear down the WS room so the next quickjoin doesn't try
            // to re-join a half-formed pot-less room.
            rooms.delete(room.code);
            send(ws, { type: 'error', message: 'pot init failed: ' + err.message });
            return;
          }
        }
      }
      if (!room.addPlayer(playerId, ws)) {
        send(ws, { type: 'error', message: 'could not join room' });
        return;
      }
      roomCode = room.code;
      // Escrow payload is only attached when the room has an on-chain
      // pot. Practice / unauthenticated rooms send a bare joined.
      const joinedMsg = { type: 'joined', code: room.code, playerId };
      if (room.escrow) joinedMsg.escrow = room.escrow;
      send(ws, joinedMsg);
      return;
    }
    if (msg.type === 'create') {
      const room = new GameRoom({});
      rooms.set(room.code, room);
      if (!room.addPlayer(playerId, ws)) {
        send(ws, { type: 'error', message: 'could not join fresh room' });
        return;
      }
      roomCode = room.code;
      send(ws, { type: 'joined', code: room.code, playerId });
      return;
    }
    if (msg.type === 'join') {
      const room = rooms.get(msg.code);
      if (!room) { send(ws, { type: 'error', message: 'no such room' }); return; }
      if (!room.addPlayer(playerId, ws)) {
        send(ws, { type: 'error', message: 'room is full or already started' });
        return;
      }
      roomCode = room.code;
      send(ws, { type: 'joined', code: room.code, playerId });
      return;
    }
    if (msg.type === 'paid') {
      // Client claims they've signed + submitted join_pot. For v0 we
      // just log + stash. Phase B4 will RPC-validate against
      // pot.players before allowing the player into finalize_pot's
      // winners list. Until then, the on-chain require! in
      // finalize_pot is the only enforcement, but unpaid players also
      // can't be winners (their pubkey wouldn't appear in pot.players
      // when finalize runs).
      const room = rooms.get(roomCode);
      if (!room) return;
      const player = room.players.get(playerId);
      if (player) {
        player.paidSig = msg.signature || null;
        console.log('[escrow] paid', room.code, playerId, '→ sig=' + msg.signature);
      }
      return;
    }
    if (msg.type === 'input') {
      const room = rooms.get(roomCode);
      if (!room) return;
      room.setInput(playerId, msg.dx || 0, msg.dy || 0);
      return;
    }
    if (msg.type === 'start') {
      const room = rooms.get(roomCode);
      if (!room) return;
      if (!room.isHost(playerId)) {
        send(ws, { type: 'error', message: 'only the host can start the round' });
        return;
      }
      room.start('host');
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(roomCode);
    if (room) {
      room.removePlayer(playerId);
      // Tear down the room when it's empty AND no longer in play. We
      // keep in-progress rounds running with bots so the remaining
      // players don't lose their game.
      if (room.players.size === 0 && room.state.phase !== 'play') {
        room.stop();
        rooms.delete(roomCode);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}, max ${MAX_PLAYERS} per room`);
});
