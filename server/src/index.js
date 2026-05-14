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
// The gzip path uses the buffer directly via createGzip().pipe; the
// uncompressed path needs Content-Length so we keep both around.
const PLATE_HTML = (() => {
  const raw = fs.readFileSync(path.join(STATIC_ROOT, 'plate-shapes.html'), 'utf8');
  return Buffer.from(
    raw.replace(/\.\/auth\.bundle\.js(?:\?[^"'\s]*)?/g, './auth.bundle.js?v=' + BUNDLE_VERSION)
  );
})();

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
// Accept-Encoding: gzip the same as the file-streaming path so we
// keep the ~70% bandwidth win.
function servePlateHtml(req, res) {
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
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME['.html'],
    'Content-Length': PLATE_HTML.length,
    ...noCacheHeaders,
  });
  res.end(PLATE_HTML);
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
  // with the auth.bundle.js URL cache-busted. We could read the file
  // every time, but this keeps the rewrite cost off the hot path.
  if (filePath === path.join(STATIC_ROOT, 'plate-shapes.html')) {
    servePlateHtml(req, res);
    return;
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
      }
      if (!room.addPlayer(playerId, ws)) {
        send(ws, { type: 'error', message: 'could not join room' });
        return;
      }
      roomCode = room.code;
      send(ws, { type: 'joined', code: room.code, playerId });
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
