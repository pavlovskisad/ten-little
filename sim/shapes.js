// Shape catalog for figures (collision + visual). Extracted so the server
// can compute collisions against the same radii the client renders.
//
// Each figure renders as one of these colored geometric primitives (the
// Shape Store look): the client cycles through SHAPE_DEFS and assigns a
// SHAPE_COLORS entry per figure id, so every figure is a distinct
// shape+color combo.
(function (global) {
  const SHAPE_DEFS = [
    { type: 'cube',       collidR: 0.42, yOffset: 0.42 },
    { type: 'sphere',     collidR: 0.45, yOffset: 0.45 },
    { type: 'cone',       collidR: 0.40, yOffset: 0.50 },
    { type: 'cylinder',   collidR: 0.40, yOffset: 0.45 },
    { type: 'octahedron', collidR: 0.45, yOffset: 0.55 },
    { type: 'pyramid',    collidR: 0.42, yOffset: 0.50 },
  ];

  const SHAPE_COLORS = [
    0xff1a1a, 0x1a40e0, 0xffd000, 0x0fb020, 0xff7a10,
    0x9010e0, 0xff2080, 0x00b8ff, 0x70d800, 0xffaa00,
  ];

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SHAPE_DEFS, SHAPE_COLORS };
  } else {
    const SIM = (global.SIM = global.SIM || {});
    SIM.SHAPE_DEFS = SHAPE_DEFS;
    SIM.SHAPE_COLORS = SHAPE_COLORS;
  }
})(typeof self !== 'undefined' ? self : this);
