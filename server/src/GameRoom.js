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
// Window after a paid quickmatch room drops below 2 humans before the
// server auto-refunds the remaining paid player(s). Long enough for
// matchmaking to drop a fresh joiner in (countdown-equivalent), short
// enough that a stranded player isn't sitting around for minutes.
const STALE_LOBBY_MS = 90_000;
const MAX_PLAYERS = 10;

let roomSeq = 0;

class GameRoom {
  constructor({ code, seed, mode }) {
    this.code = code || `R${(++roomSeq).toString(36).padStart(4, '0')}`;
    // 'practice' = free solo + bots (no escrow, no Privy required).
    // 'quickmatch' = paid multiplayer (requires Privy auth + an
    //                on-chain pot via init_pot).
    this.mode = mode || 'quickmatch';
    this.seed = seed || (Math.random() * 0xffffffff) >>> 0;
    this.rand = SIM.mulberry32(this.seed);
    this.state = SIM.createState();
    this.state.phase = 'lobby';
    this.players = new Map();    // playerId -> { ws, input, figureId }
    this.tickHandle = null;
    // Auto-start is deferred: practice rooms arm it on the first
    // joiner; quickmatch rooms wait for a 2nd human before arming.
    // Until armed, lobbyDeadline stays 0 → roster broadcasts countdownMs=0
    // and the client renders a "waiting for opponents" state instead
    // of a ticking timer.
    this.lobbyDeadline = 0;
    this.autoStartHandle = null;
    this.startedAt = 0;
    this.host = null;            // playerId of the room's creator
  }

  // Arm the auto-start countdown the first time conditions are met.
  // Practice rooms: arm on first joiner. Quickmatch: arm only when
  // at least 2 humans are present, so a lone player waits indefinitely
  // without paying anything (pot init is gated on 2 humans too).
  armAutoStart() {
    if (this.autoStartHandle) return;
    if (this.mode === 'quickmatch' && this.players.size < 2) return;
    this.lobbyDeadline = Date.now() + COUNTDOWN_MS;
    this.autoStartHandle = setTimeout(() => this.start('auto'), COUNTDOWN_MS);
  }

  // Returns true if added, false if room is full or already started.
  addPlayer(playerId, ws) {
    if (this.state.phase !== 'lobby') return false;
    if (this.players.size >= MAX_PLAYERS) return false;
    if (this.host === null) this.host = playerId;
    this.players.set(playerId, {
      ws,
      input: { dx: 0, dy: 0 },
      figureId: null,
      disconnected: false,
    });
    this.armAutoStart();
    this._evaluateStaleLobby();
    this.broadcastRoster();
    return true;
  }

  // Track + announce the "paid player(s) waiting alone after opponent
  // bail" state. Called from addPlayer / removePlayer / disconnect /
  // reconnect. When the state is entered, schedule a refund timer and
  // tell remaining players what's happening. When it's exited (new
  // joiner, etc.), cancel the timer and notify them.
  _evaluateStaleLobby() {
    if (this.mode !== 'quickmatch') return;
    if (!this.escrow) return;
    if (this.state.phase !== 'lobby') return;
    const paidConnected = [...this.players.values()].filter(
      p => p.paidSig && p.wallet && !p.disconnected
    );
    const isStale = paidConnected.length > 0 && this.players.size < 2;
    if (isStale && !this.staleTimeout) {
      // Just entered the stale state. Notify everyone still here and
      // schedule the refund. Stored deadline lets late joiners' roster
      // broadcasts include the same countdown.
      this.staleRefundAt = Date.now() + STALE_LOBBY_MS;
      this.staleTimeout = setTimeout(() => {
        this.staleTimeout = null;
        if (typeof this.onStaleTimeout === 'function') {
          const wallets = [...this.players.values()]
            .filter(p => p.paidSig && p.wallet)
            .map(p => p.wallet);
          Promise.resolve(this.onStaleTimeout(wallets)).catch(err => {
            console.warn('[room] onStaleTimeout failed', this.code, err.message || err);
          });
        }
      }, STALE_LOBBY_MS);
      this.broadcast({
        type: 'opponentLeft',
        refundIn: STALE_LOBBY_MS,
        refundAt: this.staleRefundAt,
      });
    } else if (!isStale && this.staleTimeout) {
      // Recovered — a new joiner showed up. Cancel the refund + tell
      // clients to clear the warning UI.
      clearTimeout(this.staleTimeout);
      this.staleTimeout = null;
      this.staleRefundAt = null;
      this.broadcast({ type: 'opponentArrived' });
    }
  }

  // Roster broadcast carries countdown so clients can render a live timer
  // without polling. Escrow payload (pot address, entry fee, paid count)
  // ships only when the room has an on-chain pot; the lobby UI uses
  // paid count to show "pot: X SOL" without hitting RPC every second.
  broadcastRoster() {
    // "Waiting" mode: quickmatch room with a single human in it.
    // Countdown is intentionally not armed; client renders "waiting
    // for opponents…" instead of a ticking timer.
    const waiting = (this.mode === 'quickmatch' && this.players.size < 2);
    const msg = {
      type: 'roster',
      code: this.code,
      count: this.players.size,
      max: MAX_PLAYERS,
      host: this.host,
      countdownMs: this.lobbyDeadline > 0
        ? Math.max(0, this.lobbyDeadline - Date.now())
        : 0,
      waiting,
      mode: this.mode,
    };
    if (this.escrow) {
      let paidCount = 0;
      for (const p of this.players.values()) if (p.paidSig) paidCount += 1;
      msg.escrow = {
        pot: this.escrow.pot,
        entryFee: this.escrow.entryFee,
        paidCount,
      };
    }
    // If we're in the stale-lobby grace window, surface the deadline
    // so a fresh roster (e.g. for a just-reconnected client) carries
    // the same countdown the original opponentLeft message did.
    if (this.staleRefundAt) {
      msg.staleRefundAt = this.staleRefundAt;
    }
    this.broadcast(msg);
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
    this._evaluateStaleLobby();
    if (this.state.phase === 'lobby') this.broadcastRoster();
  }

  // Soft disconnect: the player's WS closed but they hold a valid
  // session token, so we keep the slot reserved for reconnect. Their
  // figure flips to bot AI for the duration. Used for paid players
  // — unpaid disconnects still fall through removePlayer().
  disconnect(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.ws = null;
    p.disconnected = true;
    p.disconnectedAt = Date.now();
    p.input.dx = 0; p.input.dy = 0;
    // Deliberately do NOT flip the figure's isPlayer flag. The end
    // condition counts isPlayer figures as "live humans" — flipping
    // it would end the round the instant a single player disconnects,
    // which is the opposite of what reconnect needs. The tick loop's
    // playerIntent helper inspects p.disconnected and falls back to
    // botIntent for those figures, so movement still happens; the
    // slot just contributes a bot's worth of skill until reconnect.
    if (this.state.phase === 'lobby') this.broadcastRoster();
    this._evaluateStaleLobby();
  }

  // Rebind a slot to a new WS after a reconnect handshake. Caller
  // (index.js) has already validated the session token. Returns the
  // payload the client needs to restore its game state, or null if
  // the room is no longer reconnectable (round finalized).
  reconnect(playerId, ws) {
    // Phase 'over' rooms aren't useful to reconnect to — the round is
    // decided, payouts are on chain, there's nothing for the client
    // to render. Caller treats null the same as a stale token.
    if (this.state.phase === 'over') return null;
    const p = this.players.get(playerId);
    if (!p) return null;
    // Last-connect-wins: if the old WS is still alive (e.g., the
    // player opened a second tab), close it so two clients don't
    // fight over the same slot.
    if (p.ws && p.ws !== ws) {
      try { p.ws.close(); } catch (e) {}
    }
    p.ws = ws;
    p.disconnected = false;
    p.disconnectedAt = null;
    if (p.figureId != null) {
      const f = this.state.figs.find(x => x.id === p.figureId);
      // Only re-enable player control if the figure is still alive.
      // A figure that died while disconnected stays dead.
      if (f && f.alive) f.isPlayer = true;
    }
    this._evaluateStaleLobby();
    if (this.state.phase === 'lobby') this.broadcastRoster();
    return {
      code: this.code,
      playerId,
      figureId: p.figureId,
      phase: this.state.phase,
      host: this.host,
      humansAtStart: this.humansAtStart || null,
      mode: this.mode,
    };
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
    // Auto-start is rejected for quickmatch rooms that slipped below
    // 2 humans (e.g., 2nd joiner cancelled during countdown). Disarm
    // the timer so the next addPlayer can re-arm it once we're back
    // at 2+ humans.
    if (this.mode === 'quickmatch' && this.players.size < 2 && reason === 'auto') {
      console.log('[room]', this.code, 'auto-start blocked — only', this.players.size, 'human(s)');
      if (this.autoStartHandle) { clearTimeout(this.autoStartHandle); this.autoStartHandle = null; }
      this.lobbyDeadline = 0;
      this.broadcastRoster();
      return;
    }
    // Quickmatch with a pot: every connected human must have signed
    // their join_pot before the round starts. If anyone hasn't paid
    // by start time (modal closed, signing rejected, etc.), refund
    // the paid players and dissolve the room — otherwise an unpaid
    // player would get a free game and could win the pot.
    if (this.mode === 'quickmatch' && this.escrow) {
      const connected = [...this.players.values()];
      const paid = connected.filter(p => p.paidSig && p.wallet);
      const unpaid = connected.filter(p => !p.paidSig);
      if (unpaid.length > 0) {
        console.log('[room]', this.code, 'start blocked — unpaid players:', unpaid.length,
                    '(paid:', paid.length + ')');
        if (this.autoStartHandle) { clearTimeout(this.autoStartHandle); this.autoStartHandle = null; }
        if (this.staleTimeout) { clearTimeout(this.staleTimeout); this.staleTimeout = null; this.staleRefundAt = null; }
        this.broadcast({ type: 'matchCancelled', reason: 'unpaid_player' });
        if (paid.length > 0 && typeof this.onStaleTimeout === 'function') {
          // Reuse the stale-lobby refund pathway — same end state
          // (paid players refunded + WSs closed + room torn down).
          const wallets = paid.map(p => p.wallet);
          Promise.resolve(this.onStaleTimeout(wallets)).catch(err => {
            console.warn('[room] match-cancelled refund failed', this.code, err.message || err);
          });
        } else {
          // No one paid — just close the room cleanly.
          this.stop();
        }
        return;
      }
    }
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
    if (this.staleTimeout) clearTimeout(this.staleTimeout);
    this.tickHandle = null;
    this.autoStartHandle = null;
    this.staleTimeout = null;
    this.staleRefundAt = null;
  }

  tick() {
    const dt = TICK_MS / 1000;

    // Translate per-player input into figure intent. The sim's
    // tickMovement expects getIntent(f, dt) → [vx, vz]; here we
    // recompute intent for player-bound figures and let bots fall
    // through to botIntent.
    const playerIntent = (f) => {
      const p = [...this.players.values()].find(pp => pp.figureId === f.id);
      // No slot at all → pure bot. Slot exists but player is
      // disconnected → also bot (reconnect can restore control).
      if (!p || p.disconnected) return SIM.botIntent(f, dt, this.state, this.rand);
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

    // End condition: last human standing.
    //   - Multi-human room (humansAtStart >= 2): end when ≤1 humans
    //     alive. Bots that are still alive get cut off — the round
    //     is over the moment human competition is decided.
    //   - Solo room (1 human + bots): end at full last-figure-standing,
    //     either the human survives to the end or dies along the way.
    //   - Practice mode: same as solo — total field reduces to 1.
    const aliveHumans = S.figs.filter(f => f.isPlayer && f.alive).length;
    const shouldEnd = this.humansAtStart >= 2
      ? (aliveHumans <= 1)
      : (S.alive <= SIM.CFG.podiumCount);
    if (shouldEnd) {
      S.phase = 'over';
      // Build top-3 from HUMAN survival order only. Bots that
      // happen to be in the survivor list or top of eliminated[]
      // don't appear on the podium and aren't eligible for payouts.
      const allHumanFigIds = S.figs.filter(f => f.isPlayer).map(f => f.id);
      const eliminatedHumanFigIds = S.eliminated
        .filter(e => allHumanFigIds.includes(e.id))
        .map(e => e.id);
      const survivingHumanFigIds = allHumanFigIds.filter(
        id => !eliminatedHumanFigIds.includes(id)
      );
      // Placement order: surviving humans first, then humans from
      // eliminated[] in reverse (most-recently-eliminated = best
      // placement among the dead). Slice to top 3.
      const humansByPlacement = [
        ...survivingHumanFigIds,
        ...eliminatedHumanFigIds.slice().reverse(),
      ];
      const topFigIds = humansByPlacement.slice(0, 3);

      // Per-figure placement map (1-indexed): used by the client
      // to render "you placed Nth" against humans only.
      const placements = {};
      humansByPlacement.forEach((figId, i) => { placements[figId] = i + 1; });

      // Podium with truncated-address payload for the placement
      // overlay. Bots can't show up here by construction.
      const podium = topFigIds.map(figId => {
        const human = [...this.players.values()].find(p => p.figureId === figId);
        return human
          ? { figId, wallet: human.wallet || null, isBot: false }
          : { figId, wallet: null, isBot: true };
      });

      // Survivors retained for legacy clients (pre-B4) — includes
      // bots that may still be alive on the plate when round ends.
      const survivors = S.figs.filter(f => f.alive).map(f => f.id);
      this.broadcast({
        type: 'end',
        eliminated: S.eliminated,
        survivors,
        podium,
        placements,
        humansAtStart: this.humansAtStart,
      });
      if (typeof this.onRoundEnd === 'function') {
        Promise.resolve(this.onRoundEnd({ eliminated: S.eliminated, topFigIds })).catch(err => {
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
      // Skip disconnected slots — ws is null after disconnect() until
      // a reconnect rebinds. The bot AI is driving their figure in
      // the meantime so they don't need state snapshots.
      if (ws && ws.readyState === 1 /* OPEN */) ws.send(data);
    }
  }
}

module.exports = { GameRoom, MAX_PLAYERS, COUNTDOWN_MS, TICK_MS };
