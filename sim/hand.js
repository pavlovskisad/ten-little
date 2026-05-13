// Claw simulation. Owns target selection, per-cycle duration randomization,
// and (in later commits) the predator auto-aim drift + state machine
// progression. All mesh-side animation stays on the client.
(function (global) {
  const SIM = (typeof module !== 'undefined' && module.exports)
    ? require('./cfg.js')
    : (global.SIM || {});
  const figuresMod = (typeof module !== 'undefined' && module.exports)
    ? require('./figures.js')
    : (global.SIM || {});
  const CFG = SIM.CFG;
  const currentZoneR = figuresMod.currentZoneR;

  // Kick off a new claw cycle. Picks a target, randomizes per-cycle
  // durations, writes everything into S.hand so updateHand and the
  // bot-flee logic can react. Returns the chosen target or null if no
  // eligible figures (caller should reschedule itself).
  //
  // rand defaults to Math.random for the client's current single-player
  // path. The server will pass a seeded RNG so claw choices are replayable.
  function startHand(S, rand) {
    if (!rand) rand = Math.random;
    const aliveFigs = S.figs.filter(f => f.alive && !f.picked && !f.dropping);
    if (aliveFigs.length === 0) return null;
    const zoneR = currentZoneR(S);
    S.hand.zoneR = zoneR;

    let target;
    if (S.firstHand) {
      // First grab of the round: pick the figure with the densest
      // neighborhood so the opening pick reads as predatory rather than
      // arbitrary.
      let best = null, bestN = -1;
      for (const a of aliveFigs) {
        let n = 0;
        for (const b of aliveFigs) {
          if (a === b) continue;
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d < zoneR * 2.2) n++;
        }
        if (n > bestN) { bestN = n; best = a; }
      }
      target = best;
      S.firstHand = false;
    } else {
      // Subsequent grabs: weighted random favoring figures with crowded
      // neighborhoods (collateral damage potential).
      const weights = aliveFigs.map(a => {
        let n = 0;
        for (const b of aliveFigs) {
          if (a === b) continue;
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d < zoneR * 2) n++;
        }
        return 1 + n * 1.5;
      });
      const total = weights.reduce((s, w) => s + w, 0);
      let r = rand() * total;
      target = aliveFigs[aliveFigs.length - 1];
      for (let i = 0; i < aliveFigs.length; i++) {
        r -= weights[i];
        if (r <= 0) { target = aliveFigs[i]; break; }
      }
    }

    S.hand.target = target;
    S.hand.x = target.x;
    S.hand.z = target.z;
    S.hand.origX = target.x;
    S.hand.origZ = target.z;
    S.hand.aimTarget = null;
    S.hand.phase = 'telegraph';
    S.hand.t = 0;

    // Randomized per-cycle durations so consecutive grabs don't feel
    // identical. Long telegraph reads as hunting; short reads as a snap
    // strike.
    S.hand.telegraphMs = 700 + (3300 - 700) * rand();
    S.hand.cooldownMs  = CFG.handCooldownMs * (0.70 + rand() * 0.60);
    S.hand.approachMs  = CFG.handApproachMs * (0.80 + rand() * 0.45);
    S.hand.hoverMs     = CFG.handHoverMs    * (0.55 + rand() * 0.90);
    S.hand.pinchMs     = CFG.handPinchMs    * (0.85 + rand() * 0.40);
    S.hand.liftMs      = CFG.handLiftMs     * (0.90 + rand() * 0.25);
    S.hand.approachArc = 1.0 + rand() * 0.8;
    S.hand.liftArc     = 0.8 + rand() * 0.7;
    S.hand.approachEaseMix = rand();
    S.hand.hoverDriftAmp = rand() * 0.06;
    S.hand.hoverDriftPhase = rand() * Math.PI * 2;
    // Mid-pinch test-grip plateau: the claw hesitates briefly before
    // committing to the close.
    S.hand.holdStart = 0.36 + rand() * 0.10;
    S.hand.holdEnd   = S.hand.holdStart + 0.10 + rand() * 0.10;
    S.hand.holdLevel = 0.62 + rand() * 0.16;
    S.hand.azimuth   = rand() * Math.PI * 2;

    return target;
  }

  const api = { startHand };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign((global.SIM = global.SIM || {}), api);
  }
})(typeof self !== 'undefined' ? self : this);
