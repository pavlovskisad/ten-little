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

// On-chain rake bps must match the program's ProgramConfig.rake_bps
// (default 500 = 5%). If the admin changes it via set_rake_bps, this
// constant has to be updated too — or we can fetch ProgramConfig on
// boot. For v0 we hardcode the default; revisit when the admin
// instruction sees use.
const RAKE_BPS = 500n;

// Compute winners + amounts and call escrow.finalizePot. Skips the
// on-chain call when no eligible human winners exist — the pot
// account just sits there (admin recovery in Phase C). Reads the
// authoritative paid list straight from chain to avoid trusting the
// server's client-claimed wallets.
//
// topFigIds carries the placement-ordered figure ids: [1st, 2nd, 3rd].
// (1st = survivor, 2nd = last eliminated, 3rd = second-to-last.) The
// game ends last-man-standing, so this list is built from elimination
// order in GameRoom.tick().
async function finalizeRoom(room, roomIdBigInt, topFigIds) {
  if (!room.escrow) return;
  const pot = await escrow.fetchPot(roomIdBigInt);
  const paidWallets = pot.players.map(p => p.toBase58());
  const paidCount = paidWallets.length;
  if (paidCount === 0) {
    console.log('[escrow] no paid players in', room.code, '— skipping finalize_pot');
    return;
  }

  // Walk placement order; collect only paid humans for the eligible
  // list. Bots and unpaid humans drop out, but order is preserved so
  // 1st place stays 1st. If 1st is a bot, the next paid human takes
  // their tier slot — we don't shift down, we just skip.
  const eligible = [];
  for (const figId of topFigIds) {
    for (const [pid, p] of room.players) {
      if (p.figureId === figId && p.wallet && paidWallets.includes(p.wallet)) {
        eligible.push({ figId, wallet: p.wallet, playerId: pid });
        break;
      }
    }
  }
  if (eligible.length === 0) {
    console.log('[escrow] no eligible human winners in', room.code, '— skipping finalize_pot');
    return;
  }

  // Tier shares in basis points, indexed by paid_count (matches the
  // prize-tier table from the plan).
  const tierBps = paidCount >= 10 ? [5000, 3000, 2000]
                : paidCount >= 5  ? [7000, 3000]
                                  : [10000];

  const entryFee = BigInt(room.escrow.entryFee);
  const totalPlayed = BigInt(paidCount) * entryFee;
  const rake = (totalPlayed * RAKE_BPS) / 10000n;
  const pool = totalPlayed - rake;

  const numToPay = Math.min(tierBps.length, eligible.length);
  const amounts = new Array(numToPay);
  let usedSum = 0n;
  for (let i = 0; i < numToPay; i++) {
    const share = (pool * BigInt(tierBps[i])) / 10000n;
    amounts[i] = share;
    usedSum += share;
  }
  // 1st place absorbs rounding remainder + any unfilled tier slots so
  // sum(amounts) + on-chain rake == on-chain total_played exactly.
  amounts[0] += (pool - usedSum);

  const winners = eligible.slice(0, numToPay).map(w => w.wallet);
  const { signature } = await escrow.finalizePot(roomIdBigInt, winners, amounts);
  console.log('[escrow] finalize_pot', room.code, 'sig=' + signature,
              'winners=' + winners.length, 'pool=' + pool, 'rake=' + rake);

  // Cascade: now that rake has landed in rake_vault, drain it into
  // buyback_vault + rev_share. Errors are logged but non-fatal —
  // the finalize already succeeded, and rake just accumulates for
  // the next drain attempt. Skipped when rev_share isn't initialized
  // yet (admin hasn't called init_rev_share). On a successful run,
  // NFT holders see new claimable amounts on their next claim.
  try {
    const { signature: drainSig } = await escrow.drainRakeVault();
    console.log('[escrow] drain_rake_vault', room.code, 'sig=' + drainSig);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    // The most common reason for failure pre-init_rev_share is the
    // rev_share / buyback_vault accounts not existing yet. Log
    // calmly so it doesn't look like a real fault.
    if (msg.includes('AccountNotInitialized') || msg.includes('rev_share')) {
      console.log('[escrow] drain_rake_vault skipped (rev_share not initialized — run init_rev_share)');
    } else {
      console.warn('[escrow] drain_rake_vault failed', room.code, msg);
    }
  }
}

// Extensions where on-the-fly gzip is a meaningful win. Binary media
// (glb, mp3, png) is already compressed and gzipping it just burns
// CPU for no size reduction.
const GZIPPABLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.md']);

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 2570;
// Repo root: server/src/index.js → ../../
const STATIC_ROOT = path.resolve(__dirname, '..', '..');

// Cache-buster for the Preact bundles. Mobile Safari sometimes holds
// on to an old bundle even with no-store headers; bumping the URL on
// every deploy forces a fresh fetch because the browser hasn't seen
// the new query string before. We rewrite both plate-shapes.html and
// claim.html on the fly to inject these versions.
function bundleVersion(filename) {
  try {
    const stat = fs.statSync(path.join(STATIC_ROOT, filename));
    return String(Math.floor(stat.mtimeMs));
  } catch {
    return String(Date.now());
  }
}
const AUTH_BUNDLE_VERSION = bundleVersion('auth.bundle.js');
const CLAIM_BUNDLE_VERSION = bundleVersion('claim.bundle.js');
console.log('[static] auth bundle  =', AUTH_BUNDLE_VERSION);
console.log('[static] claim bundle =', CLAIM_BUNDLE_VERSION);

// Read each HTML file once on startup, inject the cache-buster on
// the bundle reference, cache the result in memory. If a file isn't
// where we expect (shouldn't happen, but a deploy quirk could leave
// it elsewhere), the corresponding cache entry stays null and the
// serve path falls back to plain file streaming.
function precacheHtml(filename, bundleName, version) {
  try {
    const raw = fs.readFileSync(path.join(STATIC_ROOT, filename), 'utf8');
    const escaped = bundleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped + '(?:\\?[^"\'\\s]*)?', 'g');
    const out = Buffer.from(raw.replace(re, bundleName + '?v=' + version));
    console.log('[static] cached', filename, '— bundle ?v=' + version);
    return out;
  } catch (err) {
    console.warn('[static] could not pre-cache', filename + ':', err.message,
      '— falling back to streaming file (no cache-bust)');
    return null;
  }
}
const PLATE_HTML = precacheHtml('plate-shapes.html', './auth.bundle.js', AUTH_BUNDLE_VERSION);
const CLAIM_HTML = precacheHtml('claim.html', './claim.bundle.js', CLAIM_BUNDLE_VERSION);

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

// Serve a cache-busted in-memory HTML buffer. Honours
// Accept-Encoding: gzip the same as the file-streaming path. If the
// pre-cache failed at startup (buf === null), returns false so the
// caller's fallback path streams the file directly.
function serveCachedHtml(req, res, buf) {
  if (!buf) return false;
  const noCacheHeaders = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
  };
  const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  if (acceptsGzip) {
    const gz = zlib.gzipSync(buf);
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
    'Content-Length': buf.length,
    ...noCacheHeaders,
  });
  res.end(buf);
  return true;
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/plate-shapes.html';
  // Friendly /claim alias for the rev-share page. Matches both /claim
  // and /claim/ so a trailing-slash bookmark also lands.
  if (urlPath === '/claim' || urlPath === '/claim/') urlPath = '/claim.html';
  // Resolve and clamp inside STATIC_ROOT so '..' can't escape.
  const safe = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(STATIC_ROOT, safe);
  if (!filePath.startsWith(STATIC_ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  // Special case: plate-shapes.html and claim.html are served from
  // in-memory buffers with their bundle URLs cache-busted. If the
  // pre-cache failed (e.g., file not on disk where we expected at
  // startup), serveCachedHtml returns false and we fall through to
  // plain streaming.
  if (filePath === path.join(STATIC_ROOT, 'plate-shapes.html')) {
    if (serveCachedHtml(req, res, PLATE_HTML)) return;
  }
  if (filePath === path.join(STATIC_ROOT, 'claim.html')) {
    if (serveCachedHtml(req, res, CLAIM_HTML)) return;
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
      // Smart matchmaking: pick the first lobby-phase quickmatch
      // room with capacity; if none exists, spin up a fresh one.
      // Practice rooms (mode='practice') are excluded — they're
      // single-shot solo games and never accept matchmakers.
      let room = null;
      for (const r of rooms.values()) {
        if (r.mode !== 'quickmatch') continue;
        if (r.state.phase !== 'lobby') continue;
        if (r.players.size >= MAX_PLAYERS) continue;
        room = r;
        break;
      }
      if (!room) {
        room = new GameRoom({ mode: 'quickmatch' });
        rooms.set(room.code, room);
      }
      if (!room.addPlayer(playerId, ws)) {
        send(ws, { type: 'error', message: 'could not join room' });
        return;
      }
      roomCode = room.code;
      // Pot creation is DEFERRED until 2+ humans are in the lobby.
      // First joiner pays nothing and can leave cleanly with no chain
      // interaction. When the second joiner lands, we init_pot once;
      // both clients see the new pot in the next roster broadcast and
      // trigger their join_pot tx from the onRoster handler.
      const needsPot = escrow.isEnabled() && !room.escrow && room.players.size >= 2;
      if (needsPot) {
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
          console.log('[escrow] init_pot', room.code, 'roomId=' + roomIdBigInt, '→ pot=' + pot,
                      `(triggered by 2nd human joining)`);
          // Wire lifecycle hooks at the same moment we create the pot.
          room.onRoundStart = async () => {
            try {
              const { signature: sig } = await escrow.startPot(roomIdBigInt);
              console.log('[escrow] start_pot', room.code, 'sig=' + sig);
            } catch (err) {
              console.warn('[escrow] start_pot failed', room.code, err.message);
            }
          };
          room.onRoundEnd = async ({ eliminated, topFigIds }) => {
            try {
              await finalizeRoom(room, roomIdBigInt, topFigIds);
            } catch (err) {
              console.warn('[escrow] finalize_pot failed', room.code, ':', err.message || err);
            }
          };
          // Push the fresh escrow payload to ALL clients in the room
          // (including the 1st joiner who didn't see it before).
          room.broadcastRoster();
        } catch (err) {
          console.warn('[escrow] init_pot failed for', room.code, ':', err.message);
          send(ws, { type: 'error', message: 'pot init failed: ' + err.message });
          // Don't tear down the room — the 1st joiner is still there
          // and we can retry on the next 2nd-joiner attempt.
          return;
        }
      }
      // Escrow payload is sent in 'joined' only when the room already
      // had a pot before this joiner (3rd+ players, or 2nd joiner who
      // triggered the create above). 1st joiner gets a bare 'joined';
      // they pick up the pot info in the next roster broadcast.
      const joinedMsg = { type: 'joined', code: room.code, playerId };
      if (room.escrow) joinedMsg.escrow = room.escrow;
      send(ws, joinedMsg);
      return;
    }
    if (msg.type === 'create') {
      // Practice room: no Privy required, no escrow, just bots.
      // Solo / "skip timer" flows both end up here.
      const room = new GameRoom({ mode: 'practice' });
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
      // Client confirms join_pot signed + submitted. We stash the
      // signature and the wallet address; finalize_pot uses the
      // wallet to pay the player when they place. The wallet claim
      // is enforced by the on-chain pot.players list — even if the
      // client lies here, finalize_pot's require! rejects winners
      // not in that list.
      const room = rooms.get(roomCode);
      if (!room) return;
      const player = room.players.get(playerId);
      if (player) {
        player.paidSig = msg.signature || null;
        player.wallet = msg.wallet || null;
        console.log('[escrow] paid', room.code, playerId, 'wallet=' + msg.wallet, 'sig=' + msg.signature);
        // Push a fresh roster so every client sees the new paid count
        // light up in the pot UI immediately.
        if (room.state.phase === 'lobby') room.broadcastRoster();
      }
      return;
    }
    // Note: the player-initiated 'cancel' message handler was removed.
    // Paid matches are no-refund: once a player completes join_pot
    // their entry stays in the pot regardless of how they exit (close
    // tab, disconnect, server-side timeout). escrow.refundPot is still
    // available for server-internal use — currently the only legitimate
    // case is "paid lobby aged out without enough humans to start" —
    // and is invoked by the lobby-timeout path in GameRoom.
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
