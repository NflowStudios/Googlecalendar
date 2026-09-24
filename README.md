# THE BACKROOMS — Nextbot Horror

A first-person web horror game built with **Next.js + React + Three.js**.
You noclipped out of reality into the endless yellow rooms — and something
in here never stops hunting you.

**Play it live:** https://nflowstudios.github.io/Googlecalendar/

## The Game

- **First-person controls** — WASD to move, mouse to look, SHIFT to sprint
  (stamina is limited), ESC to pause.
- **The Nextbot** — after a short grace period it materializes nearby and
  hunts you through the maze, navigating around walls. Break line of sight
  to buy time; sprinting outruns it, walking does not.
- **THE HORDE** — every 30 seconds after the first spawn, **one more
  Nextbot appears**, with **no limit**. A HUD counter (top center) shows
  how many are hunting you. Survive as long as you can.
- **Its song is your radar** — the monster's looped sound (Loop.mp3) is
  fully positional with a **doppler effect**: it gets louder as it closes
  in, the pitch sharpens while it gains on you, and it pans left/right so
  you can hear exactly where it is. The voice always tracks the NEAREST
  hunter. Headphones strongly recommended.
- **Catch** — when it reaches you: jumpscare.
- **Sound settings** — MASTER / SOUNDS (room ambience, footsteps, scream) /
  MUSIC (the monster's song) sliders on the home screen and the pause
  screen, persisted in your browser.

## Tech

- Next.js 16 (static export for GitHub Pages), React 19, TypeScript
- Three.js for the 3D maze, monster sprite, lighting and fog
- Web Audio API for the whole soundscape: 3-bus mixer, positional doppler
  voice, procedural room ambience
- Procedural maze generation (seeded, BFS-validated) — every run is a new
  layout

## Run it locally

```bash
bun install        # or: npm install
bun run dev        # or: npm run dev
# open http://localhost:3000
```

## Deploy to GitHub Pages

The site is a fully static export served under the `/Googlecalendar/`
subpath. Every push to `main` rebuilds and republishes it automatically
via GitHub Actions (`.github/workflows/deploy.yml`), deploying the static
build to the `gh-pages` branch.

Manual deploy from a checkout:

```bash
bun install
bun run build:pages   # static export -> out/ (with basePath /Googlecalendar)
# push the contents of out/ to the gh-pages branch
```

## Project layout

```
src/
  app/                    Next.js shell (page, layout, global styles)
  components/backrooms/   React UI overlays (menu, HUD, pause, death, settings)
  game/                   Framework-agnostic game engine
    constants.ts            all tuning values (speeds, audio, spawn rules…)
    GameEngine.ts           orchestrates everything, exposes debug hooks
    MazeGenerator.ts        procedural maze + BFS connectivity + spawn picking
    LevelBuilder.ts         walls/pillars/floor/ceiling meshes + colliders
    PlayerController.ts     FPS movement, stamina, head-bob
    Nextbot.ts              the monster: 2D-sprite AI chase (pathfinding + LOS)
    Pathfinder.ts           waypoint graph navigation
    LightPool.ts            flickering fluorescent lights
    AudioManager.ts         3-bus Web Audio mixer + positional doppler voice
public/
  audio/monster-loop.mp3   the monster's song (Loop.mp3, trimmed + normalized)
  textures/                wallpaper + monster sprites
```
