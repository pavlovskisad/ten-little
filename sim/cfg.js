// Gameplay tuning constants. Extracted from index.html so the future
// game server can share the same numbers without duplicating them. Authored
// as a UMD-ish snippet so it works as a browser <script> (attaches to
// window.SIM) and as a Node module (when the Colyseus server imports it).
(function (global) {
  const CFG = {
    // plate
    plateR0: 7.5,
    plateThick: 0.25,
    shrinkEveryMs: 14000,
    shrinkFactor: 0.93,
    shrinkMin: 3.5,

    // figures (base unit, individual shapes carry their own collidR)
    figR: 0.42,
    figH: 0.85,
    startCount: 10,
    // round runs until one figure remains; placement is decided by
    // elimination order so 3rd/2nd/1st can be distinguished (tiered prizes)
    podiumCount: 1,

    // tilt
    maxTilt: 0.50,
    slideForce: 34,
    friction: 3.2,
    tiltEase: 9,
    edgePadFall: 0.05,

    // movement
    playerSpeed: 4.5,
    botSpeed: 3.6,
    fleeSpeed: 6.2,
    botAccel: 6.0,
    playerAccel: 14.0,

    // claw
    handIdleY: 9.5,
    handGrabY: 0.55,
    handCooldownMs: 2600,
    handTelegraphMs: 1500,
    handApproachMs: 700,
    handHoverMs: 180,
    handPinchMs: 220,
    handLiftMs: 850,
    zoneMinFrac: 0.11,
    zoneMaxFrac: 0.55,

    // contact damage
    hpMax: 10,
    contactDmg: 1,
    iframeMs: 600,
    drainMs: 550,
    bumpForce: 11.0,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CFG };
  } else {
    (global.SIM = global.SIM || {}).CFG = CFG;
  }
})(typeof self !== 'undefined' ? self : this);
