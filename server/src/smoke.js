// Pure-Node smoke test for GameRoom. Bypasses WebSocket, drives the
// room directly. Verifies a full round runs end-to-end inside the
// room wrapper.

const { GameRoom, MAX_PLAYERS } = require('./GameRoom.js');

function fakeWS() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(d) { sent.push(d); },
  };
}

const room = new GameRoom({ seed: 12345 });
console.log('[smoke] room', room.code, 'seed', room.seed);

// Two fake humans join, then start. Remaining 8 seats fill with bots.
const w1 = fakeWS(), w2 = fakeWS();
console.log('[smoke] add P1:', room.addPlayer('P1', w1));
console.log('[smoke] add P2:', room.addPlayer('P2', w2));
console.log('[smoke] starting...');
room.start();
console.log('[smoke] figures after start:', room.state.figs.length, 'humans:', room.humansAtStart, 'bots:', room.botsAtStart);
console.log('[smoke] P1 figureId:', [...room.players.values()][0].figureId, 'P2 figureId:', [...room.players.values()][1].figureId);

// Drive joystick on P1 for the whole round so we exercise the
// player-intent branch.
const driveP1 = setInterval(() => room.setInput('P1', 1, 0), 100);

const checkpoint = setInterval(() => {
  console.log(`[smoke] t=${(room.state.t / 1000).toFixed(1)}s alive=${room.state.alive} hand=${room.state.hand.phase}`);
}, 5000);

// Wait for the room to finish (room.tickHandle gets cleared in tick()).
const waitForEnd = setInterval(() => {
  if (room.state.phase === 'over') {
    clearInterval(waitForEnd);
    clearInterval(driveP1);
    clearInterval(checkpoint);
    console.log('[smoke] END');
    console.log('[smoke] eliminations:', room.state.eliminated.map(e => `${e.id}:${e.reason}`).join(' '));
    console.log('[smoke] survivors:', room.state.figs.filter(f => f.alive).map(f => f.id).join(','));
    console.log('[smoke] state snapshots sent:', w1.sent.length);
    // Print one mid-round state snapshot for sanity.
    const stateMsg = w1.sent.find(s => s.includes('"type":"state"'));
    if (stateMsg) {
      const parsed = JSON.parse(stateMsg);
      console.log('[smoke] sample snapshot:', JSON.stringify({
        alive: parsed.state.alive,
        plateR: +parsed.state.plateR.toFixed(2),
        hand: parsed.state.hand.phase,
        figCount: parsed.state.figs.length,
      }));
    }
    process.exit(0);
  }
}, 100);

// Safety timeout: kill if it doesn't end in 3 wall-clock minutes.
setTimeout(() => {
  console.error('[smoke] TIMEOUT — round did not finish');
  process.exit(1);
}, 180_000);
