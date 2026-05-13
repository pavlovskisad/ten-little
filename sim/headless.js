// Headless simulation driver. Composes every sim module into a single
// tick(S, dt) call that advances the world one frame's worth.
//
// The browser still owns its own ticker (it has to interleave with render
// frames and DOM-coupled bits like playerIntent). This module is for:
//   1. Node smoke-testing — prove the sim composes into a real round
//      without any browser context.
//   2. The future Colyseus room — its setInterval handler can just call
//      this.
(function (global) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const SIM = isNode ? Object.assign({},
    require('./cfg.js'),
    require('./state.js'),
    require('./figures.js'),
    require('./hand.js'),
    require('./rng.js'),
  ) : (global.SIM || {});

  // Advance the simulation one step. eliminateFn is called for every
  // figure that just left the round, so the caller can update its
  // elimination-order tracker (and on the client, run hint / overlay
  // side effects). rand is the seeded RNG; defaults to Math.random.
  function tick(S, dt, eliminateFn, rand) {
    if (!rand) rand = Math.random;
    if (S.phase !== 'play') return;

    S.t += dt * 1000;

    // 1. Tilt from current figure positions
    SIM.tickTilt(S, dt);

    // 2. Per-figure movement (bots only here — the headless driver has
    //    no player). The client wraps this with a getIntent that returns
    //    playerIntent for the player figure.
    SIM.tickMovement(S, dt, (f, ddt) => SIM.botIntent(f, ddt, S, rand));

    // 3. Figure-figure collisions + damage
    for (const ev of SIM.tickCollisions(S)) eliminateFn(ev.figure, ev.reason);

    // 4. Edge fall
    for (const ev of SIM.tickEdgeFall(S))   eliminateFn(ev.figure, ev.reason);

    // 5. Plate shrink schedule (ignore the return value — the headless
    //    driver doesn't tween a mesh)
    SIM.maybeShrink(S);

    // 6. Claw cycle
    if (S.hand.phase === 'idle' && S.t >= S.nextHandAt) {
      SIM.startHand(S, rand);
    }
    if (S.hand.phase !== 'idle') {
      S.hand.t += dt * 1000;
      SIM.tickPredatorAim(S, dt);
      for (const transition of SIM.advanceHandPhase(S)) {
        if (transition.from === 'approach' && transition.to === 'hover') {
          const captured = SIM.captureInZone(S);
          for (const f of captured) eliminateFn(f, 'picked');
        }
      }
    }
  }

  // Eliminate driver: shared between client and headless. Pure on S; the
  // client wraps this to also display a hint / defer the end-game overlay.
  function applyEliminate(S, f, reason) {
    if (!f.alive) return;
    f.alive = false;
    S.alive--;
    S.eliminated.push({ id: f.id, isPlayer: !!f.isPlayer, reason, atMs: S.t });
  }

  const api = { tick, applyEliminate };
  if (isNode) module.exports = api;
  else Object.assign((global.SIM = global.SIM || {}), api);
})(typeof self !== 'undefined' ? self : this);
