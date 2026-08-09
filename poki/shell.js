/* ============================================================
   STUDIO SHELL — everything around the game, shared verbatim by
   every title: Poki glue, boot choreography (splash → wordless
   tutorial → menu wake), iOS audio unlock + silent-switch bypass,
   whole-screen joystick, screen shake, wins storage, and the
   boombox + tape mute-switch prop. Pairs with shell.css.

   Load order: three.min.js, vendor loaders, poki-sdk, shell.js,
   then the game scripts. The game calls SHELL.init(config) once.

   SHELL.init(config) — all fields required unless noted:
     storageKey        localStorage key for the wins counter
     legacyStorageKey  optional: old key read as fallback
     bbAssets          { boombox: url, tape: url } GLBs (draco dir
                       is ./vendor/draco/)
     isMenu()          true when the menu screen is current
     isPlaying()       true during a live round
     onBoot()          DOM ready: start loading game audio/assets
     onFirstGesture()  inside the first user gesture (resume ctx)
     isAudioUnlocked() game's AudioContext is running
     onMenuWake()      start the menu music (shell docks the tape)
     onUserMute(m)     boombox tape ejected (true) / docked (false)
     onAdMute(m)       Poki ad break started (true) / ended (false)
     splashParts       array of () => bool readiness probes; the
                       shell adds its own boombox probe. All true
                       (or 12s timeout) drops the splash and sets
                       body.game-ready + fires gameLoadingFinished.

   Globals the shell provides to the game:
     Poki                     guarded SDK wrapper
     INPUT {dx,dy}, pollKeys()        movement input
     showStickAtRest(), hideStick()   joystick visibility
     screenShake(amp, ms), tickShake(now), SHELL.setCameraBase()
     loadWins(), saveWin()
     bbAutoInsertTape()               dock the tape (round start)
     BB                               boombox state (read-only use)

   HTML the shell expects: #splash + #sp-fill, #howto-modal +
   #btn-howto-close, #stick + #stick-knob, #bb-canvas, and the
   game's #menu / #over / #howto-modal containers for touch
   passthrough. See the reference game's index.html.
   ============================================================ */
'use strict';

const SHELL = {
  cfg: null,
  init(cfg) {
    this.cfg = cfg;
    const boot = () => shellBoot();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else boot();
  },
};

// ============================================================
// POKI SDK GLUE — every call is a no-op when the SDK is absent.
// All audio mutes during ads and resumes after.
// ============================================================
const Poki = {
  ready: false,
  init() {
    if (typeof PokiSDK === 'undefined') return Promise.resolve();
    return PokiSDK.init().then(() => { this.ready = true; }).catch(() => {});
  },
  gameLoadingFinished() { if (this.ready) try { PokiSDK.gameLoadingFinished(); } catch (e) {} },
  gameplayStart() { if (this.ready) try { PokiSDK.gameplayStart(); } catch (e) {} },
  gameplayStop() { if (this.ready) try { PokiSDK.gameplayStop(); } catch (e) {} },
  commercialBreak() {
    if (!this.ready) return Promise.resolve();
    SHELL.cfg.onAdMute(true);
    const resume = () => SHELL.cfg.onAdMute(false);
    try { return PokiSDK.commercialBreak().catch(() => {}).then(resume); }
    catch (e) { resume(); return Promise.resolve(); }
  },
};

// ============================================================
// WINS COUNTER — localStorage, with an optional legacy key.
// ============================================================
function loadWins() {
  try {
    return parseInt(localStorage.getItem(SHELL.cfg.storageKey)
      || (SHELL.cfg.legacyStorageKey && localStorage.getItem(SHELL.cfg.legacyStorageKey))
      || '0', 10) || 0;
  }
  catch (e) { return 0; }
}
function saveWin() {
  try { localStorage.setItem(SHELL.cfg.storageKey, String(loadWins() + 1)); }
  catch (e) {}
}

// ============================================================
// SCREEN SHAKE — decaying random camera jitter, restored exactly.
// The game reports its camera + base position from its resize().
// ============================================================
const CAM = { camera: null, baseX: 0, baseY: 14, baseZ: 27, shaken: false };
SHELL.setCameraBase = (camera, x, y, z) => {
  CAM.camera = camera;
  CAM.baseX = x; CAM.baseY = y; CAM.baseZ = z;
};
const SHAKE = { until: 0, dur: 1, amp: 0 };
function screenShake(amp, ms) {
  SHAKE.until = performance.now() + ms;
  SHAKE.dur = ms;
  SHAKE.amp = amp;
}
function tickShake(now) {
  if (!CAM.camera) return;
  if (now < SHAKE.until) {
    const k = (SHAKE.until - now) / SHAKE.dur;
    const a = SHAKE.amp * k * k;
    CAM.camera.position.x = CAM.baseX + (Math.random() * 2 - 1) * a;
    CAM.camera.position.y = CAM.baseY + (Math.random() * 2 - 1) * a;
    CAM.shaken = true;
  } else if (CAM.shaken) {
    CAM.camera.position.x = CAM.baseX;
    CAM.camera.position.y = CAM.baseY;
    CAM.shaken = false;
  }
}

// ============================================================
// INPUT — keyboard + whole-screen virtual joystick. Always visible
// during play at a bottom-right rest (the boombox owns bottom-left).
// ============================================================
const INPUT = { dx: 0, dy: 0 };
const keys = { up: false, left: false, down: false, right: false };
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') keys.up = true;
  if (k === 'a' || k === 'arrowleft') keys.left = true;
  if (k === 's' || k === 'arrowdown') keys.down = true;
  if (k === 'd' || k === 'arrowright') keys.right = true;
  // Poki embeds the game in an iframe; stop arrows/space scrolling.
  if (k.startsWith('arrow') || k === ' ') e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') keys.up = false;
  if (k === 'a' || k === 'arrowleft') keys.left = false;
  if (k === 's' || k === 'arrowdown') keys.down = false;
  if (k === 'd' || k === 'arrowright') keys.right = false;
});
function pollKeys() {
  let ix = 0, iy = 0;
  if (keys.left) ix -= 1;
  if (keys.right) ix += 1;
  if (keys.up) iy -= 1;
  if (keys.down) iy += 1;
  const mag = Math.hypot(ix, iy);
  if (mag > 0) { ix /= mag; iy /= mag; }
  if (!stickActive) { INPUT.dx = ix; INPUT.dy = iy; }
}

let stickActive = false;
let stickStartX = 0, stickStartY = 0;
const stickEl = document.getElementById('stick');
const knobEl = document.getElementById('stick-knob');

function placeStick(cx, cy) {
  const size = stickEl.offsetWidth || 110;
  stickEl.style.left = (cx - size / 2) + 'px';
  stickEl.style.top = (cy - size / 2) + 'px';
  stickEl.style.display = 'block';
}
function showStickAtRest() {
  stickEl.style.display = 'block';
  const size = stickEl.offsetWidth || 110;
  stickEl.style.left = (window.innerWidth - size - 26) + 'px';
  stickEl.style.top = (window.innerHeight - size - 48) + 'px';
  knobEl.style.transform = 'translate(-50%, -50%)';
}
function hideStick() { stickEl.style.display = 'none'; }
window.addEventListener('resize', () => {
  if (SHELL.cfg && SHELL.cfg.isPlaying() && !stickActive) showStickAtRest();
});
function updateStickInput(cx, cy) {
  const dx = cx - stickStartX, dy = cy - stickStartY;
  const maxR = 55;
  const d = Math.hypot(dx, dy);
  const k = Math.min(1, d / maxR);
  if (d > 0.001) {
    const ang = Math.atan2(dy, dx);
    const knobX = Math.cos(ang) * k * (maxR - 22);
    const knobY = Math.sin(ang) * k * (maxR - 22);
    knobEl.style.transform = 'translate(calc(-50% + ' + knobX + 'px), calc(-50% + ' + knobY + 'px))';
    INPUT.dx = Math.cos(ang) * k;
    INPUT.dy = Math.sin(ang) * k;
  }
}
function isUITouch(target) {
  if (!target) return false;
  if (target.tagName === 'BUTTON') return true;
  if (target.closest && (target.closest('#menu') || target.closest('#over') || target.closest('#howto-modal'))) return true;
  return false;
}
document.body.addEventListener('touchstart', (e) => {
  if (!SHELL.cfg || !SHELL.cfg.isPlaying()) return;
  if (isUITouch(e.target)) return;
  // pointerdown fires before touchstart, so a tape grab in the
  // boombox corner is already in progress here; leave it alone.
  if (BB.state === 'dragging' || BB.state === 'rotatingBox') return;
  e.preventDefault();
  const t = e.touches[0];
  stickStartX = t.clientX; stickStartY = t.clientY;
  stickActive = true;
  placeStick(stickStartX, stickStartY);
  updateStickInput(t.clientX, t.clientY);
}, { passive: false });
document.body.addEventListener('touchmove', (e) => {
  if (!stickActive) return;
  e.preventDefault();
  const t = e.touches[0];
  updateStickInput(t.clientX, t.clientY);
}, { passive: false });
function endTouch(e) {
  if (!stickActive) return;
  e.preventDefault();
  stickActive = false;
  INPUT.dx = 0; INPUT.dy = 0;
  if (SHELL.cfg && SHELL.cfg.isPlaying()) showStickAtRest();
  else hideStick();
}
document.body.addEventListener('touchend', endTouch, { passive: false });
document.body.addEventListener('touchcancel', endTouch, { passive: false });

// ============================================================
// BOOMBOX + TAPE — the studio's signature prop and mute switch.
// Drag the tape in to unmute, tap the playing box to eject/mute.
// An eject silences only the current screen; every round start and
// menu wake re-docks (music is default-on).
// ============================================================
// Auto-insert: the tape hops into the deck by itself.
function bbAutoInsertTape() {
  if (BB.state !== 'idle' || !BB.tape || !BB.boombox) return;
  BB.state = 'playing';
  BB.userEjected = false;
  SHELL.cfg.onUserMute(false);
  const lift = new THREE.Vector3(BB.tapeDocked.x + 0.35, BB.tapeDocked.y + 0.85, BB.tapeDocked.z + 0.55);
  startTween(BB.tape.position, lift, 0.32, () => {
    startTween(BB.tape.position, BB.tapeDocked, 0.28, () => { BB.tape.visible = false; });
  });
}

const BB = {
  canvas: null, renderer: null, scene: null, camera: null,
  raycaster: null,
  pointerNDC: { x: 0, y: 0 },
  boombox: null, tape: null,
  tapeHome: new THREE.Vector3(), tapeDocked: new THREE.Vector3(),
  state: 'idle',  // 'idle' | 'dragging' | 'playing' | 'returning' | 'rotatingBox'
  userEjected: false,
  dragPointerId: null,
  dragStartXY: { x: 0, y: 0 },
  dragMoved: false,
  dragPlane: new THREE.Plane(),
  dragGrabOffset: new THREE.Vector3(),
  boxStartRot: { x: 0, y: 0 },
  tween: null,
  bobPhase: 0,
  needsRender: true,
};

function initBoombox() {
  const canvas = document.getElementById('bb-canvas');
  if (!canvas) return;
  if (typeof THREE.GLTFLoader === 'undefined' || typeof THREE.DRACOLoader === 'undefined') {
    console.warn('[bb] GLB loaders missing, boombox disabled');
    return;
  }
  BB.canvas = canvas;

  BB.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  BB.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  resizeBoombox();

  BB.scene = new THREE.Scene();
  BB.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(2, 3, 4);
  BB.scene.add(key);
  const rim = new THREE.DirectionalLight(0xffd9b0, 0.55);
  rim.position.set(-3, 1, -2);
  BB.scene.add(rim);

  BB.camera = new THREE.PerspectiveCamera(28, canvas.clientWidth / canvas.clientHeight, 0.1, 50);
  BB.camera.position.set(0, 0.4, 6.2);
  BB.camera.lookAt(0, 0, 0);

  BB.raycaster = new THREE.Raycaster();

  const loader = new THREE.GLTFLoader();
  const draco = new THREE.DRACOLoader();
  draco.setDecoderPath('./vendor/draco/');
  loader.setDRACOLoader(draco);
  let loadedBoom = null, loadedTape = null;
  const tryArrange = () => {
    if (!loadedBoom || !loadedTape) return;
    arrangeBoomboxScene(loadedBoom, loadedTape);
    document.body.classList.add('bb-grabbable');
    BB.needsRender = true;
  };
  loader.load(SHELL.cfg.bbAssets.boombox, (gltf) => { loadedBoom = gltf.scene; tryArrange(); },
    undefined, (err) => console.warn('[bb] boombox load failed', err));
  loader.load(SHELL.cfg.bbAssets.tape, (gltf) => { loadedTape = gltf.scene; tryArrange(); },
    undefined, (err) => console.warn('[bb] tape load failed', err));

  bindBoomboxPointerEvents();
  window.addEventListener('resize', resizeBoombox);
}

function resizeBoombox() {
  if (!BB.canvas || !BB.renderer) return;
  const w = BB.canvas.clientWidth, h = BB.canvas.clientHeight;
  BB.renderer.setSize(w, h, false);
  if (BB.camera) { BB.camera.aspect = w / h; BB.camera.updateProjectionMatrix(); }
  BB.needsRender = true;
}

function normalizeModel(modelRoot, targetH) {
  const box = new THREE.Box3().setFromObject(modelRoot);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = targetH / maxDim;
  const wrap = new THREE.Group();
  modelRoot.position.sub(center);
  modelRoot.scale.setScalar(scale);
  modelRoot.position.multiplyScalar(scale);
  wrap.add(modelRoot);
  return wrap;
}

function buildOutline(wrapper, color, scaleFactor) {
  const outline = wrapper.children[0].clone(true);
  const materials = [];
  outline.traverse((child) => {
    if (child.isMesh) {
      const mat = new THREE.MeshBasicMaterial({
        color, side: THREE.BackSide,
        transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      child.material = mat;
      materials.push(mat);
    }
  });
  outline.scale.multiplyScalar(scaleFactor);
  outline.userData.outlineMaterials = materials;
  return outline;
}
function setOutlineOpacity(outline, opacity) {
  if (!outline) return;
  for (const mat of outline.userData.outlineMaterials) mat.opacity = opacity;
}

function arrangeBoomboxScene(boomboxGLB, tapeGLB) {
  BB.boombox = normalizeModel(boomboxGLB, 1.6);
  BB.tape    = normalizeModel(tapeGLB, 0.95);
  BB.boombox.position.set(-1.10, -0.23, 0);
  BB.boombox.rotation.y = 0.28;
  BB.tapeHome.set(0.35, -0.13, 0.25);
  BB.tapeDocked.set(-1.10, -0.23, -0.15);
  BB.tape.position.copy(BB.tapeHome);
  BB.tape.rotation.y = -0.18;
  BB.tapeOutline = buildOutline(BB.tape, 0xffcc60, 1.05);
  BB.tape.add(BB.tapeOutline);
  BB.boomboxOutline = buildOutline(BB.boombox, 0xffcc60, 1.04);
  BB.boombox.add(BB.boomboxOutline);
  BB.scene.add(BB.boombox);
  BB.scene.add(BB.tape);
}

function pointerToNDC(clientX, clientY) {
  const rect = BB.canvas.getBoundingClientRect();
  BB.pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  BB.pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
}
function raycastHit(target) {
  if (!target) return null;
  BB.raycaster.setFromCamera(BB.pointerNDC, BB.camera);
  const hits = BB.raycaster.intersectObject(target, true);
  return hits.length ? hits[0] : null;
}
function pointerInsideCanvas(clientX, clientY) {
  const rect = BB.canvas.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top  && clientY <= rect.bottom;
}

function bindBoomboxPointerEvents() {
  document.addEventListener('pointerdown', (e) => {
    if (!BB.boombox || !BB.tape) return;
    if (!pointerInsideCanvas(e.clientX, e.clientY)) return;
    pointerToNDC(e.clientX, e.clientY);

    if (BB.state === 'idle') {
      const hit = raycastHit(BB.tape);
      if (hit) {
        BB.state = 'dragging';
        BB.dragPointerId = e.pointerId;
        BB.dragStartXY = { x: e.clientX, y: e.clientY };
        BB.dragMoved = false;
        const camDir = new THREE.Vector3();
        BB.camera.getWorldDirection(camDir);
        BB.dragPlane.setFromNormalAndCoplanarPoint(camDir, BB.tape.position);
        BB.dragGrabOffset.copy(BB.tape.position).sub(hit.point);
        document.body.classList.add('bb-grabbing');
        e.preventDefault(); e.stopPropagation();
        return;
      }
    }
    if (BB.state === 'playing') {
      const hit = raycastHit(BB.boombox);
      if (hit) {
        BB.dragPointerId = e.pointerId;
        BB.dragStartXY = { x: e.clientX, y: e.clientY };
        BB.dragMoved = false;
        e.preventDefault(); e.stopPropagation();
        return;
      }
    }
    if (BB.state === 'idle') {
      const hit = raycastHit(BB.boombox);
      if (hit) {
        BB.state = 'rotatingBox';
        BB.dragPointerId = e.pointerId;
        BB.dragStartXY = { x: e.clientX, y: e.clientY };
        BB.dragMoved = false;
        BB.boxStartRot.x = BB.boombox.rotation.x;
        BB.boxStartRot.y = BB.boombox.rotation.y;
        document.body.classList.add('bb-grabbing');
        e.preventDefault(); e.stopPropagation();
      }
    }
  }, { capture: true });

  document.addEventListener('pointermove', (e) => {
    if (e.pointerId !== BB.dragPointerId) return;
    if (BB.state === 'dragging') {
      pointerToNDC(e.clientX, e.clientY);
      BB.raycaster.setFromCamera(BB.pointerNDC, BB.camera);
      const hitPoint = new THREE.Vector3();
      if (BB.raycaster.ray.intersectPlane(BB.dragPlane, hitPoint)) {
        hitPoint.add(BB.dragGrabOffset);
        BB.tape.position.copy(hitPoint);
        BB.needsRender = true;
      }
      if (Math.abs(e.clientX - BB.dragStartXY.x) > 4 ||
          Math.abs(e.clientY - BB.dragStartXY.y) > 4) BB.dragMoved = true;
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (BB.state === 'rotatingBox') {
      const dx = e.clientX - BB.dragStartXY.x;
      const dy = e.clientY - BB.dragStartXY.y;
      BB.boombox.rotation.y = BB.boxStartRot.y + dx * 0.01;
      BB.boombox.rotation.x = Math.max(-0.5, Math.min(0.5, BB.boxStartRot.x + dy * 0.01));
      BB.needsRender = true;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) BB.dragMoved = true;
      e.preventDefault(); e.stopPropagation();
    }
  }, { capture: true });

  const finishPointer = (e) => {
    if (e.pointerId !== BB.dragPointerId) return;
    document.body.classList.remove('bb-grabbing');
    if (!BB.dragMoved) {
      if (BB.state === 'playing') {
        pointerToNDC(e.clientX, e.clientY);
        if (raycastHit(BB.boombox)) ejectTape();
      } else if (BB.state === 'dragging' || BB.state === 'rotatingBox') {
        BB.state = 'idle';
      }
      BB.dragPointerId = null;
      return;
    }
    if (BB.state === 'dragging') {
      pointerToNDC(e.clientX, e.clientY);
      const onBox = raycastHit(BB.boombox);
      if (onBox) dockTape(); else returnTapeHome();
    } else if (BB.state === 'rotatingBox') {
      BB.state = 'idle';
    }
    BB.dragPointerId = null;
  };
  document.addEventListener('pointerup', finishPointer, { capture: true });
  document.addEventListener('pointercancel', finishPointer, { capture: true });
}

function dockTape() {
  BB.state = 'playing';
  BB.userEjected = false;
  SHELL.cfg.onUserMute(false);
  startTween(BB.tape.position, BB.tapeDocked, 0.35, () => { BB.tape.visible = false; });
}
function ejectTape() {
  BB.state = 'returning';
  BB.userEjected = true;
  SHELL.cfg.onUserMute(true);
  BB.tape.visible = true;
  const liftPos = new THREE.Vector3(BB.tapeDocked.x, BB.tapeDocked.y + 0.5, BB.tapeDocked.z + 0.4);
  BB.tape.position.copy(liftPos);
  startTween(BB.tape.position, BB.tapeHome, 0.45, () => { BB.state = 'idle'; });
}
function returnTapeHome() {
  BB.state = 'returning';
  startTween(BB.tape.position, BB.tapeHome, 0.35, () => { BB.state = 'idle'; });
}
function startTween(targetVec, dest, dur, onDone) {
  BB.tween = { from: targetVec.clone(), to: dest.clone(), target: targetVec, t: 0, dur, onDone };
}
function stepTween(dt) {
  const tw = BB.tween;
  if (!tw) return;
  tw.t = Math.min(1, tw.t + dt / tw.dur);
  const e = tw.t < 0.5 ? 2 * tw.t * tw.t : 1 - Math.pow(-2 * tw.t + 2, 2) / 2;
  tw.target.lerpVectors(tw.from, tw.to, e);
  BB.needsRender = true;
  if (tw.t >= 1) { const done = tw.onDone; BB.tween = null; if (done) done(); }
}

let bbLastT = performance.now();
function updateBoomboxScene() {
  if (!BB.renderer || !BB.scene || !BB.camera) return;
  const now = performance.now();
  const dt = Math.min(0.05, (now - bbLastT) / 1000);
  bbLastT = now;
  if (BB.tween) stepTween(dt);
  BB.bobPhase += dt * 1.6;
  const tSec = now / 1000;

  if (BB.tape && BB.tape.visible && BB.state === 'idle') {
    BB.tape.position.y = BB.tapeHome.y + Math.sin(BB.bobPhase) * 0.04;
    BB.tape.rotation.y += dt * 0.6;
    BB.tape.rotation.z = Math.sin(BB.bobPhase * 0.7) * 0.05;
    BB.needsRender = true;
  }
  if (BB.boombox && BB.state !== 'rotatingBox') {
    BB.boombox.rotation.y = Math.sin(tSec * 0.4) * (Math.PI / 4);
    BB.boombox.rotation.x *= Math.pow(0.5, dt * 2);
    BB.needsRender = true;
  }
  if (BB.boombox) {
    if (BB.state === 'playing') {
      const beat = tSec * 1.6;
      const phase = beat - Math.floor(beat);
      const downbeat = Math.max(0, Math.cos(phase * Math.PI * 2)) ** 4;
      const offbeat  = Math.max(0, Math.cos((phase - 0.5) * Math.PI * 2)) ** 4;
      const pulse = 1 + 0.04 * downbeat + 0.02 * offbeat;
      BB.boombox.scale.setScalar(pulse);
      BB.needsRender = true;
    } else if (BB.boombox.scale.x !== 1) {
      BB.boombox.scale.setScalar(1);
      BB.needsRender = true;
    }
  }
  if (BB.tapeOutline && BB.boomboxOutline) {
    const pulse = 0.30 + 0.35 * (0.5 + 0.5 * Math.sin(BB.bobPhase * 1.6));
    const tapeOn = (BB.state === 'idle' || BB.state === 'dragging');
    const boxOn  = (BB.state === 'playing' || BB.state === 'rotatingBox');
    setOutlineOpacity(BB.tapeOutline,    tapeOn ? pulse : 0);
    setOutlineOpacity(BB.boomboxOutline, boxOn  ? pulse : 0);
    BB.needsRender = true;
  }
  if (BB.needsRender) {
    BB.renderer.render(BB.scene, BB.camera);
    BB.needsRender = false;
  }
  requestAnimationFrame(updateBoomboxScene);
}

// iOS routes WebAudio through the "ambient" audio session, which
// obeys the ring/silent switch, so the game is mute for anyone with
// the switch flipped (most phones in pockets). Playing a looping
// HTMLMediaElement moves the page's session to "playback", which
// ignores the switch, and WebAudio then sounds too. The element
// plays 0.1s of generated silence forever. Safari 17+ also exposes
// navigator.audioSession for the same thing, set directly.
let silentUnlockEl = null;
function makeSilentWavURL() {
  const sr = 8000, n = 800;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function unlockSilentSwitch() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
  if (silentUnlockEl) return;
  try {
    silentUnlockEl = new Audio(makeSilentWavURL());
    silentUnlockEl.loop = true;
    silentUnlockEl.volume = 0.01;
    silentUnlockEl.setAttribute('playsinline', '');
    silentUnlockEl.setAttribute('webkit-playsinline', '');
    const p = silentUnlockEl.play();
    if (p && p.catch) p.catch(() => { silentUnlockEl = null; });
  } catch (e) { silentUnlockEl = null; }
}
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}

// ============================================================
// BOOT CHOREOGRAPHY — splash gates everything; taps during splash
// or tutorial do only invisible work (audio unlock); the tutorial
// close morphs the button into the mascot and wakes the menu only
// after it clears, so every animation gets its own stage time.
// ============================================================
function howtoShown() {
  const el = document.getElementById('howto-modal');
  return !!(el && el.classList.contains('show'));
}

function wakeMenu() {
  SHELL.cfg.onMenuWake();
  bbAutoInsertTape();
}

function shellBoot() {
  const cfg = SHELL.cfg;
  initBoombox();
  cfg.onBoot();
  requestAnimationFrame(updateBoomboxScene);

  // Audio unlock: iOS only grants activation on touchend/click class
  // events (pointerdown does NOT count), so listen on several and
  // keep retrying every gesture until the context is confirmed
  // running and the silent-switch element took.
  const unlockEvents = ['pointerup', 'touchend', 'click', 'keydown'];
  const tryUnlockAudio = () => {
    unlockSilentSwitch();
    cfg.onFirstGesture();
    if (cfg.isMenu() && document.body.classList.contains('game-ready') && !howtoShown()) {
      wakeMenu();
    }
    if (cfg.isAudioUnlocked() && silentUnlockEl) {
      for (const e of unlockEvents) document.removeEventListener(e, tryUnlockAudio, true);
    }
  };
  for (const e of unlockEvents) document.addEventListener(e, tryUnlockAudio, { capture: true });

  // Tutorial close: spin the button into the mascot, drop the modal,
  // then wake the menu a beat later so the tape flight is seen.
  const closeBtn = document.getElementById('btn-howto-close');
  if (closeBtn) {
    const mascot = closeBtn.dataset.mascot || '\u{1F602}';
    closeBtn.addEventListener('click', () => {
      if (closeBtn.classList.contains('morphing')) return;
      closeBtn.classList.add('morphing');
      setTimeout(() => {
        closeBtn.textContent = mascot;
        closeBtn.classList.add('as-lmao');
      }, 210);
      setTimeout(() => {
        document.getElementById('howto-modal').classList.remove('show');
        closeBtn.classList.remove('morphing', 'as-lmao');
        closeBtn.textContent = '▶';
        if (cfg.isMenu()) setTimeout(wakeMenu, 200);
      }, 640);
    });
  }

  // Splash: real progress over the core assets, then fade to reveal
  // the tutorial. A stuck download never blocks past the timeout.
  const splashEl = document.getElementById('splash');
  const spFill = document.getElementById('sp-fill');
  if (!splashEl) { document.body.classList.add('game-ready'); return; }
  const splashT0 = performance.now();
  const splashTimer = setInterval(() => {
    const parts = [() => !!(BB.boombox && BB.tape)].concat(cfg.splashParts);
    const done = parts.filter((p) => { try { return p(); } catch (e) { return false; } }).length;
    spFill.style.width = Math.round(done / parts.length * 100) + '%';
    const timedOut = performance.now() - splashT0 > 12000;
    if (done < parts.length && !timedOut) return;
    clearInterval(splashTimer);
    document.body.classList.add('game-ready');
    splashEl.classList.add('done');
    setTimeout(() => splashEl.remove(), 600);
    // If a splash-time tap already unlocked audio, wake the menu now
    // unless the tutorial is up; its close handler does the wake.
    if (cfg.isAudioUnlocked() && cfg.isMenu() && !howtoShown()) wakeMenu();
  }, 150);
}
