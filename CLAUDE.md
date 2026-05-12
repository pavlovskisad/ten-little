# Plate

Browser-based elimination game prototype. Ten figures on a circular plate, an unseen hand descends and picks them off, plate tilts under their weight, players damage each other through contact. Last three standing win.

Currently single-player feel test with bot opponents. Will eventually become a multiplayer crypto pot game: 10 entries, top 3 paid out asymmetrically (3rd refund, 2nd 2.5x, 1st 5.5x), settled in PAXG on Base L2.

---

## Tech stack

- three.js r128 from cdnjs (global script, not modules)
- GLTFLoader from jsdelivr (`examples/js/loaders/GLTFLoader.js`)
- Hand-rolled physics — no rapier/cannon. 2D positions on plate, tilt vector from weighted center of mass, slide acceleration on tilt, soft figure-figure separation with damage exchange
- Pure HTML/CSS/JS, single file, no build step, no package.json yet
- No audio, no MP, no persistence

## Files

- `plate.html` — the entire game (~1800 lines)
- `Arm3.glb` — rigged hand model (5 finger chains, 27 bones, ~2k tris)
- `CLAUDE.md` — this doc

## Running locally

```
python3 -m http.server
# or
npx live-server
```

Open `http://localhost:8000/plate.html`. Opening `plate.html` directly via `file://` will fail to load `Arm3.glb` because browsers block local cross-file fetches. Always serve.

---

## Game mechanics

### Round flow

- 10 figures spawn in a jittered ring on the plate (1 player marked red, 9 bots)
- Plate continuously tilts based on weighted centroid of remaining figures
- Hand descends every 3–7s with a telegraphed warning circle that auto-tracks prey
- Game ends when 3 figures remain. Player placement = rank among survivors (closest to center wins ties) or position in elimination order if dead.

### Elimination paths

1. **Hand grab** — caught inside the pick zone at moment of capture
2. **Edge fall** — slid past the plate rim via tilt + crowd shoving
3. **HP drain** — contact damage from other figures dropped you to 0

### Forcing functions

- Plate radius shrinks 7% every 14s. `S.plateR` drops, mesh tween follows.
- Pick zone scales from ~11% of plate radius at 10 alive to ~55% at 3 alive (more lethal late).

### Contact damage

- 10 HP per figure, 1 damage per contact, mutual
- 600ms i-frames after each hit (no chain damage in scrums)
- Knockback impulse on damage (5.5 m/s opposing along contact normal)
- HP=0 triggers drain animation, figure shrinks and removes
- Bots have per-spawn `boldness` factor (0–1) that drives aggression. Healthy bold bots seek targets. Hurt bots flee.

---

## Hand system (active work area)

The hand uses a GLB model with manual bone control. The state machine:

| Phase | Duration | What happens |
|-------|----------|--------------|
| telegraph | 0.7–3.3s random | Reticle expands on plate, hand floats above with auto-aim drift |
| approach | 0.55–0.9s random | Hand descends with curved arc from off-axis to over target |
| hover | 0.10–0.25s random | Pause beat at grab height, capture moment fires |
| pinch | 0.19–0.27s random | Index leads, thumb follows, two-stage curl with hold beat |
| lift | 0.77–0.98s random | Hand rises with outward arc, captured figure rides along |

All durations randomize per grab.

### Bone mapping (from GLB inspection)

```
Bone.001 (wrist hub)
├── Bone.002 → Bone.003 → Bone.004           [THUMB, 3-bone chain]
├── Bone.009 → Bone.013 → Bone.014 → .015    [INDEX]
├── Bone.010 → Bone.016 → Bone.017 → .018    [middle]
├── Bone.011 → Bone.019 → Bone.020 → .021    [ring]
├── Bone.012 → Bone.022 → Bone.023 → .024    [pinky]
└── Bone.005–008, Bone.025                   [IK helpers, do not touch]
```

Mesh is bound to bones via standard glTF skinning (JOINTS_0 + WEIGHTS_0 in primitives).

### HAND_RIG config block (top of plate.html)

This is the tuning surface:

```js
const HAND_RIG = {
  url: './Arm3.glb',
  scale: 0.16,           // model scaled to game units
  rotX: Math.PI,         // flip fingers from +Y to -Y
  thumb:  { boneName: 'Bone.002', axis: 'x', closeAngle: 1.20 },
  index:  { boneName: 'Bone.009', axis: 'x', closeAngle: 1.05 },
  middle: { boneName: 'Bone.010', axis: 'x', closeAngle: 0.55 },
  // ...
};
```

Each finger entry: `axis` is which bone-local axis curls the finger, `closeAngle` is how far in radians from rest pose.

### Current state of the hand

**Hand model loads and follows the state machine position correctly.** The position arc, tremor, hover drift, lift twist all work as expected on the hand as a whole object.

**The bone curl animation is not reading correctly.** When the pinch fires, fingers don't curl properly. Most likely cause: wrong rotation axis per finger, or wrong sign on the close angle, or both.

### Debug workflow

1. Serve and open the game
2. Wait for a hand cycle (~5s after game start)
3. Watch the fingers during the pinch phase
4. If fingers spread sideways instead of curling → try axis `'z'` or `'y'`
5. If fingers bend backward → flip the sign on `closeAngle` (e.g. `-1.20`)
6. Each finger may need a different axis — the original rigger's bone orientations aren't guaranteed consistent across fingers

To isolate one finger at a time: set the other fingers' `closeAngle` to 0 temporarily so only one finger animates.

---

## Predator auto-aim

During telegraph + approach, the hand visually drifts toward the best-scoring figure on the plate. Scoring weights:

- **Closeness** to original telegraphed spot
- **Speed** (predator notices motion)
- **Approach trajectory** (figures running INTO origin score higher than figures running out)

Movement weight ramps from low (scan mode) to high (commit mode) over the cycle. Response speed ramps too — slow drift while scanning, sharp chase while striking. Drift is capped at ~26% of plate radius so the reticle can't teleport across the plate.

Phase-aware progress: telegraph fills 0→0.40 regardless of its length, approach fills 0.40→1.0. This keeps a 3s telegraph in "scan mode" the whole time instead of burning through commit-progress before the descent begins.

Capture check at end of approach uses the drifted aim position, so prey caught in the moved zone IS captured. The reticle is honest — it shows what'll catch you.

---

## Camera

Camera follows plate radius. Distance computed each frame to fit `plateD × margin` into visible width/height. Margin lerps from 1.12 at full plate to 1.00 at minimum, so the late game feels claustrophobic (plate AND empty rim both shrink, compounding zoom).

Camera tweens to target with ~0.4s response, matched to the plate shrink mesh tween so they land together.

Portrait aspects widen FOV up to ~64° and pull camera back so the plate fits horizontally.

---

## Style preferences

Prose (comments, UI text, doc):
- No em-dashes (use commas, semicolons, or periods)
- No "not X but Y" contrast constructions
- No throat-clearing openers ("Note that…", "Importantly…", "It's worth noting…")
- Active voice with human subjects
- Specifics over abstractions
- Trust the reader, state facts directly

Code:
- Single file is fine for prototype phase
- Comments explain WHY not WHAT
- All tunable values exposed in `CFG` or `HAND_RIG` blocks at top of file, not scattered through functions

---

## Next tasks (priority order)

1. **Tune HAND_RIG axes and angles** until pinch reads as a real grasp
2. **Sound layer** — Tone.js for telegraph pulse, approach whoosh, pinch click, lift suck. Atmospheric, not loud.
3. **Spectator view for eliminated players** — currently dead players see only the end screen at game end. For 60–90s rounds where you might die in second 10, this is brutal. Show the remaining plate state for context.
4. **Single-player polish** — placement ranking among top 3 is currently "closest to center wins" which is a placeholder
5. **Multiplayer port** — Colyseus server with server-authoritative physics, replacing bots with real players. State sync at 20Hz, client-side interpolation.
6. **Crypto layer** — entry payment, escrow contract on Base, payout distribution. PAXG settlement, hooks into musa rails.

---

## Recent iteration history

For context on design decisions:

- Procedural hand built first (cylinders + spheres + box palm). Got animation feel right before swapping geometry.
- Hand replaced with GLB model. State machine unchanged — same predator/scan/pinch logic, just driving bones instead of THREE.Group rotations.
- Predator auto-aim went through several tunings: initial lock-style was too rigid, continuous closest-only tracking felt mechanical, current scored-based version with phase-aware progress feels right.
- Telegraph duration randomized 0.7–3.3s so consecutive grabs feel different. Long telegraphs read as "hunting", short ones as "snap strikes."
- Camera made plate-following (closes in as plate shrinks) instead of fixed.
- Contact damage with i-frames and knockback added for player-vs-player interaction (originally just hand + tilt as threats).

---

## What "good" looks like for the next session

The hand grasps like a hand. Thumb and index converge on the figure. Other fingers curl partially in support. Wrist comes from outside the plate, descends with arc, pauses, pinches, lifts. Captured figure rises into the closed pincer and shrinks into the hand as it leaves frame. The whole motion reads as deliberate and unpredictable, never identical between grabs.
