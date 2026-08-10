# The player marker — studio recipe

How shape store marks "you" so the eye never loses the player, even
mid-scrum. Written to be lifted into any sibling game in one sitting.
Reference implementation: `buildPlayerMarker()` + the marker block in
`updateFigures()` in this game's `index.html`.

## The design rule (the part that matters)

**Give the player the one color nothing else in the scene owns.**
Here that's neon green (`0x39ff6a`): danger is red, pickups and UI
actions are gold, the figures are a mixed palette — so a green light
can only mean "you." Audit your game's palette first; if green is
taken, pick whatever hue is unclaimed and keep it exclusive forever
(never use it for a pickup, an enemy, or a particle).

Second rule: **the marker pulses like a heartbeat.** Peripheral
vision is wired for motion — a static marker vanishes in a crowd, a
breathing one is findable without looking straight at it.

## The three pieces

1. **Floating star** — a small octahedron hovering above the
   character, tumbling on two axes, pulsing in scale AND glow:
   - geometry: `OctahedronGeometry(0.38)` (≈ 0.4× character height)
   - material: `MeshStandardMaterial` with `color` = `emissive` =
     marker hue, `emissiveIntensity 1.5`, roughness 0.25
   - hover height: character height + ~0.35 world units
   - tumble: `rotation.y += dt * 2.8; rotation.x += dt * 1.7`

2. **Ground ring** — a flat ring at the character's feet so the
   marker survives occlusion from above (the star can hide behind
   the character; the ring never does):
   - `RingGeometry(0.60, 0.72, 48)`, rotated flat, ~5mm above floor
   - `MeshBasicMaterial`, marker hue, transparent, opacity ~0.95
   - slow counter-spin: `rotation.z += dt * 1.1`

3. **The heartbeat** — one shared pulse phase, star and ring in
   COUNTER-phase so the marker "breathes" instead of blinking:
   ```js
   const mpulse = Math.sin(performance.now() / 1000 * 4.6);
   star.scale.setScalar(1 + 0.22 * mpulse);
   star.material.emissiveIntensity = 1.5 + 0.7 * mpulse;
   ring.scale.setScalar(1 + 0.12 * Math.sin(performance.now() / 1000 * 4.6 + Math.PI));
   ring.material.opacity = 0.7 + 0.3 * Math.abs(mpulse);
   ```
   - 4.6 Hz-ish rate reads as urgent-but-calm; go 3.5 for chill
     games, never above ~6 (strobes)
   - scale swing ±22% on the star, ±12% on the ring
   - glow swing roughly 0.8 → 2.2 emissive

## Placement + lifecycle

- Parent the marker group to the ARENA (plate/floor group), not the
  character mesh — the character can spin/squash freely without
  spinning the marker.
- Track the player's position each frame; hide the marker when the
  player is dead / being carried / despawned:
  `marker.visible = player && player.alive && !player.captured`
- Rebuild (or re-attach) on every respawn.

## Reinforce it everywhere else

- The character body itself keeps a faint always-on emissive
  (`0.3` of the character's own tint) so it reads even when the
  marker is off-screen at the arena rim.
- If the game has a pad/minimap visual layer, the player's blob
  there runs brighter than everyone else's (this game: 2× alpha on
  the Kaoss surface).
- HUD hearts + popups belong to the player only — no per-bot HUD.

## Copy checklist for a new game

1. Pick the unclaimed hue; declare it player-only in the game doc.
2. Paste `buildPlayerMarker()` + the pulse block; swap the hue.
3. Scale the three sizes (star radius, hover height, ring radii) to
   your character's height; keep the ratios.
4. Parent to arena, wire visibility to the player's alive state.
5. Screenshot a crowded moment and squint: if you can't find the
   player in half a second, raise the pulse depth before raising
   the size.
