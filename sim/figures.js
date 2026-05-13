// Figure-level simulation logic. botIntent decides the desired velocity
// for one bot per tick; the client uses it today and the future server
// will run it on every alive bot every tick.
//
// rand is injectable so the server can replay rounds from a seed.
// Defaults to Math.random for the client's current single-player path.
(function (global) {
  const SIM = (typeof module !== 'undefined' && module.exports)
    ? require('./cfg.js')
    : (global.SIM || {});
  const CFG = SIM.CFG;

  function botIntent(f, dt, S, rand) {
    if (!rand) rand = Math.random;
    let dx = 0, dz = 0;

    // Wander: pick a new heading every 1.2–2.7s. The 0.5-weight bias on
    // top of all the other influences keeps bots loosely scattered when
    // nothing else is pulling them.
    f.wanderTimer -= dt;
    if (f.wanderTimer <= 0) {
      f.wanderAng = rand() * Math.PI * 2;
      f.wanderTimer = 1.2 + rand() * 1.5;
    }
    const wanderW = 0.5;
    dx += Math.cos(f.wanderAng) * wanderW;
    dz += Math.sin(f.wanderAng) * wanderW;

    // Flee the claw zone when it's active.
    if (S.hand.phase === 'telegraph' || S.hand.phase === 'approach' || S.hand.phase === 'hover') {
      const ddx = f.x - S.hand.x, ddz = f.z - S.hand.z;
      const d = Math.max(0.01, Math.hypot(ddx, ddz));
      if (d < S.hand.zoneR * 2.6) {
        const urgency = 1 - (d / (S.hand.zoneR * 2.6));
        dx += (ddx / d) * urgency * 1.6;
        dz += (ddz / d) * urgency * 1.6;
      }
    }

    // Pull away from the plate edge.
    const distC = Math.hypot(f.x, f.z);
    const fromEdge = S.plateR - distC;
    if (fromEdge < 1.2) {
      const inward = 1 - Math.max(0, fromEdge / 1.2);
      if (distC > 0.01) {
        dx += (-f.x / distC) * inward * 1.8;
        dz += (-f.z / distC) * inward * 1.8;
      }
    }

    // Counter-tilt: try to stay near the high side of the tilted plate.
    dx += -S.tilt.x * 0.6;
    dz += -S.tilt.z * 0.6;

    // Separate from other figures. Hurt bots push harder so they can break
    // out of scrums when low on HP.
    const sepBoost = 1 + (1 - f.hp / CFG.hpMax) * 1.4;
    for (const g of S.figs) {
      if (g === f || !g.alive || g.picked || g.dropping || g.draining) continue;
      const ddx = f.x - g.x, ddz = f.z - g.z;
      const d2 = ddx * ddx + ddz * ddz;
      const sepR = (f.collidR + g.collidR) * 1.7;
      if (d2 < sepR * sepR && d2 > 0.001) {
        const d = Math.sqrt(d2);
        const w = (sepR - d) / sepR * 0.7 * sepBoost;
        dx += (ddx / d) * w;
        dz += (ddz / d) * w;
      }
    }

    // Bold healthy bots chase weak nearby targets.
    if (f.boldness > 0.45 && f.hp >= 5 && f.invulnT <= 0 &&
        S.hand.phase !== 'telegraph' && S.hand.phase !== 'descend') {
      let best = null, bestScore = -1;
      for (const g of S.figs) {
        if (g === f || !g.alive || g.picked || g.dropping || g.draining) continue;
        const ddx = g.x - f.x, ddz = g.z - f.z;
        const d = Math.hypot(ddx, ddz);
        if (d < 0.8 || d > 4.5) continue;
        const score = (1 / d) + (CFG.hpMax - g.hp) * 0.15;
        if (score > bestScore) { bestScore = score; best = g; }
      }
      if (best) {
        const ddx = best.x - f.x, ddz = best.z - f.z;
        const d = Math.max(0.01, Math.hypot(ddx, ddz));
        const w = (f.boldness - 0.45) * 1.6;
        dx += (ddx / d) * w;
        dz += (ddz / d) * w;
      }
    }

    // Normalize and apply final speed. Flee speed is higher than wander
    // speed so bots have a real chance of escaping the claw zone.
    const len = Math.hypot(dx, dz);
    const fleeing = (S.hand.phase === 'telegraph' || S.hand.phase === 'approach' || S.hand.phase === 'hover');
    const speed = fleeing ? CFG.fleeSpeed : CFG.botSpeed;
    if (len > 0.001) {
      dx = (dx / len) * speed;
      dz = (dz / len) * speed;
    }
    return [dx, dz];
  }

  // Recompute the plate tilt from the centroid of alive figures. Pure — the
  // caller is responsible for translating S.tilt into a mesh rotation.
  function tickTilt(S, dt) {
    let cx = 0, cz = 0, n = 0;
    for (const f of S.figs) {
      if (!f.alive || f.picked || f.dropping) continue;
      cx += f.x; cz += f.z; n++;
    }
    if (n === 0) {
      S.tilt.x = 0; S.tilt.z = 0;
      return;
    }
    cx /= n; cz /= n;
    const tx = Math.max(-1, Math.min(1, cx / S.plateR));
    const tz = Math.max(-1, Math.min(1, cz / S.plateR));
    const k = 1 - Math.exp(-CFG.tiltEase * dt);
    S.tilt.x += (tx - S.tilt.x) * k;
    S.tilt.z += (tz - S.tilt.z) * k;
  }

  // Figure-figure collision, separation, and contact damage exchange.
  //
  // Returns a list of newly-eliminated figures so the caller can run its
  // render side effects (hint text, end-game overlay). The sim itself
  // handles every state mutation that affects future ticks: positions,
  // velocities, hp, invuln timers, draining flag and drainT.
  function tickCollisions(S) {
    const elim = [];
    const figs = S.figs;
    for (let i = 0; i < figs.length; i++) {
      const a = figs[i];
      if (!a.alive || a.picked || a.dropping || a.draining) continue;
      for (let j = i + 1; j < figs.length; j++) {
        const b = figs[j];
        if (!b.alive || b.picked || b.dropping || b.draining) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        const min = a.collidR + b.collidR;
        if (d2 >= min * min || d2 <= 0.0001) continue;
        const d = Math.sqrt(d2);
        const overlap = (min - d) * 0.5;
        const nx = dx / d, nz = dz / d;
        // separate
        a.x -= nx * overlap; a.z -= nz * overlap;
        b.x += nx * overlap; b.z += nz * overlap;
        // exchange a fraction of normal velocity component
        const va = a.vx * nx + a.vz * nz;
        const vb = b.vx * nx + b.vz * nz;
        const exch = (vb - va) * 0.3;
        a.vx += nx * exch; a.vz += nz * exch;
        b.vx -= nx * exch; b.vz -= nz * exch;

        if (a.invulnT <= 0 && b.invulnT <= 0) {
          a.hp -= CFG.contactDmg;
          b.hp -= CFG.contactDmg;
          a.invulnT = CFG.iframeMs / 1000;
          b.invulnT = CFG.iframeMs / 1000;
          // mutual knockback so figures pop apart instead of grinding
          a.vx -= nx * CFG.bumpForce; a.vz -= nz * CFG.bumpForce;
          b.vx += nx * CFG.bumpForce; b.vz += nz * CFG.bumpForce;
          if (a.hp <= 0 && !a.draining) {
            a.draining = true; a.drainT = 0;
            elim.push({ figure: a, reason: 'drained' });
          }
          if (b.hp <= 0 && !b.draining) {
            b.draining = true; b.drainT = 0;
            elim.push({ figure: b, reason: 'drained' });
          }
        }
      }
    }
    return elim;
  }

  const api = { botIntent, tickTilt, tickCollisions };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign((global.SIM = global.SIM || {}), api);
  }
})(typeof self !== 'undefined' ? self : this);
