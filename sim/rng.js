// Seeded RNG (mulberry32). When the simulation moves server-side, every
// random decision (spawn jitter, claw target, bot personality) must be
// reproducible from a seed so we can replay or audit rounds. Math.random()
// is fine for purely visual things (sparks, music phase) that stay on the
// client; anything that affects gameplay outcome must use this.
(function (global) {
  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Convenience: random in [a, b)
  function range(rand, a, b) {
    return a + (b - a) * rand();
  }

  // Convenience: pick from array
  function pick(rand, arr) {
    return arr[Math.floor(rand() * arr.length)];
  }

  const api = { mulberry32, range, pick };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign((global.SIM = global.SIM || {}), api);
  }
})(typeof self !== 'undefined' ? self : this);
