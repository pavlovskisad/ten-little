// One room = one in-progress or pending game. Owns its own simulation
// state, ticker, and list of connected WebSocket clients. The sim runs
// authoritatively here; clients send input messages and receive state
// snapshots at the tick rate.

const path = require('path');
const SIM = Object.assign({},
  require(path.join(__dirname, '..', '..', 'sim', 'cfg.js')),
  require(path.join(__dirname, '..', '..', 'sim', 'state.js')),
  require(path.join(__dirname, '..', '..', 'sim', 'figures.js')),
  require(path.join(__dirname, '..', '..', 'sim', 'hand.js')),
  require(path.join(__dirname, '..', '..', 'sim', 'rng.js')),
  require(path.join(__dirname, '..', '..', 'sim', 'headless.js')),
);

const TICK_MS = 33;   // 30 Hz
const COUNTDOWN_MS = 60_000;
const MAX_PLAYERS = 10;

let roomSeq = 0;

class GameRoom {
  constructor({ code, seed }) {
    this.code = code || `R${(++roomSeq).toString(36).padStart(4, '0')}`;
    this.seed = seed || (Math.random() * 0xffffffff) >>> 0;
    this.rand = SIM.mulberry32(this.seed);
    this.state = SIM.createState();
    this.state.phase = 'lobby';
    this.players = new Map();    // playerId -> { ws, input, figureId }
    this.tickHandle = null;
    this.lobbyDeadline = Date.now() + COUNTDOWN_MS;
    this.startedAt = 0;
    this.host = null;            // playerId of the room's creator
    // Auto-start: if the host doesn't start early, kick off the round
    // when the lobby countdown expires. Bots fill remaining seats.
    this.autoStartHandle = setTimeout(() => this.start('auto'), COUNTDOWN_MS);
  }

  // Returns true if added, false if room is full or already started.
  addPlayer(playerId, ws) {
    if (this.state.phase !== 'lobby') return false;
    if (this.players.size >= MAX_PLAYERS) return false;
    if (this.host === null) this.host = playerId;
    this.players.set(playerId, { ws, input: { dx: 0, dy: 0 }, figureId: null });
    this.broadcastRoster();
    return true;
  }

  // Roster broadcast carries countdown so clients can render a live timer
  // without polling.
  broadcastRoster() {
    this.broadcast({
      type: 'roster',
      code: this.code,
      count: this.players.size,
      max: MAX_PLAYERS,
      host: this.host,
      countdownMs: Math.max(0, this.lobbyDeadline - Date.now()),
    });
  }

  isHost(playerId) {
    return this.host === playerId;
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    this.players.delete(playerId);
    // If the round is in progress, the player's figure becomes a bot:
    // the simulation already runs botIntent for any figure with
    // isPlayer === false, so we just flip the flag and unbind input.
    if (p.figureId != null) {
      const f = this.state.figs.find(x => x.id === p.figureId);
      if (f) f.isPlayer = false;
    }
    // Host left → hand off to whoever's next in join order so the
    // lobby can still be started by a remaining player.
    if (this.host === playerId) {
      const next = this.players.keys().next().value;
      this.host = next || null;
    }
    if (this.state.phase === 'lobby') this.broadcastRoster();
  }

  setInput(playerId, dx, dy) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.input.dx = dx;
    p.input.dy = dy;
  }

  // Start the round: fill remaining seats with bots, spawn figures,
  // begin the tick loop. `reason` is 'host' when a host clicks start
  // early, 'auto' when the countdown expires.
  start(reason = 'host') {
    if (this.state.phase !== 'lobby') return;
    if (this.autoStartHandle) { clearTimeout(this.autoStartHandle); this.autoStartHandle = null; }
    const humans = this.players.size;
    const bots = MAX_PLAYERS - humans;

    SIM.spawnBots(this.state, MAX_PLAYERS, this.rand);
    // Bind the first `humans` figures to connected players in join order.
    // The player gets their figureId so the client can render the marker
    // on the right body without guessing.
    let idx = 0;
    const bindings = {};
    for (const [pid, p] of this.players) {
      const fig = this.state.figs[idx++];
      fig.isPlayer = true;
      p.figureId = fig.id;
      bindings[pid] = fig.id;
    }
    this.humansAtStart = humans;
    this.botsAtStart = bots;
    this.state.phase = 'play';
    this.startedAt = Date.now();
    this.state.startedAt = this.startedAt;

    this.broadcast({ type: 'start', humans, bots, seed: this.seed, reason, bindings });
    // Lifecycle hook — index.js wires this to escrow.startPot when a
    // pot exists for the room. Kept off GameRoom's own dependency
    // surface so the sim stays escrow-agnostic.
    if (typeof this.onRoundStart === 'function') {
      Promise.resolve(this.onRoundStart()).catch(err => {
        console.warn('[room] onRoundStart failed', this.code, err.message || err);
      });
    }
    this.tickHandle = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (this.autoStartHandle) clearTimeout(this.autoStartHandle);
    this.tickHandle = null;
    this.autoStartHandle = null;
  }

  tick() {
    const dt = TICK_MS / 1000;

    // Translate per-player input into figure intent. The sim's
    // tickMovement expects getIntent(f, dt) → [vx, vz]; here we
    // recompute intent for player-bound figures and let bots fall
    // through to botIntent.
    const playerIntent = (f) => {
      const p = [...this.players.values()].find(pp => pp.figureId === f.id);
      if (!p) return SIM.botIntent(f, dt, this.state, this.rand);
      let { dx, dy } = p.input;
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      return [dx * SIM.CFG.playerSpeed, dy * SIM.CFG.playerSpeed];
    };

    // Run the same composed tick the headless driver uses, but with
    // mixed intent: player input for human figures, botIntent for bots.
    const eliminate = (f, reason) => SIM.applyEliminate(this.state, f, reason);
    const S = this.state;
    if (S.phase !== 'play') return;
    S.t = Date.now() - this.startedAt;
    SIM.tickTilt(S, dt);
    SIM.tickMovement(S, dt, (f) => f.isPlayer ? playerIntent(f) : SIM.botIntent(f, dt, S, this.rand));
    for (const ev of SIM.tickCollisions(S)) eliminate(ev.figure, ev.reason);
    for (const ev of SIM.tickEdgeFall(S))   eliminate(ev.figure, ev.reason);
    SIM.maybeShrink(S);
    if (S.hand.phase === 'idle' && S.t >= S.nextHandAt) SIM.startHand(S, this.rand);
    if (S.hand.phase !== 'idle') {
      S.hand.t += dt * 1000;
      SIM.tickPredatorAim(S, dt);
      for (const tr of SIM.advanceHandPhase(S)) {
        if (tr.from === 'approach' && tr.to === 'hover') {
          for (const f of SIM.captureInZone(S)) eliminate(f, 'picked');
        }
      }
    }

    // End round when only the podium remains.
    if (S.alive <= SIM.CFG.podiumCount) {
      S.phase = 'over';
      const survivors = S.figs.filter(f => f.alive).map(f => f.id);
      this.broadcast({ type: 'end', eliminated: S.eliminated, survivors });
      // Lifecycle hook — index.js wires this to escrow.finalizePot
      // with the computed winners + amounts.
      if (typeof this.onRoundEnd === 'function') {
        Promise.resolve(this.onRoundEnd({ eliminated: S.eliminated, survivors })).catch(err => {
          console.warn('[room] onRoundEnd failed', this.code, err.message || err);
        });
      }
      this.stop();
      return;
    }

    this.broadcast({ type: 'state', state: this.snapshot() });
  }

  // Trim S down to just the data clients need to render. Keep figures
  // and hand only — skip internal fields.
  snapshot() {
    const figs = this.state.figs.map(f => ({
      id: f.id, x: f.x, z: f.z, vx: f.vx, vz: f.vz,
      hp: f.hp, alive: f.alive,
      picked: f.picked, dropping: f.dropping, draining: f.draining,
      isPlayer: f.isPlayer,
    }));
    const h = this.state.hand;
    return {
      t: this.state.t,
      plateR: this.state.plateR,
      tilt: this.state.tilt,
      // Full hand state. The visual is built from per-cycle randomized
      // values (azimuth, durations, arc magnitudes, hover drift, hold
      // window) that the client reads to compute per-phase progress
      // and orientation; without them the renderer hits NaN math and
      // the claw mesh disappears.
      hand: {
        phase: h.phase, x: h.x, z: h.z, zoneR: h.zoneR, t: h.t,
        azimuth: h.azimuth || 0,
        telegraphMs: h.telegraphMs || 1000,
        approachMs:  h.approachMs  || 700,
        hoverMs:     h.hoverMs     || 200,
        pinchMs:     h.pinchMs     || 250,
        liftMs:      h.liftMs      || 900,
        approachArc:    h.approachArc    || 1.0,
        liftArc:        h.liftArc        || 1.0,
        approachEaseMix: h.approachEaseMix || 0,
        hoverDriftAmp:   h.hoverDriftAmp   || 0,
        hoverDriftPhase: h.hoverDriftPhase || 0,
        holdStart: h.holdStart || 0.4,
        holdEnd:   h.holdEnd   || 0.55,
      },
      figs,
      alive: this.state.alive,
    };
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const { ws } of this.players.values()) {
      if (ws.readyState === 1 /* OPEN */) ws.send(data);
    }
  }
}

module.exports = { GameRoom, MAX_PLAYERS, COUNTDOWN_MS, TICK_MS };
