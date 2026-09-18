# jev-tetris-agent

An agent that opens the official [Tetris](https://play.tetris.com/) in your Google Chrome and plays
it in real time, with [TypeSafe](https://typesafe.ai)'s **Jev** model choosing where every piece goes.

```
┌────────────────────┐  snapshots (every frame, pushed on change)  ┌────────────────────────┐   1 HTTP call / piece   ┌──────────────┐
│ play.tetris.com    │ ──────────────────────────────────────────▶ │ Node agent              │ ─────────────────────▶ │ TypeSafe Jev │
│ (Chrome, game      │ ◀────────────────────────────────────────── │  board model + lookahead│ ◀───────────────────── │ jev-latest   │
│  iframe, keys)     │  plans: "hold, turn twice, 3 left, drop"    │  6 described candidates │  choice + probabilities └──────────────┘
└────────────────────┘                                             └────────────────────────┘
```

## Three goals, first one met wins

| Goal | Config key | Flag | Meaning |
| --- | --- | --- | --- |
| Level | `"target-level": 5` (alias `level`) | `--target-level 5` | Stop the moment a game reaches level 5. |
| Score | `"target-score": 20000` (alias `score`) | `--target-score 20000` | Stop the moment a game reaches 20,000 points. |
| Time | `"max-seconds": 120` (alias `play-seconds`) | `--play-seconds 120` | Stop after 120 seconds of session time, whatever the score. |

`0` disables a goal. If a game ends (top-out) before a level or score goal is met, the agent starts
the next game and keeps trying. `runs` / `--runs` stops after N finished games, and `linger` /
`--linger` keeps the window open a few seconds after a stop so you can see the final board.

```bash
node play.ts tetris                                # per agent.config.json: 120 s
node play.ts tetris --target-level 5               # play until a game reaches level 5
node play.ts tetris --target-score 30000           # play until a game scores 30,000
node play.ts tetris --play-seconds 60              # play for one minute
node play.ts tetris --target-level 8 --play-seconds 300   # level 8, or five minutes, whichever first
```

Settings are layered: built-in defaults, then `agent.config.json` in this folder (or `--config <file>`),
then flags. The shipped file:

```json
{
  "target-level": 0,
  "target-score": 0,
  "max-seconds": 120,
  "runs": 0,
  "start-level": 1,
  "candidates": 6,
  "linger": 3
}
```

## Ads: waited out and closed, never clicked

The site shows ads in three places, and the agent treats every one of them the same way: wait, then
use the ad's own close control; never click the creative.

1. **Interstitial in the game frame** (AdSense, first load). Its "Close ad" control has a countdown;
   the agent watches that control inside Google's ad frame and clicks it, and only it, once the
   countdown is over.
2. **Click-to-play layer** (the site's own transparent layer over the game). One click on the site's
   layer starts a video preroll; the agent waits for the video to finish. If the player offers a
   "Skip" control it is used, otherwise the video simply plays out (15 to 30 s).
3. **Video before every later game**. Same as above, without the click. (A qualifying score first shows the game's own high-score screen; the agent leaves it through that screen's Done action, keeping the default initials.)

If an interstitial never offers a close control, the agent waits `--ad-timeout` seconds (default 90)
and then tells the page that the ad is over through the page's own completion callback, so a session
cannot hang forever. That fallback is counted in the summary (`fallbacks`) and logged.

## How the work is split (and why)

Jev is a System One model: it reads text and returns typed judgments with calibrated probabilities.
It cannot see pixels and it is not a calculator. So, as in `flappy-bird`, code reads the game and does
the arithmetic, Jev answers narrow typed questions, and code executes the answer.

| Concern | Who | How |
| --- | --- | --- |
| Seeing the game | code, in the page | The game (a Cocos build of the Tetris engine) publishes its app on `window.mBPSApp`; the injected script reads the matrix, live piece, ghost, hold, queue, score, level and fall speed every frame and pushes a snapshot to Node when something changes. |
| Placements | code, in Node | `src/tetris.ts` models the board (SRS shapes, hard drops, line clears) and computes features: heights, holes, wells, bumpiness, transitions. Every placement of the live piece and of the piece a hold would bring out is simulated exactly, then the following piece's best reply on the resulting board. |
| Candidates | code | The best placements by a Dellacherie-style heuristic (with the top line clear, the cleanest option, a hold option and the lowest option always included) are shortlisted, six by default, and every consequence is written in words: where, lines cleared, holes, stack height after, well, outlook for the next piece, risk. |
| **The decision** | **Jev** | One Choice over the shortlist, plus a speculative Choice about the strategic posture (build for a tetris, clear lines now, repair the surface) that code turns into the heuristic's weights for the next cycle. |
| Timing | code | While a piece is being placed, the next piece is already known, so the agent simulates the board after the chosen placement and asks about the next piece right away. When it spawns and the board matches the prediction, the answer is applied at once. Otherwise a fresh request goes out, and if it is late, the code safety net places the piece and the answer is counted as stale. |
| Execution | code, in the page | A plan is "hold, N turns, M steps sideways, hard drop". The page presses those keys on the canvas, checks the piece's shape and column after every key, and compares the game's own ghost piece with the target cells before dropping. |
| Verification | code | A chosen placement the simulation shows to be a certain top-out is vetoed in favor of a surviving option. Stale answers, late answers, vetoes and failed executions are all counted in the status line. |

Measured on a normal connection, Jev answers in roughly 120 to 350 ms (p50/p90), about 2,000 input
tokens per request. In the first 90-second session from level 1 Jev placed 127 pieces (every one of
them), cleared 66 lines, reached level 7 and scored 43,160 with no failed executions and no code
fallbacks. A two-game session starting at level 20 scored 77,650 and 58,000 and went through the
high-score screen, the video preroll and the restart without help.

## Setup

This folder is one game inside the `jev-test` workbench. Install and configure once at the repo root:

```bash
cd ..                        # the jev-test root
npm install
cp .env.example .env         # put your key in the root .env: TYPESAFE_API_KEY=...
npm run check-key
```

Requirements: Node.js 22.6 or newer (Node 24 recommended; TypeScript runs natively, no build step),
Google Chrome, a TypeSafe API key from <https://console.typesafe.ai/settings/keys>.

## Play

From the repo root, through the launcher:

```bash
node play.ts tetris                         # per agent.config.json
node play.ts tetris --target-level 5 --log logs/level5.jsonl
node play.ts tetris --help
```

Or from inside this folder: `npm start` or `node src/main.ts --help`. A Chrome window opens on the
game (keep it visible: Chrome throttles hidden tabs and the game pauses) and the terminal shows a live
status line:

```
game 1 | play | score 16670 | level 5 (10 to next) | pieces 80 lines 40 | goal 20s left | jev (jev-latest) | rtt 142/245ms | 5.2 req/s | applied 70% preplanned 79/80 stale 26 late 0 veto 0 err 0 | placed jev 80 code 0 failed 0 | last option_5 0.22 posture=build_for_tetris
```

- `rtt` is the model round trip (p50/p90). `applied` is the share of answers that were used; the rest
  were `stale` (the piece had already been placed or had changed). `preplanned a/b` says how many
  pieces found their answer waiting when they spawned.
- `placed jev / code` tells you who placed the pieces: Jev's answers or the code safety net (late or
  failed answers). `failed` counts plans the page could not execute (a blocked move, a ghost mismatch).
- `posture` is Jev's strategic answer for the next cycle.

### Options worth knowing

| Flag | Default | Meaning |
| --- | --- | --- |
| `--start-level <n>` | 1 | Level each game starts at. Higher levels fall faster. |
| `--candidates <n>` | 6 | Placements Jev chooses between. More options cost more tokens. |
| `--timeout <ms>` | 1500 | Per-request model timeout. |
| `--no-preplan` | off | Ask only when a piece has spawned (one round trip on the critical path). |
| `--no-fallback` | off | Never let code place a piece; the piece falls on its own while waiting. |
| `--key-delay <ms>` | 16 | Delay between key presses. |
| `--ad-timeout <s>` | 90 | Wait for an ad's own close control this long before the fallback; 0 = forever. |
| `--cdp http://localhost:9222` | | Attach to a Chrome you started with `--remote-debugging-port=9222`. |
| `--log <file>` | | JSON lines: every decision (situation, all candidates, Jev's probabilities and confidence), every execution, every ad action and a summary per game. |
| `--print-request` | | Print one complete Jev request for a sample board. Paste it into the [Playground](https://console.typesafe.ai/playground). |

## The questions Jev answers

State (everything already in words; numbers are secondary detail):

```json
{
  "objective": "reach level 5 (now level 3, 4 more lines to the next level); every line cleared counts, but a top-out ends the game",
  "situation": {
    "board": { "stack_height": "low: highest column 6 of 20 rows, average 3.8 rows", "surface": "bumpy",
               "holes": "1 buried empty cell in column 9", "wells": "a 4-deep well in column 10",
               "column_heights_left_to_right": "4,3,4,5,6,5,3,4,4,0" },
    "pieces": { "live": "T", "hold": "empty (holding would swap the live piece for the next one)",
                "next": "I (the straight four-long bar), then Z, then O (the square)" },
    "pace": "level 3: pieces fall at a moderate pace"
  }
}
```

`placement` (Choice) with the same fields for every option, for example:

```json
"option_2": { "action": "place the T",
              "where": "with the tip down, columns 1-3 on the left, landing on row 4 from the bottom",
              "lines": "no line clear",
              "holes": "creates no new holes (1 old hole remains)",
              "stack_after": "low (6 of 20 rows), surface slightly uneven",
              "well": "keeps a 4-deep well in column 10 where an I piece would score a tetris",
              "next_piece_outlook": "the following I can then clear 2 lines without creating a hole",
              "risk": "safe: stack low (6 of 20 rows)" }
```

`posture` (Choice: build_for_tetris / clear_lines_now / repair_surface), asked in the same request; its
answer selects the weight preset code ranks the next shortlist with.

## Project layout

```
src/main.ts         CLI entry point
src/config.ts       settings: defaults, agent.config.json, flags; the objective in words
src/agent.ts        decision loop: pre-planning, freshness checks, safety net, stop conditions, stats
src/brain-jev.ts    builds the TypeSafe request and calls the SDK
src/planner.ts      candidate placements, lookahead, plain-language descriptions, posture weights
src/tetris.ts       board model: shapes, drops, line clears, features, heuristic
src/page-agent.ts   script injected into the game frame: snapshots, key presses, plan execution
src/ads.ts          the ad choreography (close controls only, never the creative)
src/browser.ts      Playwright launch/attach, game frame lookup, page wiring
src/hud.ts          status line
test/               node:test suites for the board model, planner and config
```

`npm test` runs the suites and `npm run typecheck` runs `tsc`, here or from the repo root.

## Limits and notes

- The agent reads game state from the game's own engine object (`window.mBPSApp`) and starts games
  through the menu scene's own play action. If the site changes its build, the page script needs
  updating; every access is wrapped so a change shows up as an error message, not a crash.
- Candidates are hard-drop placements reached by rotating at the top and moving sideways. Tucks,
  spins and slides under overhangs are not on the table, so Jev never sees them.
- At very high levels (20 and up) pieces reach the stack almost instantly and can only be moved
  during the lock delay; plans then fail more often and the code safety net does more of the work.
- Cost: about 2,000 input tokens per request and about one request per piece, so a 90-second session
  at levels 1 to 7 used about half a million input tokens. Check current pricing at
  <https://docs.typesafe.ai/models>.
- High scores stay in the browser profile Playwright creates for the session; nothing is submitted
  anywhere.
