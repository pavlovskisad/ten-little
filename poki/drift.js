/* ============================================================
   DRIFT — the plate as an ambient generator/effector.

   This game's music system (per-game identity slot; sibling games
   use the JUNGLE pad sampler). Everything is synthesized in
   WebAudio — no audio files, no decode memory, no formats.

   The mental model: a continuous ambient bed (detuned drone stack +
   sparkle cluster) plays the whole round, and GAMEPLAY is the
   effector rack on top:

     plate tilt      → master lowpass wobble (depth + LFO rate) and
                       stereo pan — the crowd's weight literally
                       turns the filter knob
     player slide    → tremolo depth (fast movement shivers the bed)
     edge closeness  → filter resonance (tension whistle near death)
     crowd scramble  → sparkle-layer brightness
     claw telegraph  → rising shimmer synced to the reticle fill
     claw grab       → downward sweep + bed duck
     any bump        → on-scale pluck into a feedback delay
     death           → one drone voice drops out (bed thins as the
                       plate empties)
     plate shrink    → dropped voices return + the bed deepens
     win             → weird synthesized fanfare (routed around the
                       round-end fade)

   EVERY ROUND ROLLS A NEW PATCH: root key, mode (minor / dorian /
   major / sus), chord voicings, oscillator waveform pair, detune
   spread, sparkle register, wobble character, delay time, chord
   drift pace. Two rounds never sit in the same harmonic world.

   The space: a convolution reverb whose impulse response is
   procedurally generated decaying noise (a free ~3s hall), fed
   post-master so the tail rings out naturally when the round fades.
   Plucks also feed a filtered feedback delay for dub-style echoes.

   Contract with the shell/game (same shape as the JUNGLE module):
     ensure()            build graph early (ctx starts suspended)
     unlock()            resume ctx inside a user gesture
     running()           ctx confirmed running
     ready()             graph built (splash readiness probe)
     start()             menu wake: bed fades up
     stop(fadeSec)       LINEAR master fade (countdown uses 2.7s)
     roundStart()        new patch + bed builds over ~30s
     setMuted(b)         ad-break mute        (composes with user)
     setUserMuted(b)     boombox tape eject   (composes with ads)
     setTilt(tx,tz,mag,speed,edge)  per-frame effector feed
     setCrowd(energy)    mean crowd scramble 0..1
     telegraph(k)        0..1 reticle fill, 0 = off
     pluck(isPlayer) grab() onDeath() thicken() fanfare()
     state()             {chordIdx, dropped, patchName} for visuals

   Scheduler discipline: every audible change is scheduled against
   ctx.currentTime (setTargetAtTime / linearRamp). No Date.now().
   ============================================================ */
'use strict';

const DRIFT = (() => {
  let ctx = null;
  let built = false;

  // Graph nodes
  let master, adGate, userGate;      // master fade → ad mute → user mute → out
  let bedBus, bedFilter, bedPan, tremGain;
  let lfoOsc, lfoGain;               // filter wobble LFO
  let tremOsc, tremDepth;            // tremolo LFO
  let shimmerOsc, shimmerOsc2, shimmerGain, shimmerFilter;  // claw whistle rig
  let shimVibO, shimVibG, shimTremO, shimTremG, shimEcho;
  let whistle = null, lastTeleK = 0;  // per-cycle whistle roll
  let boomIn, boomDelayNode, boomLP, boomFb;  // the deep end
  let sparkleBus;                    // crowd energy scales the air
  let revSend, convolver;            // the hall (post-master send)
  let dreamSend;                     // extra-wet path for melodic events
  let halls = [];                    // pre-generated IRs, rolled per round
  let comp, compTrim;                // master glue compressor + trim
  let eqShelf, softClip;             // de-harsh EQ + warm output saturator
  let delayIn, delayNode, delayFb, delayFilter;  // pluck echoes
  let bedDry, washDelayNode, washFb, washLP, washOut;  // the bed's wash
  const voices = [];                 // drone stack (faint foundation)
  const figVoices = new Map();       // figure id → continuous shape voice
  let sparkles = [];                 // high sine cluster
  let chordTimer = null;
  let chordIdx = 0;
  // THE GRID — a master clock that glues all low-end events. Step =
  // half the patch's delay time, so every delay echo lands exactly ON
  // a grid line. Booms are staged, not fired: they wait for the next
  // step (max ~0.28s) and same-window bumps collapse into one
  // accented hit — a beat, not a machine gun.
  let gridTimer = null;
  let gridLastSlot = -1;
  const staged = { bump: 0, heart: 0, claw: 0 };
  let droppedVoices = 0;
  let userMuted = false, adMuted = false;

  // ============================================================
  // THE PATCH — rolled fresh every round. Chords are semitone
  // offsets from the patch root for the 4 drone voices; pent is the
  // pluck pool. Each mode carries its own harmonic personality.
  // ============================================================
  const MODES = [
    { name: 'nightshade',   // natural minor (the original feel)
      chords: [[0, 7, 12, 16], [-4, 3, 8, 15], [-9, -2, 3, 10], [-2, 5, 10, 14]],
      pent: [12, 15, 17, 19, 22, 24, 27, 29, 31, 34] },
    { name: 'seaglass',     // dorian — minor with a lifted 6th
      chords: [[0, 7, 12, 17], [3, 10, 15, 19], [-2, 5, 10, 14], [5, 12, 17, 21]],
      pent: [12, 15, 17, 19, 21, 24, 27, 29, 31, 33] },
    { name: 'daylight',     // major-ish, lydian color note
      chords: [[0, 7, 12, 16], [5, 12, 16, 21], [-3, 4, 9, 14], [7, 14, 19, 23]],
      pent: [12, 14, 16, 19, 21, 24, 26, 28, 31, 33] },
    { name: 'openwater',    // sus voicings — neither major nor minor
      chords: [[0, 7, 12, 14], [-2, 5, 12, 17], [3, 10, 14, 19], [-4, 3, 10, 15]],
      pent: [12, 14, 17, 19, 22, 24, 26, 29, 31, 34] },
  ];
  const WAVE_PAIRS = [
    ['sawtooth', 'triangle'],
    ['triangle', 'sine'],
    ['sawtooth', 'sine'],
    ['triangle', 'triangle'],
  ];
  const DELAY_TIMES = [0.31, 0.42, 0.5, 0.56];

  let patch = null;
  function rollPatch() {
    const mode = MODES[Math.floor(Math.random() * MODES.length)];
    // rotate the chord cycle so even a repeated mode starts elsewhere
    const rot = Math.floor(Math.random() * mode.chords.length);
    const chords = mode.chords.slice(rot).concat(mode.chords.slice(0, rot));
    patch = {
      name: mode.name,
      root: 110 * Math.pow(2, (Math.floor(Math.random() * 12) - 5) / 12),
      chords,
      pent: mode.pent,
      waves: WAVE_PAIRS[Math.floor(Math.random() * WAVE_PAIRS.length)],
      detune: 4 + Math.random() * 8,            // cents of spread
      sawGain: 0.25 + Math.random() * 0.18,     // how present the edgier osc is
      sparkleOct: Math.random() < 0.5 ? 0 : 12, // sparkle register
      lfoBase: 0.3 + Math.random() * 0.3,       // wobble at rest
      delayTime: DELAY_TIMES[Math.floor(Math.random() * DELAY_TIMES.length)],
      driftMs: 12000 + Math.random() * 10000,   // chord change pace
      pluckWave: Math.random() < 0.6 ? 'triangle' : 'sine',
      // ARRANGEMENT — the round's texture architecture, not just its
      // harmony. 'drone' = full sustained bed (the original feel);
      // 'pulse' = foundation cut back, every crowd voice gated by its
      // own slow LFO (polyrhythmic swells); 'sparse' = foundation
      // nearly silent, melody + beat carry a minimal round.
      arr: ['drone', 'pulse', 'pulse', 'sparse'][Math.floor(Math.random() * 4)],
      // grid feel: straight or lightly swung, rolled per round
      swing: Math.random() < 0.4 ? 0 : 0.10 + Math.random() * 0.12,
      bedMul: 1,          // resolved from arr in applyPatch
      hallIdx: Math.floor(Math.random() * 3),   // room / hall / wash
      filterType: Math.random() < 0.3 ? 'bandpass' : 'lowpass',
    };
    patch.bedMul = patch.arr === 'drone' ? 1 : patch.arr === 'pulse' ? 0.45 : 0.15;
    chordIdx = 0;
    return patch;
  }

  const semiHz = (s) => patch.root * Math.pow(2, s / 12);

  // ============================================================
  // SHAPE INSTRUMENTS — timbre derived from geometry. A waveform's
  // shape decides its harmonics, and our figures ARE waveform
  // shapes: the cube is a square wave (hard edges, odd harmonics),
  // the cone is a sawtooth (its silhouette is literally a ramp),
  // the cylinder is a triangle (a tube: soft odd harmonics), the
  // sphere is a pure sine (no edges, no harmonics), the pyramid a
  // heavily damped saw, the octahedron a sparse glassy bell.
  // Each also gets its own envelope: spheres bloom, cubes knock,
  // octahedra ring.
  //   harmonics: sine-series amplitudes for createPeriodicWave
  //   attack/decay in seconds, gain trims the recipes to equal
  //   loudness, bright scales the per-pluck lowpass
  // ============================================================
  const SHAPE_TIMBRES = {
    cube:       { harmonics: [1, 0, 0.33, 0, 0.2, 0, 0.14], attack: 0.006, decay: 0.35, gain: 0.85, bright: 0.9 },
    sphere:     { harmonics: [1],                            attack: 0.030, decay: 0.70, gain: 1.30, bright: 0.7 },
    cone:       { harmonics: [1, 0.5, 0.33, 0.25, 0.2, 0.17], attack: 0.005, decay: 0.45, gain: 0.75, bright: 1.08 },
    cylinder:   { harmonics: [1, 0, 0.11, 0, 0.04],          attack: 0.015, decay: 0.55, gain: 1.10, bright: 0.85 },
    pyramid:    { harmonics: [1, 0.25, 0.11, 0.06, 0.04],    attack: 0.010, decay: 0.30, gain: 0.95, bright: 0.75 },
    octahedron: { harmonics: [1, 0, 0, 0.5, 0, 0, 0.33, 0, 0, 0.2], attack: 0.004, decay: 0.95, gain: 0.80, bright: 1.02 },
  };
  const waveCache = new Map();
  function shapeWave(type) {
    const t = SHAPE_TIMBRES[type] ? type : 'sphere';
    let w = waveCache.get(t);
    if (!w) {
      const h = SHAPE_TIMBRES[t].harmonics;
      const real = new Float32Array(h.length + 1);
      const imag = new Float32Array(h.length + 1);
      for (let i = 0; i < h.length; i++) imag[i + 1] = h[i];
      w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
      waveCache.set(t, w);
    }
    return w;
  }
  function shapeTimbre(type) {
    return SHAPE_TIMBRES[type] || SHAPE_TIMBRES.sphere;
  }

  // One voice of a shape's instrument: its wave, its envelope, its
  // brightness, at a given note — panned, echoed, in the hall.
  function shapeVoice(type, semi, peak, r, pan, t) {
    const tim = shapeTimbre(type);
    const o = ctx.createOscillator();
    o.setPeriodicWave(shapeWave(type));
    o.frequency.value = semiHz(semi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = (750 + r * 1750) * tim.bright;
    const g = ctx.createGain();
    // rounder onset than the raw shape envelope: dreamier, less percussive
    const atk = tim.attack * 2.2;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak * tim.gain, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0008, t + atk + tim.decay);
    let tail = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      tail = p;
    }
    o.connect(f); f.connect(g);
    tail.connect(master);
    tail.connect(delayIn);
    tail.connect(dreamSend);
    o.start(t); o.stop(t + atk + tim.decay + 0.1);
  }

  // Retune the live graph into the current patch. Glides, no clicks.
  function applyPatch() {
    if (!built) return;
    const t = ctx.currentTime;
    const chord = patch.chords[0];
    voices.forEach((v, i) => {
      v.oA.type = patch.waves[0];
      v.oB.type = patch.waves[1];
      v.oA.detune.setTargetAtTime(-patch.detune, t, 0.5);
      v.oB.detune.setTargetAtTime(patch.detune * 1.15, t, 0.5);
      v.oAG.gain.setTargetAtTime(patch.sawGain, t, 0.5);
      v.oA.frequency.setTargetAtTime(semiHz(chord[i]), t, 1.2);
      v.oB.frequency.setTargetAtTime(semiHz(chord[i]), t, 1.5);
    });
    for (let i = 0; i < sparkles.length; i++) {
      const semi = 24 + patch.sparkleOct + i * 7;
      sparkles[i].o.frequency.setTargetAtTime(
        semiHz(semi) * (1 + Math.random() * 0.01), t, 1.0);
    }
    lfoOsc.frequency.setTargetAtTime(patch.lfoBase, t, 0.5);
    delayNode.delayTime.setTargetAtTime(patch.delayTime, t, 0.3);
    boomDelayNode.delayTime.setTargetAtTime(patch.delayTime * 1.5, t, 0.3);
    boomFb.gain.setTargetAtTime(0.55 + Math.random() * 0.11, t, 0.3);
    washDelayNode.delayTime.setTargetAtTime(patch.delayTime * 1.35, t, 0.4);
    washFb.gain.setTargetAtTime(0.44 + Math.random() * 0.13, t, 0.4);
    // texture architecture: scale the drone foundation by arrangement,
    // swap the room, swap the master filter's character
    for (const v of voices) {
      v.base = v.baseCore * patch.bedMul;
      if (!v.dropped) v.g.gain.setTargetAtTime(v.base, t, 0.8);
    }
    convolver.buffer = halls[patch.hallIdx];
    bedFilter.type = patch.filterType;
    const fchord = patch.chords[0];
    for (const fv of figVoices.values()) {
      fv.o.frequency.setTargetAtTime(semiHz(fchord[fv.deg] + fv.oct), t, 1.2);
    }
  }

  function ensure() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { return; }
    buildGraph();
  }

  // A hall from nothing: stereo exponentially-decaying noise. The
  // classic free-reverb trick — at ambient settings it is
  // indistinguishable from a sampled IR and costs zero bytes.
  function makeImpulse(seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const k = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - k, decay);
      }
    }
    return buf;
  }

  function buildGraph() {
    if (built || !ctx) return;
    const t = ctx.currentTime;
    rollPatch();

    userGate = ctx.createGain(); userGate.gain.value = 1;
    adGate = ctx.createGain(); adGate.gain.value = 1;
    master = ctx.createGain(); master.gain.value = 0;
    userGate.connect(ctx.destination);
    adGate.connect(userGate);
    // Master glue: a gentle bus compressor between everything and the
    // output. Sustained drones stack up → the compressor pushes the
    // whole bed down; a pluck or chime lands → it still punches
    // through the reduced bed. This is what keeps long drone lines
    // from dominating even when the pressure math makes them loud.
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -26;
    comp.knee.value = 24;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.012;
    comp.release.value = 0.32;
    // De-harsh EQ: one broad high-shelf cut takes the sizzle off
    // every layer at once — synthesized waveforms pile up energy
    // above ~4kHz that real instruments don't have.
    eqShelf = ctx.createBiquadFilter();
    eqShelf.type = 'highshelf';
    eqShelf.frequency.value = 3600;
    eqShelf.gain.value = -8;
    // Warm output saturator: a gentle tanh soft-clip. Anything that
    // still peaks rounds off like tape instead of digitally clipping.
    softClip = ctx.createWaveShaper();
    {
      const n = 1024;
      const curve = new Float32Array(n);
      const drive = 1.4;
      const norm = Math.tanh(drive);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * drive) / norm;
      }
      softClip.curve = curve;
      softClip.oversample = '2x';
    }
    compTrim = ctx.createGain(); compTrim.gain.value = 0.62;
    comp.connect(eqShelf);
    eqShelf.connect(compTrim);
    compTrim.connect(softClip);
    softClip.connect(adGate);
    master.connect(comp);

    // The hall: post-master send so the master fade also silences the
    // reverb FEED while the tail rings out naturally through adGate.
    revSend = ctx.createGain(); revSend.gain.value = 0.42;
    convolver = ctx.createConvolver();
    // three rooms, rolled per round: tight / hall / huge wash
    halls = [makeImpulse(1.2, 3.2), makeImpulse(2.9, 2.6), makeImpulse(4.6, 2.1)];
    convolver.buffer = halls[patch.hallIdx];
    master.connect(revSend);
    revSend.connect(convolver);
    convolver.connect(comp);
    // melodic events (bumps, chimes, farewells) take this extra-wet
    // path on top of their reduced dry level: distance IS the
    // wet/dry ratio, so they sing from the back of the room
    dreamSend = ctx.createGain();
    dreamSend.gain.value = 0.72;
    dreamSend.connect(convolver);

    // Pluck echo: filtered feedback delay. Echoes obey the master
    // fade and pick up the hall on the way through.
    delayIn = ctx.createGain(); delayIn.gain.value = 0.55;
    delayNode = ctx.createDelay(1.0);
    delayNode.delayTime.value = patch.delayTime;
    delayFb = ctx.createGain(); delayFb.gain.value = 0.34;
    delayFilter = ctx.createBiquadFilter();
    delayFilter.type = 'lowpass';
    delayFilter.frequency.value = 1350;
    delayIn.connect(delayNode);
    delayNode.connect(delayFilter);
    delayFilter.connect(delayFb);
    delayFb.connect(delayNode);
    delayFilter.connect(master);

    // Bed chain: voices → bedBus → tremolo → filter → pan → master
    bedBus = ctx.createGain(); bedBus.gain.value = 0.9;
    tremGain = ctx.createGain(); tremGain.gain.value = 1;
    bedFilter = ctx.createBiquadFilter();
    bedFilter.type = 'lowpass';
    bedFilter.frequency.value = 900;
    bedFilter.Q.value = 1.2;
    bedPan = (ctx.createStereoPanner) ? ctx.createStereoPanner() : ctx.createGain();
    bedBus.connect(tremGain);
    tremGain.connect(bedFilter);
    bedFilter.connect(bedPan);
    // THE WASH — the crowd bed reaches the mix mostly through a slow
    // lowpassed feedback delay: you hear the smeared, wavy TAIL of
    // the engine, not the engine itself. A faint dry path keeps just
    // enough presence to anchor it. (Distance + blur in one move.)
    bedDry = ctx.createGain();
    bedDry.gain.value = 0.32;
    bedPan.connect(bedDry);
    bedDry.connect(master);
    washDelayNode = ctx.createDelay(2.0);
    washDelayNode.delayTime.value = 0.58;
    washLP = ctx.createBiquadFilter();
    washLP.type = 'lowpass';
    washLP.frequency.value = 850;
    washFb = ctx.createGain(); washFb.gain.value = 0.5;
    washOut = ctx.createGain(); washOut.gain.value = 0.85;
    bedPan.connect(washDelayNode);
    washDelayNode.connect(washLP);
    washLP.connect(washFb);
    washFb.connect(washDelayNode);
    washLP.connect(washOut);
    washOut.connect(master);

    // Filter wobble LFO — rate + depth driven by tilt
    lfoOsc = ctx.createOscillator();
    lfoOsc.type = 'sine';
    lfoOsc.frequency.value = patch.lfoBase;
    lfoGain = ctx.createGain();
    lfoGain.gain.value = 0;
    lfoOsc.connect(lfoGain);
    lfoGain.connect(bedFilter.frequency);
    lfoOsc.start(t);

    // Tremolo LFO — depth driven by player slide speed
    tremOsc = ctx.createOscillator();
    tremOsc.type = 'sine';
    tremOsc.frequency.value = 5;
    tremDepth = ctx.createGain();
    tremDepth.gain.value = 0;
    tremOsc.connect(tremDepth);
    tremDepth.connect(tremGain.gain);
    tremOsc.start(t);

    // Drone voices: two detuned oscillators each, per-voice gain.
    // Each voice also breathes on its own slow cycle (scheduleBreath)
    // so the bed evolves instead of holding a static organ chord.
    const chord = patch.chords[0];
    for (let i = 0; i < 4; i++) {
      const g = ctx.createGain();
      // Faint foundation only — the per-figure voices carry the
      // texture; the drones just glue the harmony underneath.
      g.gain.value = [0.085, 0.06, 0.04, 0.03][i];
      const oA = ctx.createOscillator();
      const oB = ctx.createOscillator();
      oA.type = patch.waves[0]; oB.type = patch.waves[1];
      oA.frequency.value = semiHz(chord[i]);
      oB.frequency.value = semiHz(chord[i]);
      oA.detune.value = -patch.detune;
      oB.detune.value = patch.detune * 1.15;
      const oAG = ctx.createGain(); oAG.gain.value = patch.sawGain;
      oA.connect(oAG); oAG.connect(g);
      oB.connect(g);
      g.connect(bedBus);
      oA.start(t); oB.start(t);
      const v = { oA, oB, oAG, g, baseCore: g.gain.value, base: g.gain.value, dropped: false };
      voices.push(v);
      scheduleBreath(v, i);
    }

    // Warm sub under the root voice — one quiet sine an octave down.
    // Follows voice 0's retunes via the same chord updates (driftChord
    // + applyPatch set it too).
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = semiHz(chord[0]) / 2;
    const subG = ctx.createGain(); subG.gain.value = 0.07;
    sub.connect(subG); subG.connect(bedBus);
    sub.start(t);
    voices.sub = sub;

    // Sparkle cluster: three quiet high sines with slow independent
    // drift — reads as air, not melody. All routed through sparkleBus
    // so the crowd's total scramble can brighten the air as one knob.
    sparkleBus = ctx.createGain();
    sparkleBus.gain.value = 0.7;
    sparkleBus.connect(bedFilter);
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = semiHz(24 + patch.sparkleOct + i * 7) * (1 + Math.random() * 0.01);
      const g = ctx.createGain();
      g.gain.value = 0.0;
      o.connect(g); g.connect(sparkleBus);
      o.start(t);
      sparkles.push({ o, g, phase: Math.random() * Math.PI * 2 });
      scheduleSparkle(sparkles[i], i);
    }

    // CLAW WHISTLE RIG — main + detuned partner osc through a
    // bandpass formant into the mix, with vibrato + gating-tremolo
    // LFOs and an optional echo send. Every telegraph cycle rolls a
    // fresh whistle character (rollWhistle), so no two claw
    // approaches sing the same.
    shimmerOsc = ctx.createOscillator();
    shimmerOsc.type = 'sine';
    shimmerOsc.frequency.value = 400;
    shimmerOsc2 = ctx.createOscillator();
    shimmerOsc2.type = 'sine';
    shimmerOsc2.frequency.value = 400;
    shimmerOsc2.detune.value = 12;
    shimmerFilter = ctx.createBiquadFilter();
    shimmerFilter.type = 'bandpass';
    shimmerFilter.frequency.value = 700;
    shimmerFilter.Q.value = 2;
    shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0;
    shimVibO = ctx.createOscillator();
    shimVibO.frequency.value = 5;
    shimVibG = ctx.createGain(); shimVibG.gain.value = 0;
    shimVibO.connect(shimVibG);
    shimVibG.connect(shimmerOsc.frequency);
    shimVibG.connect(shimmerOsc2.frequency);
    shimTremO = ctx.createOscillator();
    shimTremO.frequency.value = 6;
    shimTremG = ctx.createGain(); shimTremG.gain.value = 0;
    shimTremO.connect(shimTremG);
    shimTremG.connect(shimmerGain.gain);
    shimEcho = ctx.createGain(); shimEcho.gain.value = 0;
    shimmerOsc.connect(shimmerFilter);
    shimmerOsc2.connect(shimmerFilter);
    shimmerFilter.connect(shimmerGain);
    shimmerGain.connect(master);
    shimmerGain.connect(shimEcho);
    shimEcho.connect(delayIn);
    shimmerOsc.start(t); shimmerOsc2.start(t);
    shimVibO.start(t); shimTremO.start(t);

    // THE DEEP END — sub-bass booms land in their own feedback delay
    // so one hit becomes a decaying pulse train: an emergent beat.
    // The loop is lowpassed at 240Hz so the repeats stay pure sub.
    boomIn = ctx.createGain(); boomIn.gain.value = 1;
    boomDelayNode = ctx.createDelay(2.0);
    boomDelayNode.delayTime.value = 0.63;
    boomLP = ctx.createBiquadFilter();
    boomLP.type = 'lowpass';
    boomLP.frequency.value = 400;
    boomFb = ctx.createGain(); boomFb.gain.value = 0.60;
    boomIn.connect(boomDelayNode);
    boomDelayNode.connect(boomLP);
    boomLP.connect(boomFb);
    boomFb.connect(boomDelayNode);
    boomLP.connect(master);

    built = true;
    startGrid();
  }

  // ============================================================
  // FIGURE VOICES — the crowd IS the ambient. Every alive figure
  // holds a continuous chord tone in its own geometric timbre.
  // The game feeds per-frame "pressure" (heavy-side alignment +
  // local crowd density + slide speed) and each voice swells and
  // recedes with it: ten layers, evolving forever, never the same
  // because the crowd never stands the same. A death silences its
  // voice for good.
  // ============================================================
  function registerFigures(list) {
    if (!built) return;
    const t = ctx.currentTime;
    // clear previous round's voices
    for (const fv of figVoices.values()) {
      try {
        fv.g.gain.setTargetAtTime(0, t, 0.1);
        fv.o.stop(t + 0.8);
        if (fv.gate) fv.gate.stop(t + 0.8);
      } catch (e) {}
    }
    figVoices.clear();
    const chord = patch.chords[chordIdx % patch.chords.length];
    list.forEach((fig, idx) => {
      const deg = idx % 4;
      const oct = idx < 4 ? 0 : (idx < 8 ? 12 : 24);
      const tim = shapeTimbre(fig.type);
      const o = ctx.createOscillator();
      o.setPeriodicWave(shapeWave(fig.type));
      o.frequency.value = semiHz(chord[deg] + oct);
      o.detune.value = (Math.random() - 0.5) * 10;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(bedBus);
      o.start(t);
      const fv = {
        o, g, deg, oct,
        // higher registers whisper, low ones ground; per-shape trim
        base: (oct === 0 ? 0.030 : oct === 12 ? 0.019 : 0.010) * tim.gain,
        gate: null, gateG: null,
      };
      // 'pulse' rounds: every crowd voice breathes through its own
      // slow gate — ten independent rates = polyrhythmic swells
      // instead of a wall of sustain.
      if (patch.arr === 'pulse') {
        const gate = ctx.createOscillator();
        gate.type = 'sine';
        gate.frequency.value = 0.15 + Math.random() * 0.5;
        const gateG = ctx.createGain();
        gateG.gain.value = fv.base * 0.65;
        gate.connect(gateG);
        gateG.connect(g.gain);
        gate.start(t);
        fv.gate = gate; fv.gateG = gateG;
      }
      if (patch.arr === 'sparse') fv.base *= 0.6;
      figVoices.set(fig.id, fv);
    });
  }

  // Per-frame: pressure 0..~1.8 per figure id.
  function setFigures(states) {
    if (!built || !running()) return;
    const t = ctx.currentTime;
    for (const s of states) {
      const fv = figVoices.get(s.id);
      if (fv) fv.g.gain.setTargetAtTime(fv.base * s.gain, t, 0.22);
    }
  }

  function figureGone(id) {
    if (!built) return;
    const fv = figVoices.get(id);
    if (!fv) return;
    const t = ctx.currentTime;
    fv.g.gain.setTargetAtTime(0, t, 0.9);
    if (fv.gateG) fv.gateG.gain.setTargetAtTime(0, t, 0.5);
    try { fv.o.stop(t + 4); if (fv.gate) fv.gate.stop(t + 4); } catch (e) {}
    figVoices.delete(id);
  }

  // Each drone voice slowly wanders around its base level — the bed
  // becomes a living texture instead of a held chord.
  function scheduleBreath(v, i) {
    const cycle = () => {
      if (!ctx) return;
      if (!v.dropped) {
        const t = ctx.currentTime;
        const target = v.base * (0.65 + Math.random() * 0.7);
        const glide = 3 + Math.random() * 5;
        v.g.gain.setTargetAtTime(target, t, glide / 3);
      }
      setTimeout(cycle, 6000 + Math.random() * 6000);
    };
    setTimeout(cycle, i * 2100 + Math.random() * 1500);
  }

  // Sparkle voices breathe on their own slow randomized cycles.
  function scheduleSparkle(s, i) {
    const cycle = () => {
      if (!ctx) return;
      const t = ctx.currentTime;
      const peak = 0.008 + Math.random() * 0.014;
      const rise = 2 + Math.random() * 3;
      const fall = 3 + Math.random() * 4;
      s.g.gain.cancelScheduledValues(t);
      s.g.gain.setValueAtTime(s.g.gain.value, t);
      s.g.gain.linearRampToValueAtTime(peak, t + rise);
      s.g.gain.linearRampToValueAtTime(0.001, t + rise + fall);
      // occasionally re-pitch within the scale
      if (Math.random() < 0.4) {
        const semi = patch.pent[Math.floor(Math.random() * patch.pent.length)] + 12 + patch.sparkleOct;
        s.o.frequency.setTargetAtTime(semiHz(semi), t, 1.5);
      }
      setTimeout(cycle, (rise + fall) * 1000 + Math.random() * 2000);
    };
    setTimeout(cycle, i * 1800 + Math.random() * 1000);
  }

  // Slow chord drift: glide all voices to the next chord.
  function driftChord() {
    if (!ctx || !built) return;
    chordIdx = (chordIdx + 1) % patch.chords.length;
    const chord = patch.chords[chordIdx];
    const t = ctx.currentTime;
    voices.forEach((v, i) => {
      v.oA.frequency.setTargetAtTime(semiHz(chord[i]), t, 1.8);
      v.oB.frequency.setTargetAtTime(semiHz(chord[i]), t, 2.2);
    });
    if (voices.sub) voices.sub.frequency.setTargetAtTime(semiHz(chord[0]) / 2, t, 2.0);
    for (const fv of figVoices.values()) {
      fv.o.frequency.setTargetAtTime(semiHz(chord[fv.deg] + fv.oct), t, 1.9 + Math.random() * 0.6);
    }
  }
  function startChordDrift() {
    stopChordDrift();
    chordTimer = setInterval(driftChord, patch.driftMs);
  }
  function stopChordDrift() {
    if (chordTimer) { clearInterval(chordTimer); chordTimer = null; }
  }

  // ---- public control ----
  function unlock() {
    ensure();
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }
  function running() { return !!(ctx && ctx.state === 'running'); }
  function ready() { return built; }

  function start() {
    ensure();
    if (!built) return;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(0.68, t + 0.8);
    startChordDrift();
  }

  function stop(fadeSec) {
    if (!built) return;
    const t = ctx.currentTime;
    const dur = Math.max(0.05, fadeSec || 0.4);
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    // LINEAR fade — silence lands exactly at t+dur (countdown timing)
    master.gain.linearRampToValueAtTime(0, t + dur);
    if (dur > 1) stopChordDrift();
  }

  function roundStart() {
    ensure();
    if (!built) return;
    // NEW WORLD: every round rolls its own key, mode, waveforms,
    // detune, sparkle register, delay time, drift pace.
    rollPatch();
    applyPatch();
    staged.bump = 0; staged.heart = 0; staged.claw = 0;
    gridLastSlot = -1;
    const t = ctx.currentTime;
    // Restore any voices lost to deaths last round.
    for (const v of voices) {
      v.dropped = false;
      v.g.gain.setTargetAtTime(v.base, t, 0.5);
    }
    droppedVoices = 0;
    // Bed starts quiet and builds over ~30s — the round grows its own
    // intensity instead of starting at full menu loudness.
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.linearRampToValueAtTime(0.14, t + 0.5);
    master.gain.linearRampToValueAtTime(0.28, t + 3);
    master.gain.linearRampToValueAtTime(0.68, t + 30);
    startChordDrift();
  }

  function setMuted(m) {
    adMuted = m;
    if (!built) return;
    adGate.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.05);
  }
  function setUserMuted(m) {
    userMuted = m;
    if (!built) return;
    userGate.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.05);
  }

  // ---- effector feed (per frame) ----
  function setTilt(tx, tz, mag, speed, edge) {
    if (!built || !running()) return;
    const t = ctx.currentTime;
    // Filter: base cutoff opens with tilt; LFO wobbles it deeper +
    // faster as the plate leans. Tau 0.12 keeps it smooth per-frame.
    const cutoff = 600 + mag * 1650;
    bedFilter.frequency.setTargetAtTime(cutoff, t, 0.12);
    lfoGain.gain.setTargetAtTime(mag * 850, t, 0.15);
    lfoOsc.frequency.setTargetAtTime(patch.lfoBase + mag * 5.5, t, 0.2);
    // Resonance: tension whistle as the player nears the edge.
    bedFilter.Q.setTargetAtTime(1.1 + edge * 3.0, t, 0.2);
    // Pan follows tilt direction (gently).
    if (bedPan.pan) bedPan.pan.setTargetAtTime(Math.max(-0.7, Math.min(0.7, tx * 0.7)), t, 0.25);
    // Tremolo deepens with slide speed.
    tremDepth.gain.setTargetAtTime(speed * 0.45, t, 0.15);
    tremOsc.frequency.setTargetAtTime(4 + speed * 5, t, 0.2);
  }

  // Crowd energy (0..1): how hard the whole field is scrambling.
  // Fed per-frame; brightens the sparkle layer so a panicking plate
  // audibly glitters even when the bed itself sits low.
  function setCrowd(energy) {
    if (!built || !running()) return;
    sparkleBus.gain.setTargetAtTime(0.45 + energy * 0.85, ctx.currentTime, 0.25);
  }

  // Roll a fresh whistle character at the start of each claw cycle:
  // waveform, sweep range, vibrato, gating, formant color, dynamics
  // curve, echo. Tone AND dynamics land differently every time.
  function rollWhistle() {
    const t = ctx.currentTime;
    whistle = {
      f0: 180 + Math.random() * 380,          // where the rise starts
      span: 500 + Math.random() * 1500,       // how far it climbs
      formant: 0.9 + Math.random() * 1.4,     // bandpass vs pitch ratio
      peak: 0.005 + Math.random() * 0.017,    // whispered ↔ prominent
      curve: 0.6 + Math.random() * 1.3,       // swell shape (k^curve)
    };
    shimmerOsc.type = Math.random() < 0.6 ? 'sine' : 'triangle';
    shimmerOsc2.type = shimmerOsc.type;
    // partner voice: off / tight / wide-beat detune
    shimmerOsc2.detune.setValueAtTime(
      Math.random() < 0.35 ? 0 : 6 + Math.random() * 22, t);
    shimVibO.frequency.setValueAtTime(3 + Math.random() * 6, t);
    shimVibG.gain.setValueAtTime(Math.random() < 0.3 ? 0 : 5 + Math.random() * 30, t);
    shimTremO.frequency.setValueAtTime(3 + Math.random() * 8, t);
    shimTremG.gain.setValueAtTime(Math.random() < 0.4 ? 0 : whistle.peak * (0.3 + Math.random() * 0.4), t);
    shimmerFilter.Q.setValueAtTime(0.8 + Math.random() * 9, t);
    shimEcho.gain.setValueAtTime(Math.random() < 0.3 ? 0.4 : 0, t);
  }

  function telegraph(k) {
    if (!built || !running()) return;
    const t = ctx.currentTime;
    if (k <= 0) {
      if (lastTeleK > 0) shimmerGain.gain.setTargetAtTime(0, t, 0.1);
      lastTeleK = 0;
      return;
    }
    if (lastTeleK <= 0) rollWhistle();
    lastTeleK = k;
    const w = whistle;
    const freq = w.f0 + k * w.span;
    shimmerOsc.frequency.setTargetAtTime(freq, t, 0.08);
    shimmerOsc2.frequency.setTargetAtTime(freq, t, 0.09);
    shimmerFilter.frequency.setTargetAtTime(freq * w.formant, t, 0.09);
    shimmerGain.gain.setTargetAtTime(0.004 + w.peak * Math.pow(k, w.curve), t, 0.08);
  }

  // A boom from the deep end. Depth and presence are rolled per hit:
  // sometimes ~35Hz and barely there (felt, not heard), sometimes
  // higher and present. Some hits echo into the beat delay, some
  // land once and vanish. A faint 2nd harmonic keeps a trace of each
  // boom alive on phone speakers.
  function boom(kind, at, accent) {
    if (!built || !running()) return;
    const t = Math.max(ctx.currentTime, at || ctx.currentTime);
    // Warm and deep: low fundamentals, rounded attack, gentle sine
    // tap instead of a hard knock, long decays.
    const depth = 36 + Math.random() * 24;                  // fundamental Hz
    const peak = (kind === 'heart' ? 0.26 + Math.random() * 0.18
               : kind === 'claw' ? 0.06 + Math.random() * 0.05
               : 0.06 + Math.random() * 0.08) * (accent || 1);  // bump
    const decay = kind === 'heart' ? 0.38 + Math.random() * 0.30
                                   : 0.22 + Math.random() * 0.25;
    // body: pitch-dropping sine, soft bloom instead of a snap
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(depth * 2.0, t);
    o.frequency.exponentialRampToValueAtTime(depth, t + 0.07 + Math.random() * 0.06);
    // tap: rounded sine sweep, quiet — warmth, not click
    const k = ctx.createOscillator();
    k.type = 'sine';
    k.frequency.setValueAtTime(170 + Math.random() * 90, t);
    k.frequency.exponentialRampToValueAtTime(depth * 1.4, t + 0.05);
    const kG = ctx.createGain();
    kG.gain.setValueAtTime(peak * 0.4, t);
    kG.gain.exponentialRampToValueAtTime(0.0008, t + 0.12);
    // harmonic: keeps a trace of the sub alive on phone speakers
    const h = ctx.createOscillator();
    h.type = 'sine';
    h.frequency.value = depth * 2;
    const hG = ctx.createGain(); hG.gain.value = 0.40;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.016);
    g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
    o.connect(g);
    h.connect(hG); hG.connect(g);
    k.connect(kG); kG.connect(master);
    g.connect(master);
    // THE HEARTBEAT: catching a life is the downbeat. Heart booms
    // always enter the beat delay at full send — one pickup rolls a
    // long decaying pulse train. Bumps sprinkle in sometimes; the
    // claw's touchdown thud stays out of the sequence.
    if (kind === 'heart' || (kind === 'bump' && Math.random() < 0.35)) {
      const send = ctx.createGain();
      send.gain.value = kind === 'heart' ? 0.85 : 0.4 + Math.random() * 0.3;
      g.connect(send);
      send.connect(boomIn);
    }
    // SIDECHAIN: the heartbeat pumps the whole bed down and lets it
    // swell back — this is what makes the beat FELT, not just heard.
    if (kind === 'heart') {
      bedBus.gain.cancelScheduledValues(t);
      bedBus.gain.setValueAtTime(bedBus.gain.value, t);
      bedBus.gain.linearRampToValueAtTime(0.40, t + 0.04);
      bedBus.gain.setTargetAtTime(0.9, t + 0.20, 0.30);
    }
    o.start(t); o.stop(t + decay + 0.1);
    h.start(t); h.stop(t + decay + 0.1);
    k.start(t); k.stop(t + 0.15);
  }

  // ---- staging: events queue for the next grid step ----
  function stage(kind) { staged[kind] = (staged[kind] || 0) + 1; }

  function startGrid() {
    if (gridTimer) return;
    // 30ms tick with ~0.16s lookahead against ctx.currentTime — the
    // sampler-scheduler discipline: musical time never touches
    // wall-clock time.
    gridTimer = setInterval(() => {
      if (!built || !running() || !patch) return;
      if (!staged.bump && !staged.heart && !staged.claw) return;
      const step = patch.delayTime / 2;
      const now = ctx.currentTime;
      const slot = Math.floor((now + 0.16) / step);
      if (slot <= gridLastSlot) return;
      let tFire = slot * step;
      // light swing: odd steps land late by swing*step
      if (patch.swing && (slot % 2 === 1)) tFire += patch.swing * step;
      if (tFire <= now) return;   // wait for a slot still in the future
      gridLastSlot = slot;
      if (staged.heart > 0) {
        boom('heart', tFire);
        staged.heart = 0;
      }
      if (staged.bump > 0) {
        // same-window bumps collapse into ONE accented hit
        boom('bump', tFire, 1 + 0.35 * (Math.min(staged.bump, 3) - 1));
        staged.bump = 0;
      }
      if (staged.claw > 0) {
        boom('claw', tFire);
        staged.claw = 0;
      }
    }, 30);
  }

  // The claw touching down joins the grid like everything else.
  function clawLand(caught) {
    stage('claw');
  }

  // ---- events ----
  // The plate is a NOTE MAP. nx/nz are the bump position normalized
  // to the plate radius (-1..1):
  //   angle around the plate → which scale degree plays (the same
  //     spot always sings the same note — the crowd's positions
  //     literally write the tune)
  //   distance from centre   → register + brightness (deep and
  //     mellow at the middle, an octave up and bright at the rim)
  //   left/right             → stereo pan
  function spatialNote(nx, nz) {
    const ang = Math.atan2(nz, nx) + Math.PI;   // 0..2π
    const r = Math.min(1, Math.hypot(nx, nz));
    const idx = Math.floor((ang / (Math.PI * 2)) * patch.pent.length) % patch.pent.length;
    const oct = r > 0.68 ? 12 : (r < 0.32 ? -12 : 0);
    return { semi: patch.pent[idx] + oct, r, pan: Math.max(-0.8, Math.min(0.8, nx * 0.8)) };
  }

  // A bump is a DUET: each colliding shape speaks its own instrument.
  // Shape A takes the mapped note; shape B harmonizes two scale steps
  // up. Same spot still sings the same pitch — now in the voices of
  // whoever collided there.
  function pluck(isPlayer, nx, nz, shapeA, shapeB) {
    if (!patch) return 12;
    let semi, r = 0.5, pan = 0;
    if (nx !== undefined && nz !== undefined) {
      const sn = spatialNote(nx, nz);
      semi = sn.semi; r = sn.r; pan = sn.pan;
    } else {
      semi = patch.pent[Math.floor(Math.random() * patch.pent.length)];
    }
    if (!built || !running()) return semi;
    const t = ctx.currentTime;
    const peak = isPlayer ? 0.065 : 0.032;
    stage('bump');
    shapeVoice(shapeA || 'sphere', semi, peak, r, pan, t);
    if (shapeB) {
      // harmony: two scale steps up, a hair later, slightly softer,
      // nudged to the other side of the stereo field
      const base = ((semi % 12) + 12) % 12;
      let idx = patch.pent.findIndex(s => (((s % 12) + 12) % 12) === base);
      if (idx < 0) idx = 0;
      const harm = patch.pent[(idx + 2) % patch.pent.length]
        + (semi >= 24 ? 12 : semi < 12 ? -12 : 0);
      shapeVoice(shapeB, harm, peak * 0.7, r, -pan * 0.5, t + 0.03);
    }
    return semi;
  }

  // A dying shape sings its note falling an octave in its own voice.
  function farewell(type, nx, nz) {
    if (!built || !running() || !patch) return;
    const sn = spatialNote(nx || 0, nz || 0);
    const t = ctx.currentTime;
    const tim = shapeTimbre(type);
    const o = ctx.createOscillator();
    o.setPeriodicWave(shapeWave(type));
    o.frequency.setValueAtTime(semiHz(sn.semi), t);
    o.frequency.exponentialRampToValueAtTime(semiHz(sn.semi - 12), t + 0.8);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1800 * tim.bright, t);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.055 * tim.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.85);
    let tail = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = sn.pan;
      g.connect(p);
      tail = p;
    }
    o.connect(f); f.connect(g);
    tail.connect(master);
    tail.connect(delayIn);
    tail.connect(dreamSend);
    o.start(t); o.stop(t + 0.9);
  }

  // Heart pickup: a sweet two-note ascending chime from the same
  // note map, so even healing is part of the tune.
  function pickup(nx, nz) {
    if (!built || !running()) return;
    stage('heart');
    const sn = spatialNote(nx || 0, nz || 0);
    const t0 = ctx.currentTime;
    const idx = patch.pent.indexOf(sn.semi > 12 ? sn.semi - 12 : (sn.semi < 0 ? sn.semi + 12 : sn.semi));
    const second = patch.pent[(Math.max(0, idx) + 2) % patch.pent.length] + 12;
    [[sn.semi, 0], [second, 0.10]].forEach(([semi, dt]) => {
      const t = t0 + dt;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = semiHz(semi + 12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.055, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.55);
      let tail = g;
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = sn.pan;
        g.connect(p);
        tail = p;
      }
      o.connect(g);
      tail.connect(master);
      tail.connect(delayIn);
      tail.connect(dreamSend);
      o.start(t); o.stop(t + 0.6);
    });
  }

  function grab() {
    if (!built || !running()) return;
    const t = ctx.currentTime;
    // Downward sweep
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(110, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.055, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1600;
    o.connect(f); f.connect(g);
    g.connect(master);
    g.connect(delayIn);
    o.start(t); o.stop(t + 0.6);
    // Duck the bed for a beat
    bedBus.gain.setTargetAtTime(0.45, t, 0.05);
    bedBus.gain.setTargetAtTime(0.9, t + 0.35, 0.3);
  }

  function onDeath() {
    if (!built || !running()) return;
    // Thin the bed: drop the highest still-playing color voice.
    // Root + fifth always survive so the bed never fully dies.
    for (let i = voices.length - 1; i >= 2; i--) {
      if (!voices[i].dropped) {
        voices[i].dropped = true;
        droppedVoices++;
        voices[i].g.gain.setTargetAtTime(0.001, ctx.currentTime, 1.2);
        break;
      }
    }
  }

  function thicken() {
    if (!built || !running()) return;
    const t = ctx.currentTime;
    // The plate shrank: bring one dropped voice back and lean the
    // whole bed darker + wobblier — difficulty rises, the room leans in.
    for (const v of voices) {
      if (v.dropped) {
        v.dropped = false;
        droppedVoices--;
        v.g.gain.setTargetAtTime(v.base, t, 1.0);
        break;
      }
    }
    // brief swell
    bedBus.gain.setTargetAtTime(1.15, t, 0.3);
    bedBus.gain.setTargetAtTime(0.9, t + 1.2, 0.8);
  }

  // Win fanfare — deliberately weird per the playbook, and a
  // different recipe from the sibling game: six AM-buzzed triangle
  // blips climbing a not-quite-whole-tone row, a 7Hz-gated detuning
  // triad smear, and an upward tape-spin. Routed around `master`
  // (straight into adGate) so the round-end fade can't kill it; a
  // separate send drops it into the hall so it sits in the same room.
  function fanfare() {
    if (!built || !running()) return;
    const t0 = ctx.currentTime + 0.05;
    const out = ctx.createGain();
    out.gain.value = 0.55;
    out.connect(comp);
    const fanRev = ctx.createGain();
    fanRev.gain.value = 0.35;
    out.connect(fanRev);
    fanRev.connect(convolver);

    // 1. climbing AM blips (not-quite-whole-tone: +2.3 semis each)
    for (let i = 0; i < 6; i++) {
      const t = t0 + i * 0.09;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 330 * Math.pow(2, (i * 2.3) / 12);
      const am = ctx.createOscillator();
      am.type = 'square';
      am.frequency.value = 33 + i * 4;
      const amG = ctx.createGain(); amG.gain.value = 0.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      am.connect(amG); amG.connect(g.gain);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + 0.25);
      am.start(t); am.stop(t + 0.25);
    }

    // 2. gated triad smear: three triangles sliding 0.96→1.05 of
    //    pitch under a 7Hz square gate, ~1.1s
    const gateT = t0 + 0.6;
    const gate = ctx.createGain(); gate.gain.value = 0;
    gate.connect(out);
    const gateLfo = ctx.createOscillator();
    gateLfo.type = 'square'; gateLfo.frequency.value = 7;
    const gateDepth = ctx.createGain(); gateDepth.gain.value = 0.05;
    gateLfo.connect(gateDepth); gateDepth.connect(gate.gain);
    gate.gain.setValueAtTime(0.05, gateT);
    gate.gain.setValueAtTime(0.0, gateT + 1.1);
    for (const semi of [0, 4, 7]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      const f = semiHz(semi + 24);
      o.frequency.setValueAtTime(f * 0.96, gateT);
      o.frequency.linearRampToValueAtTime(f * 1.05, gateT + 1.1);
      o.connect(gate);
      o.start(gateT); o.stop(gateT + 1.15);
    }
    gateLfo.start(gateT); gateLfo.stop(gateT + 1.15);

    // 3. upward tape-spin with wobble: 70→1100 Hz over 0.9s
    const spinT = t0 + 1.15;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, spinT);
    o.frequency.exponentialRampToValueAtTime(1100, spinT + 0.9);
    const wob = ctx.createOscillator();
    wob.type = 'sine'; wob.frequency.value = 11;
    const wobG = ctx.createGain(); wobG.gain.value = 30;
    wob.connect(wobG); wobG.connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.10, spinT);
    g.gain.exponentialRampToValueAtTime(0.001, spinT + 1.0);
    o.connect(g); g.connect(out);
    o.start(spinT); o.stop(spinT + 1.05);
    wob.start(spinT); wob.stop(spinT + 1.05);
  }

  // Read-only snapshot for the visual layer (Kaoss pad surface):
  // which chord the bed is on, how thinned the drone stack is, and
  // which patch/world this round rolled.
  function state() {
    return {
      chordIdx,
      dropped: droppedVoices,
      patchName: patch ? patch.name : '',
      arr: patch ? patch.arr : '',
    };
  }

  return {
    ensure, unlock, running, ready, state,
    start, stop, roundStart,
    setMuted, setUserMuted,
    setTilt, setCrowd, telegraph,
    registerFigures, setFigures, figureGone,
    pluck, pickup, farewell, grab, clawLand, onDeath, thicken, fanfare,
  };
})();
