// Minimal multiplayer game server. ws + http; no Colyseus yet. Each
// client opens a WebSocket and sends/receives JSON messages.
//
// Protocol (v0):
//   client → server:
//     { type: 'create', name?: string }    — create a fresh room, join it
//     { type: 'join', code: string }       — join an existing room by code
//     { type: 'input', dx: number, dy: number } — joystick state, [-1, 1]
//     { type: 'start' }                    — host begins the round early
//   server → client:
//     { type: 'joined', code, playerId }
//     { type: 'roster', count, max }
//     { type: 'start', humans, bots, seed }
//     { type: 'state', state }
//     { type: 'end', eliminated, survivors }
//     { type: 'error', message }

const http = require('http');
const { WebSocketServer } = require('ws');
const { GameRoom, MAX_PLAYERS } = require('./GameRoom.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 2567;

const rooms = new Map();  // code → GameRoom
let playerSeq = 0;

function nextPlayerId() {
  return `P${(++playerSeq).toString(36).padStart(4, '0')}`;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
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
  res.writeHead(404).end('not found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const playerId = nextPlayerId();
  let roomCode = null;
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { send(ws, { type: 'error', message: 'invalid json' }); return; }

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
      room.start();
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
