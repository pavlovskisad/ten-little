// Math helpers used by both the simulation and the client. Pure, no deps.
(function (global) {
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  // Squared horizontal distance between two figures (or two points on the
  // plate). Faster than Math.hypot when you only need to compare distances.
  function dist2(ax, az, bx, bz) {
    const dx = ax - bx, dz = az - bz;
    return dx * dx + dz * dz;
  }

  const api = { lerp, clamp, clamp01, dist2 };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign((global.SIM = global.SIM || {}), api);
  }
})(typeof self !== 'undefined' ? self : this);
