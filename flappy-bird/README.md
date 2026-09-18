# jev-flappy-agent

An agent that opens [flappybird.io](https://flappybird.io/) in your Google Chrome and plays it
in real time, with [TypeSafe](https://typesafe.ai)'s **Jev** model choosing every maneuver.

```
┌──────────────┐  snapshots (120 Hz sim, pushed ~60/s)  ┌──────────────────────┐   1 HTTP call / ~100 ms   ┌──────────────┐
│ flappybird.io│ ─────────────────────────────────────▶ │ Node agent            │ ────────────────────────▶ │ TypeSafe Jev │
│ (Chrome)     │ ◀───────────────────────────────────── │  exact physics replica│ ◀──────────────────────── │ jev-latest   │
│ page-agent.ts│  plans: "flap at simulation step N"    │  5 candidate maneuvers│  choice + probabilities   └──────────────┘
└──────────────┘                                        └──────────────────────┘
```

## How the work is split (and why)

Jev is a System One model: it reads text and returns typed judgments with calibrated
probabilities. It cannot see pixels and it is not a calculator. The TypeSafe docs are explicit
that arithmetic belongs in code and the model should get narrow, well-described judgments.
So the agent is built like this:

| Concern | Who | How |
| --- | --- | --- |
| Seeing the game | code, in the page | `flappybird.io` exposes its simulation as `window.__game`; the injected script wraps `step()` and pushes bird height, velocity and pipe positions to Node every other step. |
| Physics | code, in Node | `src/physics.ts` is a bit-exact replica of the game's fixed-point simulation (verified against a recorded run in `test/physics.test.ts`). |
| Candidate maneuvers | code | Each cycle, five concrete options (`flap_now`, `flap_soon`, `flap_later`, `flap_much_later`, `hold_off`) are simulated through the upcoming pipe and, once it is rolled, the following one. Every option gets its consequences spelled out in words: result, worst clearance at each gap, clearance above and below, where the bird arrives relative to the following gap, flaps needed. |
| **The decision** | **Jev** | One Choice question over those five options, plus a speculative Choice about which part of the gap to fly through (used only when the following gap is already known). |
| Timing | code, in the page | Jev's answer names an absolute simulation step to flap on; the page executes it frame-exactly. Requests are built for the future: forecasts start at the step by which the answer is expected back (measured round trip), so a plan is executable the moment it arrives. |
| Safety net | code | If no plan covers the current step (late or failed request, warm-up before the first pipe), a simple hover rule keeps the bird near the gap line. Its flaps are counted separately so you can see how much of the flying Jev actually did. |
| Verification | code | When an answer arrives, the chosen schedule is re-simulated from the world as it is now and dropped as stale if it no longer survives. A choice the simulation shows to be a certain crash is vetoed in favor of a surviving option. A flap scheduled by an earlier plan that a fresh forecast shows to be fatal (typically right after the target switches to the next pipe) is cancelled. All of these are counted in the status line. |

Measured on a normal connection, Jev answers in roughly 130 to 250 ms per request (p50/p90), and
the agent keeps up to three requests in flight, so a fresh decision lands about every 100 ms of
game time. In a 4-minute live session Jev flew one run to a score of 141 and was still going when
the session cap stopped it, with 82% of answers applied, no errors, and 684 plan flaps against 12
safety-net flaps.

## Setup

This folder is one game inside the `jev-test` workbench. Install and configure once at the repo root:

```bash
cd ..                        # the jev-test root
npm install                  # installs this game's dependencies too (npm workspaces)
cp .env.example .env         # put your key in the root .env: TYPESAFE_API_KEY=...
npm run check-key
```

Requirements: Node.js 22.6 or newer (Node 24 recommended; TypeScript runs natively, no build step),
Google Chrome, a TypeSafe API key from <https://console.typesafe.ai/settings/keys>. The key is read
from the nearest `.env` (this folder, then the parents), so the root one is enough.

## Play

From the repo root, through the launcher:

```bash
node play.ts flappy-bird                       # Jev flies, per agent.config.json
node play.ts flappy-bird --runs 3 --log logs/jev.jsonl
node play.ts flappy-bird --help
```

Or from inside this folder: `npm start` or `node src/main.ts --help`.

### Stop conditions: play for N seconds, or until score N

Two settings decide when a session ends, and the first one met wins:

| Setting | Config key | Flag | Meaning |
| --- | --- | --- | --- |
| Play time | `"max-seconds": 60` (alias `play-seconds`) | `--play-seconds 60` | Stop after 60 seconds of session time, whatever the score. `0` = no limit. |
| Target score | `"target-score": 20` (alias `score`) | `--target-score 20` | Stop the moment a run reaches 20. If a run dies earlier the agent restarts and keeps trying. `0` = no target. |

A third, `runs` / `--runs`, stops after N finished runs. `linger` / `--linger` keeps the window
open a few seconds after a stop so you can see the final state (default 3).

Settings are layered: built-in defaults, then `agent.config.json` in this folder (or
`--config <file>`), then flags. Flags override the file. The shipped `agent.config.json`:

```json
{
  "max-seconds": 60,
  "target-score": 20,
  "runs": 0,
  "linger": 3,
  "ranked": false
}
```

Keys use the flag names (`target-score`) or camelCase (`targetScore`); any flag can be a key.
The status line shows the goal and the countdown, and the final summary names the condition that
ended the session:

```bash
node play.ts flappy-bird                                   # 60 s or score 20, per the file
node play.ts flappy-bird --target-score 50                 # file's 60 s limit, target 50
node play.ts flappy-bird --play-seconds 300 --target-score 0   # 5 minutes, no target
```

A Chrome window opens on the game and the terminal shows a live status line:

```
run 1 | play | score 76 (best 0) | step 15502 | jev (jev-latest) | rtt 181/222ms | 12.4 req/s | applied 82% stale 60 veto 0 cancel 1 err 0 | flaps plan 383 fallback 9 | last flap_soon 0.36 line=low | danger critical
```

- `rtt` is the model round trip (p50/p90). `applied` is the share of answers that were still valid when they arrived; the rest were superseded by a newer answer or `stale` (the world had moved on). With three requests in flight some overlap is normal.
- `flaps plan / fallback` tells you who flapped: Jev's plans or the code safety net.
- `veto` counts answers the simulation proved to be a crash while a safe option existed; `cancel` counts pending flaps dropped because a fresh forecast showed them fatal.
- `danger` is computed in code from the forecasts (how many options survive and with what margin) and speeds up the cadence when things get tight.

Keep the game window visible: Chrome throttles hidden tabs and the game pauses.

### Options worth knowing

| Flag | Default | Meaning |
| --- | --- | --- |
| `--interval <ms>` | 100 | Decision cadence. Lower means more requests per second (about 1,600 input tokens each). |
| `--in-flight <n>` | 3 | Max concurrent model requests. |
| `--play-seconds <s>` / `--target-score <n>` / `--runs <n>` | from `agent.config.json` | Stop conditions, see above. |
| `--config <file>` | agent.config.json | Settings file; flags override it. |
| `--ranked` | off | Runs are **unranked** by default (the agent flips the game to offline mode before each run) so a bot does not push people off the public leaderboard. Pass `--ranked` if you want scores to count. |
| `--no-fallback` | off | Disable the hover safety net: the bird only flaps on Jev's plans. Expect crashes when a request is slow. |
| `--cdp http://localhost:9222` | | Attach to a Chrome you started with `--remote-debugging-port=9222` instead of launching one. |
| `--log <file>` | | JSON lines with every decision (situation, all five forecasts, Jev's probabilities and confidence, outcome) and a summary per run. |
| `--print-request` | | Print one complete Jev request for a sample situation. Paste it into the [Playground](https://console.typesafe.ai/playground) to see the questions the model answers. |

## The questions Jev answers

State (kept small on purpose, everything already in words):

```json
{
  "situation": {
    "bird": { "height_vs_upcoming_gap": "slightly below the gap center (-0.04 units)",
              "vertical_motion": "falling (-0.4 units/s)",
              "height_above_ground": "safe (1.07 units)" },
    "upcoming_gap": { "distance": "close", "time_until_reached_seconds": 0.26, "size": "standard gap (0.47 units tall)" },
    "following_gap": "much higher than the upcoming gap (0.35 units)"
  }
}
```

`maneuver` (Choice) with one criterion per option, for example:

```json
"flap_soon": { "timing": "wait 50 ms, then flap",
               "result": "clears the upcoming gap and then the following gap",
               "worst_clearance_at_upcoming_gap": "tight",
               "clearance_above": "comfortable (0.1 units)", "clearance_below": "tight (0.07 units)",
               "position_when_reaching_following_gap": "well below the gap center (-0.22 units)",
               "worst_clearance_at_following_gap": "comfortable",
               "flaps_needed": 4 }
```

`line_through_gap` (Choice: high / centered / low), asked in the same request and consumed only
when the following gap is known; it shifts the hover line the forecasts assume by 0.05 units.

## Project layout

```
src/main.ts         CLI entry point
src/config.ts       settings: defaults, agent.config.json, flags
src/agent.ts        decision loop: latency-aware planning, freshness checks, stop conditions, stats
src/brain-jev.ts    builds the TypeSafe request and calls the SDK
src/planner.ts      candidate maneuvers, exact forecasts, plain-language labels
src/physics.ts      bit-exact replica of the game's simulation
src/page-agent.ts   script injected into the page: observes steps, executes plans
src/browser.ts      Playwright launch/attach and page wiring
src/hud.ts          status line
test/               node:test suites, including the recorded-run replay
```

`npm test` runs the suites and `npm run typecheck` runs `tsc`, here or from the repo root.

## Limits and notes

- The agent reads game state from the site's own `window.__game` global. If the site stops
  exposing it, the sensor needs another source (for example hooking canvas draws).
- Jev only sees what the code describes. A situation the labels do not capture is invisible to it.
- The site loads ads; the agent talks to the game object directly, so ads do not block input,
  but an overlay can still cover the canvas visually.
- Cost: about 1,600 input tokens per request and 12 to 13 requests per second while flying at the
  default cadence, so roughly 1.2 million input tokens per minute of play. Check current pricing at
  <https://docs.typesafe.ai/models>; `--interval 150 --in-flight 2` roughly halves it.
- Stale answers are the price of pipelining: a plan applied from one answer can invalidate the
  assumptions of the one or two requests already in flight. They cost tokens, not safety.
