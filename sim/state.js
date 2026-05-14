// Game state shape + reset helpers. Pure — no DOM, no THREE. Mirrors what
// the future Colyseus room will hold per game. The client mounts this as
// its local view of the simulation, and once Phase A3 lands the server
// will own the authoritative copy.
(function (global) {
  const SIM = (typeof module !== 'undefined' && module.exports)
    ? require('./cfg.js')
    : (global.SIM || {});
  const CFG = SIM.CFG;

  // Fresh state object. The constants come from sim/cfg.js so callers can
  // mutate state without re-reading CFG.
  function createState() {
    return {
      phase: 'idle',
      t: 0,
      plateR: CFG.plateR0,
      nextShrinkAt: CFG.shrinkEveryMs,
      figs: [],
      player: null,
      alive: 0,
      eliminated: [],
      podium: [],
      hand: { phase: 'idle', t: 0, x: 0, z: 0, zoneR: 0, target: null, captured: [] },
      nextHandAt: 4500,
      firstHand: true,
      tilt: { x: 0, z: 0 },
      input: { dx: 0, dy: 0 },
      startedAt: 0,
      deferredEndGameAt: null,
    };
  }

  // Reset the simulation portion of state in place. Caller is responsible
  // for tearing down any render-side resources (meshes, tweens) tied to
  // the old figures before calling this.
  function resetState(S) {
    S.figs = [];
    S.player = null;
    S.alive = 0;
    S.eliminated = [];
    S.podium = [];
    S.t = 0;
    S.startedAt = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    S.plateR = CFG.plateR0;
    S.nextShrinkAt = CFG.shrinkEveryMs;
    S.nextHandAt = 4500;
    S.deferredEndGameAt = null;
    S.firstHand = true;
    S.hand = { phase: 'idle', t: 0, x: 0, z: 0, zoneR: 0, target: null, captured: [] };
    S.tilt = { x: 0, z: 0 };
    S.input = { dx: 0, dy: 0 };
    S.phase = 'idle';
  }

  const api = { createState, resetState };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign((global.SIM = global.SIM || {}), api);
  }
})(typeof self !== 'undefined' ? self : this);
