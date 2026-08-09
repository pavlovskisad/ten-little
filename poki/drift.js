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
     claw telegraph  → rising shimmer synced to the reticle fill
     claw grab       → downward sweep + bed duck
     any bump        → on-scale pluck (louder when the player is in it)
     death           → one drone voice drops out (bed thins as the
                       plate empties)
     plate shrink    → dropped voices return + the bed deepens
     win             → weird synthesized fanfare (routed around the
                       round-end fade)

   Contract with the shell/game (same shape as the JUNGLE module):
     ensure()            build graph early (ctx starts suspended)
     unlock()            resume ctx inside a user gesture
     running()           ctx confirmed running
     ready()             graph built (splash readiness probe)
     start()             menu wake: bed fades up
     stop(fadeSec)       LINEAR master fade (countdown uses 2.7s)
     roundStart()        round bed: starts low, builds over ~30s
     setMuted(b)         ad-break mute        (composes with user)
     setUserMuted(b)     boombox tape eject   (composes with ads)
     setTilt(tx,tz,mag,speed,edge)  per-frame effector feed
     telegraph(k)        0..1 reticle fill, 0 = off
     pluck(isPlayer) grab() onDeath() thicken() fanfare()

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
  let shimmerOsc, shimmerGain;       // claw telegraph riser
  let sparkleBus;                    // crowd energy scales the air
  const voices = [];                 // drone stack
  let sparkles = [];                 // high sine cluster
  let chordTimer = null;
  let chordIdx = 0;
  let droppedVoices = 0;
  let userMuted = false, adMuted = false;

  // A minor, ambient voicings. Each chord = semitone offsets from A2
  // (110 Hz) for the 4 drone voices (root, fifth, octave, color).
  const CHORDS = [
    [0, 7, 12, 16],    // Am(add9)-ish
    [-4, 3, 8, 15],    // Fmaj7-ish
    [-9, -2, 3, 10],   // C-ish
    [-2, 5, 10, 14],   // G-ish
  ];
  const ROOT_HZ = 110;
  // Pentatonic pool for plucks (A minor pent, two octaves up)
  const PLUCK_SEMIS = [12, 15, 17, 19, 22, 24, 27, 29, 31, 34];

  const semiHz = (s) => ROOT_HZ * Math.pow(2, s / 12);

  function ensure() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { return; }
    buildGraph();
  }

  function buildGraph() {
    if (built || !ctx) return;
    const t = ctx.currentTime;

    userGate = ctx.createGain(); userGate.gain.value = 1;
    adGate = ctx.createGain(); adGate.gain.value = 1;
    master = ctx.createGain(); master.gain.value = 0;
    userGate.connect(ctx.destination);
    adGate.connect(userGate);
    master.connect(adGate);

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
    bedPan.connect(master);

    // Filter wobble LFO — rate + depth driven by tilt
    lfoOsc = ctx.createOscillator();
    lfoOsc.type = 'sine';
    lfoOsc.frequency.value = 0.4;
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

    // Drone voices: two detuned oscillators each, per-voice gain
    const chord = CHORDS[0];
    for (let i = 0; i < 4; i++) {
      const g = ctx.createGain();
      g.gain.value = [0.16, 0.12, 0.09, 0.06][i];
      const oA = ctx.createOscillator();
      const oB = ctx.createOscillator();
      oA.type = 'sawtooth'; oB.type = 'triangle';
      oA.frequency.value = semiHz(chord[i]);
      oB.frequency.value = semiHz(chord[i]);
      oA.detune.value = -6; oB.detune.value = 7;
      const oAG = ctx.createGain(); oAG.gain.value = 0.35;
      oA.connect(oAG); oAG.connect(g);
      oB.connect(g);
      g.connect(bedBus);
      oA.start(t); oB.start(t);
      voices.push({ oA, oB, g, base: g.gain.value, dropped: false });
    }

    // Sparkle cluster: three quiet high sines with slow independent
    // drift — reads as air, not melody. All routed through sparkleBus
    // so the crowd's total scramble can brighten the air as one knob.
    sparkleBus = ctx.createGain();
    sparkleBus.gain.value = 0.7;
    sparkleBus.connect(bedFilter);
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = semiHz(24 + i * 7) * (1 + Math.random() * 0.01);
      const g = ctx.createGain();
      g.gain.value = 0.0;
      o.connect(g); g.connect(sparkleBus);
      o.start(t);
      sparkles.push({ o, g, phase: Math.random() * Math.PI * 2 });
      scheduleSparkle(sparkles[i], i);
    }

    // Claw telegraph shimmer: dedicated riser voice, silent until fed
    shimmerOsc = ctx.createOscillator();
    shimmerOsc.type = 'sine';
    shimmerOsc.frequency.value = 400;
    shimmerGain = ctx.createGain();
    shimmerGain.gain.value = 0;
    shimmerOsc.connect(shimmerGain);
    shimmerGain.connect(master);
    shimmerOsc.start(t);

    built = true;
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
        const semi = PLUCK_SEMIS[Math.floor(Math.random() * PLUCK_SEMIS.length)] + 12;
        s.o.frequency.setTargetAtTime(semiHz(semi), t, 1.5);
      }
      setTimeout(cycle, (rise + fall) * 1000 + Math.random() * 2000);
    };
    setTimeout(cycle, i * 1800 + Math.random() * 1000);
  }

  // Slow chord drift: glide all voices to the next chord.
  function driftChord() {
    if (!ctx || !built) return;
    chordIdx = (chordIdx + 1) % CHORDS.length;
    const chord = CHORDS[chordIdx];
    const t = ctx.currentTime;
    voices.forEach((v, i) => {
      v.oA.frequency.setTargetAtTime(semiHz(chord[i]), t, 1.8);
      v.oB.frequency.setTargetAtTime(semiHz(chord[i]), t, 2.2);
    });
  }
  function startChordDrift() {
    stopChordDrift();
    chordTimer = setInterval(driftChord, 14000 + Math.random() * 6000);
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
    master.gain.linearRampToValueAtTime(0.85, t + 0.8);
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
    // Restore any voices lost to deaths last round.
    const t = ctx.currentTime;
    for (const v of voices) {
      v.dropped = false;
      v.g.gain.setTargetAtTime(v.base, t, 0.5);
    }
    droppedVoices = 0;
    // Bed starts quiet and builds over ~30s — the round grows its own
    // intensity instead of starting at full menu loudness.
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(0, t);
    master.gain.linearRampToValueAtTime(0.30, t + 2);
    master.gain.linearRampToValueAtTime(0.85, t + 30);
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
    const cutoff = 650 + mag * 2400;
    bedFilter.frequency.setTargetAtTime(cutoff, t, 0.12);
    lfoGain.gain.setTargetAtTime(mag * 850, t, 0.15);
    lfoOsc.frequency.setTargetAtTime(0.4 + mag * 5.5, t, 0.2);
    // Resonance: tension whistle as the player nears the edge.
    bedFilter.Q.setTargetAtTime(1.2 + edge * 9, t, 0.2);
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
    sparkleBus.gain.setTargetAtTime(0.6 + energy * 1.8, ctx.currentTime, 0.25);
  }

  function telegraph(k) {
    if (!built || !running()) return;
    const t = ctx.currentTime;
    if (k <= 0) {
      shimmerGain.gain.setTargetAtTime(0, t, 0.1);
      return;
    }
    shimmerOsc.frequency.setTargetAtTime(400 + k * 1500, t, 0.08);
    shimmerGain.gain.setTargetAtTime(0.010 + k * 0.050, t, 0.08);
  }

  // ---- events ----
  function pluck(isPlayer) {
    const semi = PLUCK_SEMIS[Math.floor(Math.random() * PLUCK_SEMIS.length)];
    if (!built || !running()) return semi;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = semiHz(semi);
    const g = ctx.createGain();
    const peak = isPlayer ? 0.16 : 0.07;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.6);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.7);
    return semi;
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
    g.gain.setValueAtTime(0.10, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1600;
    o.connect(f); f.connect(g); g.connect(master);
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
  // (straight into adGate) so the round-end fade can't kill it.
  function fanfare() {
    if (!built || !running()) return;
    const t0 = ctx.currentTime + 0.05;
    const out = ctx.createGain();
    out.gain.value = 0.7;
    out.connect(adGate);

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
  // which chord the bed is on, and how thinned the drone stack is.
  function state() {
    return { chordIdx, dropped: droppedVoices };
  }

  return {
    ensure, unlock, running, ready, state,
    start, stop, roundStart,
    setMuted, setUserMuted,
    setTilt, setCrowd, telegraph,
    pluck, grab, onDeath, thicken, fanfare,
  };
})();
