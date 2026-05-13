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

  // Predator auto-aim drift. Active during telegraph + approach: scores every
  // alive figure on closeness to the original telegraph spot, current speed,
  // and whether the figure is running INTO the origin (approach trajectory).
  // The hand position smoothly chases the highest-scoring figure, capped at
  // a fraction of plate radius so the reticle can't teleport across the plate.
  //
  // Returns silently; mutates S.hand.x and S.hand.z. The caller is
  // responsible for syncing the reticle mesh to the new position.
  function tickPredatorAim(S, dt) {
    if (S.hand.phase !== 'telegraph' && S.hand.phase !== 'approach') return;

    let progress;
    if (S.hand.phase === 'telegraph') {
      const tp = Math.min(1, S.hand.t / S.hand.telegraphMs);
      progress = tp * 0.40;
    } else {
      const ap = Math.min(1, S.hand.t / S.hand.approachMs);
      progress = 0.40 + ap * 0.60;
    }

    const driftProgress = Math.pow(progress, 1.8);
    const respProgress  = Math.pow(progress, 1.5);

    const scanR = Math.max(S.plateR * 0.55, S.hand.zoneR * 3.0);
    const maxDrift = S.plateR * 0.07 + (S.plateR * 0.26 - S.plateR * 0.07) * driftProgress;

    const moveBias   = 0.4 + (1.5 - 0.4) * driftProgress;
    const closenessW = 1.0 + (0.5 - 1.0) * driftProgress;

    let bestScore = -Infinity, bestX = S.hand.origX, bestZ = S.hand.origZ;
    for (const f of S.figs) {
      if (!f.alive || f.picked || f.dropping || f.draining) continue;
      const dx = f.x - S.hand.origX;
      const dz = f.z - S.hand.origZ;
      const d = Math.hypot(dx, dz);
      if (d > scanR) continue;

      const speed = Math.hypot(f.vx, f.vz);
      const closeness = 1 - d / scanR;

      let approachDot = 0;
      if (d > 0.1 && speed > 0.3) {
        approachDot = -(f.vx * dx + f.vz * dz) / (speed * d);
        approachDot = Math.max(0, approachDot);
      }

      const score = closeness * closenessW
                  + (speed * 0.28) * moveBias
                  + (approachDot * speed * 0.15) * moveBias;
      if (score > bestScore) {
        bestScore = score;
        bestX = f.x;
        bestZ = f.z;
      }
    }

    let desX = S.hand.origX, desZ = S.hand.origZ;
    if (bestScore > -Infinity) {
      const dx = bestX - S.hand.origX;
      const dz = bestZ - S.hand.origZ;
      const d = Math.hypot(dx, dz);
      if (d > 0.001) {
        const driftMag = Math.min(d, maxDrift);
        desX = S.hand.origX + (dx / d) * driftMag;
        desZ = S.hand.origZ + (dz / d) * driftMag;
      }
    }

    const respRate = 1.3 + (6.0 - 1.3) * respProgress;
    const respK = 1 - Math.exp(-respRate * dt);
    S.hand.x += (desX - S.hand.x) * respK;
    S.hand.z += (desZ - S.hand.z) * respK;
  }

  // Identify all alive figures whose horizontal position falls inside
  // the current capture zone, flip their picked state, and stamp pickT=0
  // so the lift animation can begin. Returns the captured list so the
  // caller can run mesh-detach and call eliminate() per figure.
  function captureInZone(S) {
    const captured = [];
    for (const f of S.figs) {
      if (!f.alive || f.picked || f.dropping || f.draining) continue;
      const d = Math.hypot(f.x - S.hand.x, f.z - S.hand.z);
      if (d < S.hand.zoneR) captured.push(f);
    }
    for (const f of captured) {
      f.picked = true;
      f.pickT = 0;
    }
    S.hand.captured = captured;
    return captured;
  }

  const api = { startHand, tickPredatorAim, captureInZone };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign((global.SIM = global.SIM || {}), api);
  }
})(typeof self !== 'undefined' ? self : this);
