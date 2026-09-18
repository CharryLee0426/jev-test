# jev-test

A workbench for testing how well [TypeSafe](https://typesafe.ai)'s **Jev** model plays real-time
browser games. Each game is a folder with its own agent; everything is launched from this root, and
the API key lives here once, shared by every game.

```
jev-test/
  .env                 your TYPESAFE_API_KEY (copy from .env.example; git-ignored)
  play.ts              launcher: node play.ts <game> [options]
  package.json         npm workspaces: one `npm install` here installs every game
  flappy-bird/         first game: flappybird.io, Jev picks every maneuver
    game.json          manifest the launcher reads (name, title, description, entry)
    agent.config.json  per-game settings (stop conditions etc.)
    README.md          how that agent works
  tetris/              second game: play.tetris.com, Jev picks every placement
    game.json, agent.config.json, README.md   same layout; goals: level, score or time
```

## Setup

Requirements: Node.js 22.6 or newer (Node 24 recommended; TypeScript runs natively) and Google Chrome.

```bash
npm install
cp .env.example .env         # put your key in .env: TYPESAFE_API_KEY=...
npm run check-key            # validates the key against the TypeSafe API
```

## Run a game

```bash
npm run list                                   # games available
node play.ts flappy-bird                       # play with the game's agent.config.json
node play.ts flappy-bird --target-score 20     # game options pass straight through
node play.ts flappy-bird --play-seconds 60
node play.ts flappy-bird --help                # every option of that game
npm run flappy-bird -- --target-score 30       # same thing through npm
node play.ts tetris --target-level 5           # Tetris: stop when a game reaches level 5
node play.ts tetris --target-score 30000       # ...or a score
node play.ts tetris --play-seconds 120         # ...or after two minutes
```

The Tetris site shows ads before the game and between games; the agent waits them out and closes them
with their own close controls (never clicking an ad), see `tetris/README.md`.

The launcher loads `.env` from this folder, then starts the game's entry with the game's folder as
the working directory, so each game's own config file applies. Ctrl+C stops the game and prints its
summary.

## Add a game

1. Create a folder, for example `snake/`, with its own `package.json` (it becomes an npm workspace:
   add the folder name to `workspaces` in the root `package.json`).
2. Add `snake/game.json`:

   ```json
   { "name": "snake", "title": "Snake", "description": "What Jev decides here", "entry": "src/main.ts" }
   ```

3. Read the key from the environment (`TYPESAFE_API_KEY`); the launcher has already loaded it.
   The `flappy-bird` agent is a template for the split that works with Jev: code reads the game and
   does every calculation, Jev answers narrow typed questions, code executes the answer.
4. `npm install` once at the root, then `node play.ts snake`.

## Checks

```bash
npm test          # every game's test suite
npm run typecheck # launcher and every game
```
