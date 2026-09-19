# jev-tetris-agent

An agent that opens the official [Tetris](https://play.tetris.com/) in your Google Chrome and plays
it in real time, with [TypeSafe](https://typesafe.ai)'s **Jev** model choosing where every piece goes.
It plays for **1,000,000 points**, which in this game means playing for tetrises and almost nothing
else — see [the arithmetic](#the-target-1000000).

```
┌────────────────────┐  snapshots (every frame, pushed on change)  ┌─────────────────────────┐  1 HTTP call / piece  ┌──────────────┐
│ play.tetris.com    │ ──────────────────────────────────────────▶ │ Node agent              │ ────────────────────▶ │ TypeSafe Jev │
│ (Chrome, game      │ ◀────────────────────────────────────────── │  board model, reach,    │ ◀──────────────────── │ jev-latest   │
│  iframe, keys)     │  plans: "hold, turn twice, 3 left, drop"    │  lookahead, shortlist   │  choice + confidence  └──────────────┘
└────────────────────┘     (armed before the spawn at 20G)         └─────────────────────────┘
```

## The target: 1,000,000

Marathon at play.tetris.com is **30 levels of 10 lines, and then the game ends**
(`endGameAtMaxLevelCompletion`). So the score is bounded: 300 lines is the whole game, and what
decides the total is not how many lines are cleared but what each one is paid.

| Clear | Base | At level 15 | Per line |
| --- | --- | --- | --- |
| Single | 100 x level | 1,500 | 1,500 |
| Double | 300 x level | 4,500 | 2,250 |
| Triple | 500 x level | 7,500 | 2,500 |
| **Tetris** | 800 x level | 12,000 | 3,000 |
| **Tetris, back to back** | x1.5 again | **18,000** | **4,500** |

A back-to-back tetris pays **three times what a single pays for the same row**, and any clear of one,
two or three lines breaks the chain. Clearing whatever happens to be available tops out near 465,000
however well you survive. Clearing all 300 lines four at a time, in an unbroken chain, is worth
**1,385,600** — the highest score the game allows. 1,000,000 is about 72% of perfect, and even
perfect play only passes it during level 26, so the agent has to survive nearly the whole marathon.

These numbers are read out of the game engine rather than assumed, and `--check-rules` re-reads them
from a live page and diffs them against `src/score.ts`:

```
ok    tetris                           live      800   src/score.ts      800
ok    back-to-back multiplier          live      1.5   src/score.ts      1.5
ok    max level                        live       30   src/score.ts       30
ok    game ends at max level           live     true   src/score.ts     true
The per-level fall speeds and lock times match for all 30 levels.
```

So the whole strategy is one sentence: **keep one column empty, stack the other nine flat, and spend
every I piece on a tetris.** `src/tetris.ts` scores placements against that — ready rows against the
well are paid for in advance, anything that caps the well is treated like a hole, partial clears are
taxed, and an I laid flat is charged the tetris it threw away.

Starting level matters, because it decides how many of the 300 lines are left to play:

| Start level | Lines left | Best possible score |
| --- | --- | --- |
| 1 | 300 | 1,385,600 |
| 10 | 210 | 1,268,000 |
| 15 | 160 | 1,069,200 |
| 20 | 110 | 832,000 |

A game started at level 20 **cannot** reach 1,000,000, however perfectly it is played. Runs start at
level 1 for that reason, and the agent says so when it starts.

## Gravity, and why the board stops being reachable

A piece can only be steered while it is in the air, so what matters is the fall time from the spawn
rows down to the stack against the time a key press takes (about one frame):

| Level | Gravity | Lock delay | What that means |
| --- | --- | --- | --- |
| 1 | 1000 ms/row | 500 ms | any placement is reachable |
| 10 | 64 ms/row | 500 ms | still comfortable |
| 14 | 11 ms/row | 500 ms | a piece with 5 rows of air above the stack is resting 55 ms later: about three presses |
| 20-30 | **0 ms/row** | 450 down to **150 ms** | the piece is on the stack in the frame it spawns |

From level 20 gravity is instant. Measured on the live game at level 30: an untouched piece locks
**150 ms** after it appears, and exactly **15** moves land before it locks — moving restarts the lock
timer, but only fifteen times. So a piece can be turned where it stands and walked sideways along the
surface, one column at a time, falling again after every step. It can walk down a slope but never up
one, **so a tall column is a wall**.

`src/reach.ts` models exactly this and only offers placements the piece can actually be brought to.
This is not a level-20 concern: at level 14 the board is already partly closed off, and offering a
column the page cannot reach in time was losing games at level 13 long before 20G. It is also why the
strategy has to keep the surface flat — a placement that leaves the well unreachable for an I piece is
scored as the disaster it is, because once nothing can be cleared the stack rises, and a rising stack
shortens the fall time the walk depends on.

Two consequences for the agent loop:

- **Decisions are made a piece early.** The answer for the next piece is requested while the current
  one is still being placed, and from level 20 the chosen plan is *armed inside the page* so it runs
  on the spawn frame — a round trip to Node plus a model call does not fit in 150 ms. The armed plan
  carries the board it was computed for and refuses to fire if the board did not come out that way.
- **Plans are costed in key presses** and never exceed the fifteen the lock timer allows.
- **The clock is only as tight as the first key.** A piece locks 150 ms after it appears if it is
  left alone, but every press restarts that timer, fifteen times over. So an answer does not have to
  arrive in time for the whole plan, only in time for the first key of it. Budgeting for the whole
  plan left the model 59 ms to answer at level 25 and handed most of the last third of the game to
  the code safety net; budgeting for one key gives it nearly the full lock window.

## Three goals, first one met wins

| Goal | Config key | Flag | Meaning |
| --- | --- | --- | --- |
| Score | `"target-score": 1000000` (alias `score`) | `--target-score 1000000` | Stop the moment a game reaches the score. **The default.** |
| Level | `"target-level": 5` (alias `level`) | `--target-level 5` | Stop the moment a game reaches level 5. |
| Time | `"max-seconds": 120` (alias `play-seconds`) | `--play-seconds 120` | Stop after 120 seconds, whatever the score. |

`0` disables a goal. If a game tops out before the target is met, the agent starts the next one and
keeps trying. `runs` / `--runs` stops after N finished games, and `linger` / `--linger` keeps the
window open a few seconds after a stop.

```bash
node play.ts tetris                                # the default: play until a game scores 1,000,000
node play.ts tetris --play-seconds 300             # or just play for five minutes
node play.ts tetris --target-level 20              # or stop at a level
```

Settings are layered: built-in defaults, then `agent.config.json` in this folder (or `--config <file>`),
then flags. The shipped file:

```json
{
  "target-score": 1000000,
  "target-level": 0,
  "max-seconds": 0,
  "runs": 0,
  "start-level": 1,
  "candidates": 6,
  "linger": 3,
  "ad-block": true
}
```

## Tuning without playing: `--simulate`

A live game takes minutes and answers one question. `src/simulate.ts` plays whole marathons offline
against the real rules — the same scoring table, the same 30 levels, the same gravity per level, the
same reachability limits and the same 7-bag randomizer — in about two seconds each, with no browser
and no API key:

```bash
node src/main.ts --simulate 20
```

```
12 marathons from level 1, played by the code heuristic in 27.5s.

  score          mean 1,000,190   median 1,006,294   best 1,060,892   worst 949,128
  lines          mean 301 of 300
  cleared four at a time   76% of lines
  reached level 30         12 of 12
  reached 1,000,000        7 of 12
```

It is a measuring instrument, not a prediction, and it is wrong in both directions: it is pessimistic
about the decision, because Jev sees the same options with the reasons spelled out and can take the
judgment calls the heuristic gets wrong; and it is optimistic about the hands, because it places every
piece exactly where it meant to, which a browser at 150 ms a lock does not. Use it to compare two
strategies, not to predict a score.

Every strategy change here was measured with it first — including several that looked obviously right
and made the score worse. A surface-shape penalty meant to keep the well walkable cost 5%, because
reachability was already modelled and the extra term just made the stacking worse. It also cannot see
bugs in the hands: it happily reported 300 lines a game while the live agent was dying at level 13,
which is what finally pointed at the executor rather than the strategy.

### What the simulator found

It is also how the shortlist came to be sized the way it is. Measured in live play, Jev takes
something other than the top-ranked option about **40%** of the time — that is the point of asking it.
But the shortlist used to be padded to a fixed six options with deliberately diverse picks, and some
of those were not a different opinion, they were a lost game. Replaying Jev's measured rank
distribution in the simulator:

| Shortlist | Mean score | Marathons completed |
| --- | --- | --- |
| Padded to six, any quality | 278,000 | 0 of 12 |
| Only options within 8 points of the best | **982,000** | 12 of 12 |

So code now guarantees every option on the list is a real contender, and offers **one** option when
only one move is sane rather than manufacturing a choice. Jev still decides, on the decisions that
are decisions.

## When the agent stops playing without stopping the game

Twice during this work the agent stopped placing pieces while the game carried on. It looks exactly
like an ordinary top-out, which is what makes it worth writing down: the pieces fall and lock where
they spawn, the score stops moving, the stack rises two rows a piece, and the game ends. The run
summary says "topout" and the board at the end really is at the ceiling. Nothing errors.

The tell is in `--log`: the scene trace shows `maxH` climbing 3, 5, 7 ... 21 with **`score` frozen**.
A hard drop pays two points a row, so a frozen score means no piece was dropped — they were all
timing out and locking by themselves.

- The first cause was a key budget of `0` passed into the reachability pass, where `0` was read as
  "no presses allowed" rather than "not measured", so no placement was ever reachable. It only bit
  above level 12, because below that the piece has enough air time to skip that code path entirely.
- The second was a result arriving before the plan it belonged to. An armed plan runs on the spawn
  frame, so its result can reach Node in the same snapshot that first shows the piece — before Node
  has adopted the plan. The result was dropped as unknown, and the agent was left holding a plan that
  never finished; for a plan starting with a hold, that wedged the spawn handler permanently.

Both are fixed and covered by tests. But a stall is silent by nature, so there is now also a
watchdog: if no piece is placed for four seconds while a game is running, the agent logs it, clears
its state and re-plans for whatever is on screen. The status line counts it (`stalls`), because a
silent stall that fixes itself is still a bug worth seeing.

## Ads: removed in code

The site shows ads in four places: banner rails down both sides of the page, an AdSense
interstitial over the game area on first load, a click-to-play layer that starts a video, and another
video before every later game. All of them are gone by default (`--no-ad-block` brings them back),
removed by `src/ad-block.ts` in three layers, installed before the page's first byte is parsed. No
browser extension, no filter-list subscription, nothing to install.

1. **Their traffic is blocked.** Every request is matched against a list of ad hosts and URL shapes
   (`matchAdRule`, unit-tested) and aborted: AdSense, GPT, the IMA video SDK, creative hosting, the
   header-bidding exchanges this site sells through, the cookie syncs they fire at each other, and
   Google's anti-ad-blocker wall. The game's own origin is never blocked.
2. **The site's ad callbacks are answered in code.** Blocking alone would leave the game waiting,
   because it only shows its menu once the ad SDKs report back. So the shims answer for them, using
   the page's own protocol:
   - `window.adsbygoogle`, in the game frame, is a queue that answers `adConfig({onReady})` and
     `adBreak({adBreakDone})` at once with "no ad delivered", which is the path the game already
     takes when Google has nothing to show. Its own fallback would spend 6 s waiting first.
   - The preroll handshake is answered in the parent. The game frame posts `gameLoaderComplete`
     (first load) or `playVastPreroll` (later games) and waits for `prerollComplete` /
     `vastPrerollComplete` to come back; the shim replies immediately and stops the message from
     reaching the site's video component, so the click-to-play layer and the video are never created.
   - `window.googletag` is an inert stub, so page and game code that calls into GPT finds the shape
     it expects instead of throwing.
3. **Whatever still reaches the DOM is hidden.** A stylesheet and a MutationObserver keep AdSense
   ins tags, GPT slots, ad iframes, the in-game ad div and Taboola widgets out of the layout, so
   nothing flashes up and no empty boxes are left behind.

Measured against the live site with `--check-ads`, first load to a usable menu and the preroll the
site plays before every later game:

| | Ads removed (default) | `--no-ad-block` |
| --- | --- | --- |
| First menu | 5.5 s, no clicks | 5.0 s, with an 800x600 AdSense interstitial over the game |
| Preroll before a later game | 0.0 s | 34.3 s of video |
| Ad elements on screen | none | 4 banner slots (300x250, 160x600) plus the interstitial |
| Ad requests | 6, all aborted | all of them served |

```bash
node src/main.ts --check-ads                 # what ad removal did, no API key needed
node src/main.ts --check-ads --no-ad-block   # the same page with the ads left in
```

`src/ads.ts` stays in place as the safety net and is what `--no-ad-block` uses: it waits ads out and
closes them with their own close controls, never clicking a creative, and after `--ad-timeout`
seconds tells the page the ad is over through the page's own completion callback. With ad removal on
it has nothing to do, and the session summary says so.

## How the work is split (and why)

Jev is a System One model: it reads text and returns typed judgments with calibrated probabilities.
It cannot see pixels and it is not a calculator. So, as in `flappy-bird`, code reads the game and does
the arithmetic, Jev answers narrow typed questions, and code executes the answer.

| Concern | Who | How |
| --- | --- | --- |
| Seeing the game | code, in the page | The game (a Cocos build of the Tetris engine) publishes its app on `window.mBPSApp`; the injected script reads the matrix, live piece, ghost, hold, queue, score, level, fall speed and the engine's own back-to-back and combo counters every frame, and pushes a snapshot to Node when something changes. |
| The rules | code | `src/score.ts` holds the scoring table, the 30-level table, the per-level gravity and lock delay, and the 15-move lock-reset limit — all read out of the engine, and re-checkable against a live page with `--check-rules`. |
| What is reachable | code | `src/reach.ts` works out how far a piece can be carried through the air at this level and this stack height, and where it can be walked to along the surface after that. Placements the piece cannot be brought to are never offered. |
| Placements | code, in Node | `src/tetris.ts` models the board (SRS shapes, hard drops, line clears) and computes features: heights, holes, wells, bumpiness, transitions, and the tetris well — rows ready for an I, and cells blocking it. Every reachable placement is simulated exactly, then the best reply for each of the next two pieces. |
| Candidates | code | The placements are ranked by a Dellacherie-style heuristic extended with the tetris terms, and the shortlist is everything within a small margin of the best — one option when only one move is sane. Every consequence is written in words: what it pays, what it does to the well and the chain, holes, stack, reachability, risk. |
| **The decision** | **Jev** | One Choice over the shortlist, plus a speculative Choice about the strategic posture (build the well, cash the tetris, repair the surface, survive) that code turns into the heuristic's weights for the next cycle. |
| Timing | code | The next piece's question is asked while the current one is still being placed. From level 20 the answer is *armed inside the page* and runs on the spawn frame, because 150 ms is less than a round trip. An armed plan carries the board it was built on and refuses to fire if the board came out differently. |
| Execution | code, in the page | A plan is "hold, N turns, M steps sideways, hard drop", costed in presses and capped at the fifteen the lock timer allows. The page checks the piece's shape and column after every key and compares the game's own ghost piece with the target before dropping. |
| Verification | code | A placement the simulation shows to be a certain top-out is vetoed. Stale answers, late answers, vetoes, failed executions and off-target drops are all counted in the status line. If the planner ever comes back with nothing, the piece is dropped deliberately and it is logged — silently placing nothing is how a game is lost without anything looking wrong. |

## What it does

Offline, against the real rules, the code heuristic alone (`--simulate 20`):

| | |
| --- | --- |
| Score | mean 1,000,190, median 1,006,294, best 1,060,892, worst 949,128 |
| Lines | 300 of 300 |
| Cleared four at a time | 76% |
| Reached level 30 | 12 of 12 |
| Reached 1,000,000 | 7 of 12 |

Live, the agent places every piece through the browser against the real clock, so it also has to
survive its own hands. The score moved with each thing that was fixed, and every one of them was
found by reading `--log` rather than by tuning:

| Change | Best live game | Reached |
| --- | --- | --- |
| Clearing whatever was available (the old agent) | 43,160 | level 7 |
| Tetris strategy, back-to-back, reachability | 219,704 | level 13 |
| + the key budget of `0` that stopped it placing pieces above level 12 | 525,572 | level 21 |
| + armed plans actually firing (they never had) | 578,818 | level 23 |
| + the armed result that arrived before its plan, and a watchdog for the next one | **950,030** | **level 30, all 300 lines** |

| + the lock timer only has to beat the **first** key, not the whole plan | 896,220 | level 30, 300 lines |

The best live game so far is **950,030**, played to the end of level 30: 300 lines, 679 pieces, about
three and a half minutes, ending because the marathon was finished rather than because the stack
reached the top. Across three sessions of 24 games it completed the marathon seven times, with the
rest dying somewhere in the 20G levels; a typical game lands between 500,000 and 900,000.

Through level 20 the agent plays with **no holes at all** and a stack four to eight rows high. All of
the variance is in the last third.

What it has not done is pass 1,000,000 in a live game. The strategy gets there offline — the same
code, the same rules, median 1,013,286 — so the gap is not the plan but the hands. Live, 63% of lines
are cleared four at a time against 77% in simulation, and that difference is worth roughly the
50,000 points that are missing. It comes from the 20G levels: about 4% of placements land somewhere
other than where they were aimed, and each one that touches the well costs a tetris and the chain
with it.

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
node play.ts tetris                         # per agent.config.json: play until a game scores 1,000,000
node play.ts tetris --play-seconds 300 --log logs/run.jsonl
node play.ts tetris --help
```

Or from inside this folder: `npm start` or `node src/main.ts --help`. A Chrome window opens on the
game (keep it visible: Chrome throttles hidden tabs and the game pauses) and the terminal shows a live
status line:

```
game 1 | play | score 396,034 | level 17 (3 to next) | pieces 425 lines 167 | well c10 ready 1/4 b2b |
need 603,966 (ceiling 937,800) | goal score 1000000 | jev (jev-latest) | rtt 148/205ms | 4.0 req/s |
applied 100% preplanned 421/425 stale 0 late 0 veto 0 err 0 | placed jev 425 code 0 failed 0 off-target 0 |
last option_1 0.89 posture=build_tetris_well
```

- `well c10 ready 1/4 b2b` is the strategy at a glance: which column is being kept open, how close the
  next tetris is, and whether the back-to-back chain that pays for it is still alive.
- `need X (ceiling Y)` is what is left to score against the most that can still be scored. When the
  ceiling drops below what is needed, the target has become unreachable and the run says so.
- `rtt` is the model round trip (p50/p90). `applied` is the share of answers that were used; the rest
  were `stale`. `preplanned a/b` says how many pieces found their answer already waiting.
- `placed jev / code` is who placed the pieces: Jev's answers or the code safety net. `failed` counts
  plans the page could not execute, `off-target` counts pieces that locked somewhere other than the
  plan (possible only once gravity is instant), and `stalls` — if it ever appears — counts times the
  watchdog had to restart the decision loop.
- `posture` is Jev's strategic answer for the next cycle.

### Options worth knowing

| Flag | Default | Meaning |
| --- | --- | --- |
| `--target-score <n>` | 1000000 | Stop when a game reaches this score. |
| `--start-level <n>` | 1 | Level each game starts at. Above about 12 the target stops being reachable at all. |
| `--candidates <n>` | 6 | Most placements Jev chooses between. The shortlist is often shorter: only real contenders are offered. |
| `--timeout <ms>` | 1500 | Per-request model timeout. |
| `--no-preplan` | off | Ask only when a piece has spawned. One round trip on the critical path, and no armed plans. |
| `--no-fallback` | off | Never let code place a piece; the piece falls on its own while waiting. |
| `--key-delay <ms>` | 16 | Delay between key presses. It is also what the reachability model spends the fall time on. |
| `--no-ad-block` | off | Leave the ads in and fall back to waiting them out (see above). |
| `--ad-timeout <s>` | 90 | Safety net only: wait for an ad's own close control this long before the fallback; 0 = forever. |
| `--cdp http://localhost:9222` | | Attach to a Chrome you started with `--remote-debugging-port=9222`. |
| `--log <file>` | | JSON lines: every decision (situation, all candidates, Jev's probabilities and confidence), every execution, every scene change and a summary per game. |
| `--simulate <n>` | | Play N whole marathons offline and report. No browser, no API key. |
| `--check-rules` | | Read the scoring and level rules out of the live game and diff them against `src/score.ts`. |
| `--check-ads` | | Open the game, report what ad removal did and exit. |
| `--print-request` | | Print one complete Jev request for a sample board. Paste it into the [Playground](https://console.typesafe.ai/playground). |

## The questions Jev answers

Everything is already in words, and the arithmetic is done: what the option pays, what it does to the
well and to the chain, and what the game has left. `node src/main.ts --print-request` prints a whole
one. State:

```json
{
  "objective": "score 1,000,000 before the game ends (now 4,120, 995,880 still needed). The game is 30 levels of 10 lines and then it stops, so only 274 more lines will ever be cleared. Clearing every one of them four at a time, back to back, is worth about 1,363,800 from here, so the target is still reachable, but only with tetrises: at level 3 one pays 3,600 and a single pays 300; a top-out ends the game immediately and forfeits every line that is left",
  "situation": {
    "board": { "stack_height": "low: highest column 6 of 20 rows, average 3.8 rows", "surface": "bumpy",
               "holes": "1 buried empty cell in column 9",
               "tetris_well": "column 10 is being kept empty for the I piece; 2 of the 4 rows needed are ready",
               "column_heights_left_to_right": "4,3,4,5,6,5,3,4,4,0" },
    "pieces": { "live": "T", "hold": "empty (holding would swap the live piece for the next one)",
                "next": "I (the straight four-long bar), then Z, then O (the square)" },
    "scoring": { "back_to_back": "the back-to-back chain is ALIVE: the next tetris scores half as much again. Any clear of one, two or three lines breaks it.",
                 "level_pays": "at level 3 a tetris pays 3,600 and a single pays 300" },
    "pace": "level 3: pieces fall at a moderate pace"
  }
}
```

The `placement` Choice spells the economics out rather than assuming the model will infer them:

```
"the_economics": [
  "This game is 30 levels of 10 lines and then it ends, so only 300 lines will ever be cleared. What decides the score is what each line is paid, not how many are cleared.",
  "A tetris pays 800 x level for four rows. A single pays 100 x level for one. Four singles therefore pay a third of what one tetris pays for the same four rows.",
  "Two tetrises in a row with nothing in between pay half as much again for the second one, and every one after it. Clearing one, two or three lines breaks that chain.",
  "So the whole game is: keep one column empty, stack the other nine flat and level, wait for an I piece, and clear four at a time, over and over."
]
```

and every option carries the same fields:

```json
"option_2": { "action": "place the I lying flat",
              "where": "lying flat, columns 1-4 on the left, landing on row 7 from the bottom",
              "points": "scores nothing now, and keeps the back-to-back chain alive for the next tetris",
              "lines": "no line clear",
              "tetris_well": "leaves the well in column 10 as it is; 2 of the 4 rows needed for a tetris are ready afterwards; WASTES THE I PIECE: it is the only piece that scores a tetris, one arrives about every seven pieces, and this spends it somewhere else. Holding it instead costs nothing",
              "holes": "creates no new holes (1 old hole remains)",
              "stack_after": "low (7 of 20 rows), surface slightly uneven",
              "next_piece_outlook": "leaves the following Z no clear without creating a hole",
              "risk": "safe: stack low (7 of 20 rows)" }
```

`posture` (Choice: `build_tetris_well` / `cash_the_tetris` / `repair_surface` / `survive_now`) is asked
in the same request; its answer selects the weight preset code ranks the next shortlist with. The
presets stay close to each other on purpose — an earlier version let `repair_surface` drop the well
discipline, and since one buried hole was enough to select it, the agent spent most of the game in a
posture that happily filled the well.

## Project layout

```
src/main.ts         CLI entry point
src/config.ts       settings: defaults, agent.config.json, flags; the objective in words
src/agent.ts        decision loop: pre-planning, freshness checks, safety net, stop conditions, stats
src/brain-jev.ts    builds the TypeSafe request and calls the SDK
src/score.ts        the game's own scoring, level, gravity and lock rules
src/reach.ts        what a piece can still be brought to, at this gravity and this stack height
src/planner.ts      candidates, the shortlist margin, lookahead, plain-language descriptions, posture weights
src/tetris.ts       board model: shapes, drops, line clears, the tetris well, features, heuristic
src/simulate.ts     whole marathons played offline against the real rules, for tuning
src/page-agent.ts   script injected into the game frame: snapshots, key presses, plan execution, armed plans
src/ad-block.ts     ad removal: blocked hosts, the shims that answer the site's ad callbacks
src/ads.ts          the ad choreography used as the safety net (close controls only, never the creative)
src/browser.ts      Playwright launch/attach, game frame lookup, page wiring
src/hud.ts          status line
test/               node:test suites for the board model, planner and config
```

`npm test` runs the suites and `npm run typecheck` runs `tsc`, here or from the repo root.

## Limits and notes

- The agent reads game state from the game's own engine object (`window.mBPSApp`) and starts games
  through the menu scene's own play action. If the site changes its build, the page script needs
  updating; every access is wrapped so a change shows up as an error message, not a crash. The
  scoring and level rules are hard-coded from that engine, and `--check-rules` re-reads them from a
  live page and diffs them, so a change to the rules shows up as a diff rather than as a strategy
  that has quietly stopped making sense.
- Candidates are hard-drop placements: rotate, walk, drop. Tucks, spins and slides under overhangs
  are not modelled, so Jev never sees them — which also means no T-spins, though a back-to-back
  T-spin single is in fact the best-paying clear in the game at 1,200 x level a row.
- The walk model at speed is deliberately conservative: rotation is assumed to succeed where the
  piece stands (measured: it does), and the column a rotation leaves the piece in is estimated
  within a press or two, with the executor checking the game's own ghost before it drops.
- About a third of armed plans are not used, because the board or the piece at the spawn is not the
  one the plan was built for. It is self-correcting -- that piece is simply planned normally -- but
  above level 24 there is no time for a fresh answer, so those pieces fall to the code safety net
  instead. Why the prediction misses that often is not yet established; the obvious causes (a
  placement landing off target, a stale queue) were checked and account for only a few percent
  between them. Closing it is the clearest remaining win, because it would hand the last third of the
  game back to Jev.
- Cost: about 2,500 input tokens per request and about one request per piece. A full marathon is
  around 750 pieces, so roughly 2M input tokens a game. Check current pricing at
  <https://docs.typesafe.ai/models>.
- High scores stay in the browser profile Playwright creates for the session; nothing is submitted
  anywhere.
