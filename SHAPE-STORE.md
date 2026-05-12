# Shape Store variant

Branded fork of Plate for The Shape Store (@infarc_ / Infinite Archive on X). Same mechanics, different skin.

## What's different

- **Figures → colored geometric shapes.** Primary palette: red, blue, yellow, green, orange, purple, pink, light blue, lime, yellow. Mix of cubes, spheres, cones, cylinders, octahedra. Every figure gets a unique shape+color combo at spawn. Slight roughness on materials so they read as painted wood / foam blocks, not plastic.
- **Hand → mechanical arcade claw.** Three-prong design, metallic gray, thin cable extending up out of frame. Prongs spread outward when open, converge at pinch point when closed. Slight per-prong stagger on close so it reads as mechanical without being robotic.
- **Palette shift.** Background warmer dark (0x14110d). Plate lighter wood tone (0xd9b88a). Rim warmer brown (0x6a4a2c). Concentric rings stay but in warmer hues.
- **Player marker.** Small spinning yellow octahedron-star above the player's shape, glowing emissive. No more red sash.
- **HUD strings.** "claw activates / descending / targeting / grasping / taken / idle" instead of the hand verbs.

## What's the same

Everything else. Plate tilt, contact damage, i-frames, knockback, edge falls, plate shrink, zone scaling, predator auto-aim, telegraph randomization, hover drift, lift twist, mobile layout, camera fitting. The Shape Store fork is purely cosmetic.

## File

`plate-shapes.html` — sibling to plate.html. Same single-file architecture, no external assets (no GLB, claw is procedural).

## Reference

The Shape Store is a meme account on X — colored geometric blocks (Mondrian-ish palette), retro 90s playroom / public-access TV aesthetic, archival-footage framing. Pav's friend runs it. The branded game riffs on the visual language: ten shapes on the floor, claw machine descending, last three standing.

## Reference screenshots

(Add to repo or paste in Claude Code session)
- Grand opening of The Shape Store: person wearing a chain of large colored geometric shapes
- Shape store basement footage: foam cubes, spheres, pyramids in primary colors on hardwood
- Wooden bead toy: small primary-colored cubes/spheres/star on a string

## Implementation notes

A few decisions worth knowing:

- **Per-figure collision radius.** Different shapes have different sizes, so the collision check uses `(a.collidR + b.collidR)` instead of a fixed constant. Each figure stores its own `collidR` based on its shape type.
- **No HP pip rings.** The original figures had a 10-pip ring at the base of each body for HP. Geometric shapes can't carry that cleanly. Replaced with emissive glow that intensifies as HP drops, white flash during i-frames.
- **Pinch animation simplified.** No asymmetric thumb-leads-index timing. All three prongs close together with tiny per-prong delays (0, 0.06, 0.12 of pinch progress). Two-stage curve with hold beat at 60-75% still applies — the claw "tests" before committing.
- **Cable, mounting plate, central column.** Cable is a thin black cylinder extending 6 units up from the claw. Mounting plate is a metallic disc just above the prong pivots. Central column is darker metal beneath the plate. The whole assembly sits inside `handAnim.tilt` so existing wobble/sway code applies.
- **Prong geometry.** Pivots positioned at radius 0.15, height 0.735 above pinch point. Prong length 0.75. Closed angle (-0.20 rad) makes tips converge exactly at origin. Open angle (+0.55 rad) spreads them outward. Hooked tips bent inward 0.35 rad for the classic arcade claw silhouette.
- **Spinning player star.** Octahedron geometry, yellow with strong emissive (0.95 intensity). Rotated on Y and X each frame for shimmer. Positioned above the player's shape at `yOffset * 2 + 0.25`.

## What good looks like

The arcade claw descends with arc and tremor, hovers, prongs close on the target with a small mechanical breath beforehand, lifts the captured shape out of frame with a slight twist. Shapes are bright and chunky against the warm wood floor. Reads as toy-store / 90s playroom, not horror.
