# shape store — poki build

Fully client-side, kid-safe, phone-first rework of the plate game for
poki.com. Solo player vs 9 bots; no server, no accounts, no crypto.
Built per `REWORK-PLAYBOOK.md` (in the `poki_reworks.zip` on main).

## What's here

- `index.html` — the whole game: the Shape Store scene (glass plate,
  colored shape figures, foam-cube room, claw, tunnel), the local sim
  (physics, bots, claw state machine), and the shell integration.
- `shell.js` / `shell.css` — the studio shell, verbatim from the
  shared kit. Only per-game override: the `:root` accent (hot red).
- `drift.js` — this game's music identity: the plate as an ambient
  generator/effector. All synthesized, zero audio files. Tilt drives
  a filter-wobble, slide speed drives tremolo, edge-closeness drives
  resonance; claw telegraph is a riser, grabs sweep down, deaths thin
  the drone stack, shrink thickens it, wins fire a weird fanfare.
- `fonts/` — Jersey 15 + DotGothic16 (latin subsets, self-hosted).
- `vendor/` — three.js r128 + GLTFLoader + DRACOLoader + draco decoder.
- `boombox.glb` / `tape.glb` / `disco.glb` — compressed props
  (11 MB of source models crushed to ~550 KB total).

The Poki SDK script is the only external request, and every call is
guarded so the game runs identically with the SDK absent.

## Run locally

```
cd poki && python3 -m http.server 8901
```

## Deploy

- **Vercel**: `vercel.json` at the repo root copies this dir into
  `dist/`. Push to main, import the repo in Vercel, done. Note the
  Poki SDK serves real ads on any domain.
- **Poki zip**: zip the CONTENTS of this dir (index.html at zip
  root):
  ```
  cd poki && zip -r ../shape-store-poki.zip . -x '*.DS_Store'
  ```

## Per-game identity (everything else is shared shell)

- Title: shape store · mascot: 🔺 · accent: `#ff4a55`
- Storage key: `shapestore.wins`
- Tutorial: 8 wordless cards (move, claw, tilt, bump, edge, shrink,
  music, win) composed from the shell's `ht-*` kit + three
  game-specific keyframes (claw drop, plate rock, plate shrink).
- Music: DRIFT (see above) — sibling games use the JUNGLE pad
  sampler instead.

## What only a real phone can verify

Silent-switch bypass, audio feel, LTE pacing, touch ergonomics.
Everything else is covered by the headless checks that ran before
each commit (splash/tutorial/menu wake order, no-scroll tutorial at
390×844 + 375×667, countdown → round → results, win path, wins
persistence, play-again).
