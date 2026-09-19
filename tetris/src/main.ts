#!/usr/bin/env node
/**
 * jev-tetris-agent: plays https://play.tetris.com/ in your Chrome with
 * TypeSafe's Jev model choosing every placement in real time.
 *
 *   npm start                      # Jev plays (needs TYPESAFE_API_KEY)
 *   npm run print-request          # show one Jev request to try in the Playground
 *   node src/main.ts --help
 */
import { parseArgs } from "node:util";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { visibleAdElements } from "./ad-block.ts";
import { AdHandler } from "./ads.ts";
import { Agent, type StopReason } from "./agent.ts";
import { JevBrain, buildJevRequest, describeApiError } from "./brain-jev.ts";
import { connectPageAgent, openGame, type GameSession } from "./browser.ts";
import { describeObjective, describeStopConditions, loadConfigFile, mergeConfig, parseConfigObject, type AgentConfig } from "./config.ts";
import { Hud } from "./hud.ts";
import { describeSituation, planCandidates, type PiecesInPlay } from "./planner.ts";
import { chooseWellColumn, parseBoard, type EvalContext } from "./tetris.ts";
import { BACK_TO_BACK_MULTIPLIER, CLEAR_POINTS, COMBO_POINTS, PERFECT_CLEAR_BACK_TO_BACK_TETRIS, PERFECT_CLEAR_POINTS, HARD_DROP_POINTS_PER_ROW, LINES_PER_LEVEL, MAX_LEVEL, TOTAL_LINES, bestRemainingScore, fallMsForLevel, isTwentyG, lockMsForLevel } from "./score.ts";
import { simulateGame } from "./simulate.ts";

const HELP = `jev-tetris-agent: plays play.tetris.com in your Chrome using TypeSafe's Jev model.

Settings come from built-in defaults, then agent.config.json (or --config <file>), then these flags.

Goals (the first one met ends the session; a game that ends early is restarted)
  --target-level <n>       Stop as soon as a game reaches this level (0 = no target)
  --target-score <n>       Stop as soon as a game reaches this score (0 = no target)
  --play-seconds <s>       Play for this many seconds (alias: --max-seconds; 0 = no limit)
  --runs <n>               Stop after n finished games (0 = unlimited)
  --linger <s>             Keep the game window open this long after stopping (default: 3)

Decision making
  --model <name>           TypeSafe model (default: jev-latest)
  --candidates <n>         Placements Jev chooses between per piece (default: 6)
  --timeout <ms>           Per-request model timeout (default: 1500)
  --latency-guess <ms>     Assumed round trip before measurements exist (default: 250)
  --no-preplan             Do not ask about the next piece while the current one is placed
  --no-fallback            Never let code place a piece (waits for Jev even when late)

Game and browser
  --start-level <n>        Level to start each game at (default: 1; a higher start forfeits the lines the target needs)
  --key-delay <ms>         Delay between key presses (default: 16)
  --no-ad-block            Do not remove ads; wait them out and close them with their own controls instead
  --ad-timeout <s>         Wait this long for an ad's own close control before the fallback (default: 90; 0 = forever)
  --restart-delay <ms>     Pause on the game-over screen before the next game (default: 2000)
  --url <url>              Game URL (default: https://play.tetris.com/)
  --cdp <url>              Attach to a running Chrome, e.g. http://localhost:9222
  --channel <name>         Playwright browser channel to launch (default: chrome)
  --headless               Run without a window (not recommended: the game throttles)

Other
  --config <file>          Settings file (default: agent.config.json if present)
  --log <file>             Append every decision, execution and game summary as JSON lines
  --print-request          Print one Jev request for a sample situation and exit
  --check-key              Validate TYPESAFE_API_KEY by listing models and exit
  --check-ads              Open the game, report what ad removal did and exit (no API key needed)
  --check-rules            Read the scoring and level rules out of the live game and check them against src/score.ts
  --simulate <games>       Play N whole marathons offline against the real rules and report; no browser, no API key
  -h, --help               Show this help
`;

/** Loads the nearest .env: this folder first, then parent folders (the repo root holds the shared key). */
function loadDotEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        /* ignore malformed .env */
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

function sampleRequest(cfg: AgentConfig) {
  const board = parseBoard([
    "..........",
    "..........",
    "....#.....",
    "...###....",
    "#.####.##.",
    "########..",
    "#########.",
    "#########.",
  ]);
  const pieces: PiecesInPlay = { live: "T", hold: null, canHold: true, queue: ["I", "Z", "O"] };
  const context: EvalContext = { wellColumn: chooseWellColumn(board), level: 3, backToBack: true, combo: 0 };
  const candidates = planCandidates({ board, pieces, count: cfg.candidates, context });
  return buildJevRequest({
    pieceKey: "sample",
    situation: describeSituation(board, pieces, { level: 3, fallMsPerRow: 620 }, context),
    objective: describeObjective(cfg, { level: 3, score: 4120, linesToNextLevel: 4, secondsLeft: cfg.maxSeconds > 0 ? cfg.maxSeconds : null, backToBack: true }),
    candidates,
    pieces,
    context,
  });
}

/**
 * Opens the game and reports what ad removal did: what was blocked, how long
 * the first menu took, whether anything ad-shaped is still on screen, and how
 * the preroll the site plays before every later game was dealt with. Needs no
 * API key, so it can be run on its own (`--check-ads --no-ad-block` measures
 * the same page with ad removal turned off).
 */
async function checkAds(cfg: AgentConfig): Promise<void> {
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  const started = Date.now();
  const since = (t: number): string => `${((Date.now() - t) / 1000).toFixed(1)}s`;
  out(`Opening ${cfg.url} with ad removal ${cfg.adBlock ? "on" : "off"}...`);
  let session: GameSession | null = null;
  try {
    session = await openGame({ url: cfg.url, cdpUrl: cfg.cdp, channel: cfg.channel, headless: cfg.headless, width: 1080, height: 820, blockAds: cfg.adBlock });
    const page = session.page;
    const milestones: string[] = [];
    page.on("console", (m) => {
      const t = m.text();
      if (/\[Game\]|\[TetrisGame\]|\[VastPreroll\]/.test(t)) milestones.push(`  ${since(started).padStart(6)}  ${t.slice(0, 96)}`);
    });
    const control = await connectPageAgent(page, { pushIntervalMs: 500, keyDelayMs: cfg.keyDelay }, () => {});
    // The old choreography runs either way, so both modes get the same help;
    // with ad removal on it should have nothing left to do.
    const ads = new AdHandler(page, control, { adTimeoutMs: cfg.adTimeout * 1000, adsRemoved: cfg.adBlock });

    let menuAt: number | null = null;
    while (Date.now() - started < 120_000) {
      await ads.tick();
      if ((await control.sceneName()) === "mainMenu") {
        menuAt = Date.now();
        break;
      }
      await page.waitForTimeout(250);
    }
    out(menuAt === null ? "\nThe main menu was not reached within 120s." : `\nMain menu reached after ${((menuAt - started) / 1000).toFixed(1)}s, with no clicks on any ad.`);

    // The preroll the site plays before every later game, triggered the way
    // the game itself triggers it.
    if (menuAt !== null) {
      const askedAt = Date.now();
      let doneAt: number | null = null;
      page.on("console", (m) => {
        if (doneAt === null && /\[Game\] Preroll complete, showing game menu/.test(m.text())) doneAt = Date.now();
      });
      await control.frame().evaluate(() => window.showGameAreaAd?.("next")).catch(() => {});
      while (doneAt === null && Date.now() - askedAt < 90_000) {
        await ads.tick();
        await page.waitForTimeout(200);
      }
      out(doneAt === null ? "Preroll before a later game: still not over after 90s." : `Preroll before a later game: over in ${(((doneAt as number) - askedAt) / 1000).toFixed(1)}s.`);
    }

    const visible = await visibleAdElements(page);
    out(visible.length === 0 ? "No ad element is visible anywhere in the page." : `Still visible: ${visible.map((v) => `${v.what} (${v.frame})`).join(", ")}`);
    if (session.adBlock) {
      const report = await session.adBlock.report(page);
      out(session.adBlock.describe(report));
      for (const h of report.hosts.slice(0, 12)) out(`  blocked ${String(h.count).padStart(3)} x ${h.host} (${h.rule})`);
    } else {
      out("Ad removal was off, so nothing was blocked.");
    }
    out(`The site's own ad controls used: interstitials closed ${ads.status.interstitialsClosed}, click-to-play ${ads.status.overlaysClicked}, skips ${ads.status.skipsClicked}, fallbacks ${ads.status.fallbacks}.`);
    if (milestones.length > 0) out(`\nWhat the page reported:\n${milestones.join("\n")}`);
  } finally {
    await session?.close();
  }
}

/**
 * Reads the scoring and level rules out of the live game and compares them
 * with the table in `src/score.ts`. Those numbers decide the whole strategy,
 * so this is how they are kept honest if the site ever changes them. Needs no
 * API key.
 */
async function checkRules(cfg: AgentConfig): Promise<void> {
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  let session: GameSession | null = null;
  try {
    session = await openGame({ url: cfg.url, cdpUrl: cfg.cdp, channel: cfg.channel, headless: cfg.headless, width: 1080, height: 820, blockAds: cfg.adBlock });
    const control = await connectPageAgent(session.page, { pushIntervalMs: 500, keyDelayMs: cfg.keyDelay }, () => {});
    const started = Date.now();
    while (Date.now() - started < 120_000 && (await control.sceneName()) !== "mainMenu") await session.page.waitForTimeout(250);
    const frame = control.frame();
    await frame.evaluate(() => {
      const s = (window as unknown as { mBPSApp: any }).mBPSApp.getSceneMgr().getCurrentScene();
      if (typeof s.setStartingLevelIndex === "function") s.setStartingLevelIndex(0);
      s.performPlay(false);
    });
    await session.page.waitForTimeout(4000);
    const live = await frame.evaluate(() => {
      const sm = (window as unknown as { mBPSApp: any }).mBPSApp.getSceneMgr();
      const pl = sm.getManagedScene("game").getGameMgr().getGame().getPlayerAtIndex(0);
      let score: any = null;
      let levels: any = null;
      for (let i = 0; i < pl.getNumComponents(); i++) {
        const c = pl.getComponentAtIndex(i);
        if (typeof c.getScore === "function") score = c;
        else if (typeof c.getCurrentLevelIndex === "function") levels = c;
      }
      // A params object keeps its entries as {mKeyString, mValue} pairs.
      const flat = (p: any): Record<string, unknown> => {
        const o: Record<string, unknown> = {};
        for (const e of p?.mValues?.mObjects ?? []) o[e.mKeyString || `key:${e.mKey}`] = e.mValue;
        return o;
      };
      const table: { level: number; fallMs: number; lockMs: number; goal: number }[] = [];
      for (let i = 0; i < 40; i++) {
        const p = levels.getLevelParams(i);
        if (!p) break;
        const f = flat(p);
        const end = flat(p.mValues.mObjects.find((e: any) => e.mKeyString === "endCondition")?.mValue);
        table.push({ level: i + 1, fallMs: Number(f.normalFallSpeedMSECPerLine), lockMs: Number(f.lockTimeMSEC), goal: Number(end.targetValue) });
        if (String(f.id) === String(flat(levels.mParams).maxLevelId)) break;
      }
      return { scoring: flat(score.mParams), levelRules: flat(levels.mParams), table };
    });

    const scoring = live.scoring as Record<string, number | boolean>;
    const rules = live.levelRules as Record<string, unknown>;
    const checks: { what: string; live: unknown; ours: unknown }[] = [
      { what: "single", live: scoring.scoreForSingle, ours: CLEAR_POINTS[1] },
      { what: "double", live: scoring.scoreForDouble, ours: CLEAR_POINTS[2] },
      { what: "triple", live: scoring.scoreForTriple, ours: CLEAR_POINTS[3] },
      { what: "tetris", live: scoring.scoreForTetris, ours: CLEAR_POINTS[4] },
      { what: "back-to-back multiplier", live: Number(scoring.backToBackBonusMultiplierFXPT) / 1000, ours: BACK_TO_BACK_MULTIPLIER },
      { what: "combo", live: scoring.scoreForComboClear, ours: COMBO_POINTS },
      { what: "perfect clear, tetris", live: scoring.scoreForPerfectClearTetris, ours: PERFECT_CLEAR_POINTS[4] },
      { what: "perfect clear, b2b tetris", live: scoring.scoreForPerfectClearBackToBackTetris, ours: PERFECT_CLEAR_BACK_TO_BACK_TETRIS },
      { what: "hard drop per row", live: scoring.scoreForHardDropStep, ours: HARD_DROP_POINTS_PER_ROW },
      { what: "score x level", live: rules.multiplyScoreByLevel, ours: true },
      { what: "max level", live: Number(rules.maxLevelId), ours: MAX_LEVEL },
      { what: "game ends at max level", live: rules.endGameAtMaxLevelCompletion, ours: true },
      { what: "levels in the table", live: live.table.length, ours: MAX_LEVEL },
      { what: "lines per level", live: live.table[0]?.goal, ours: LINES_PER_LEVEL },
      { what: "first level with instant gravity", live: live.table.find((r) => r.fallMs <= 0)?.level, ours: live.table.find((r) => isTwentyG(r.level))?.level },
    ];
    let bad = 0;
    for (const c of checks) {
      const ok = String(c.live) === String(c.ours);
      if (!ok) bad++;
      out(`${ok ? "ok  " : "DIFF"}  ${c.what.padEnd(32)} live ${String(c.live).padStart(8)}   src/score.ts ${String(c.ours).padStart(8)}`);
    }
    let tableBad = 0;
    for (const r of live.table) {
      if (fallMsForLevel(r.level) !== r.fallMs || lockMsForLevel(r.level) !== r.lockMs) {
        tableBad++;
        out(`DIFF  level ${String(r.level).padStart(2)}  live fall ${r.fallMs}ms lock ${r.lockMs}ms   src/score.ts fall ${fallMsForLevel(r.level)}ms lock ${lockMsForLevel(r.level)}ms`);
      }
    }
    out("");
    out(tableBad === 0 ? `The per-level fall speeds and lock times match for all ${live.table.length} levels.` : `${tableBad} level row(s) differ.`);
    out(bad === 0 && tableBad === 0
      ? `Everything matches. Perfect back-to-back tetris play from level 1 is worth ${bestRemainingScore(1, LINES_PER_LEVEL, false).toLocaleString("en-US")}.`
      : `${bad + tableBad} difference(s): src/score.ts needs updating, and the strategy with it.`);
  } finally {
    await session?.close();
  }
}

/**
 * Plays whole marathons offline with the code heuristic, against the real
 * rules, and reports. This is how the strategy is tuned: a live game takes
 * minutes and answers one question, a hundred of these take a minute and
 * answer the question properly. It is a lower bound on the agent -- Jev sees
 * the same options with the reasons spelled out, and can take the judgment
 * calls the heuristic gets wrong.
 */
function runSimulation(games: number, cfg: AgentConfig): void {
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  const n = (v: number): string => Math.round(v).toLocaleString("en-US");
  const started = Date.now();
  const results = Array.from({ length: games }, (_, i) => simulateGame({ seed: 1 + i * 7919, startLevel: cfg.startLevel, candidates: cfg.candidates }));
  const scores = results.map((r) => r.score).sort((a, b) => a - b);
  const mean = scores.reduce((a, v) => a + v, 0) / games;
  const share = results.reduce((a, r) => a + r.tetrisShare, 0) / games;
  const completed = results.filter((r) => r.endedBy === "complete").length;
  const hit = results.filter((r) => r.score >= cfg.targetScore).length;
  out(`${games} marathon${games === 1 ? "" : "s"} from level ${cfg.startLevel}, played by the code heuristic in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  out("");
  out(`  score          mean ${n(mean)}   median ${n(scores[Math.floor(games / 2)])}   best ${n(scores[games - 1])}   worst ${n(scores[0])}`);
  out(`  lines          mean ${n(results.reduce((a, r) => a + r.lines, 0) / games)} of ${TOTAL_LINES}`);
  out(`  cleared four at a time   ${(100 * share).toFixed(0)}% of lines`);
  out(`  reached level 30         ${completed} of ${games}`);
  if (cfg.targetScore > 0) out(`  reached ${n(cfg.targetScore)}        ${hit} of ${games}`);
  const died = results.filter((r) => r.endedBy !== "complete");
  if (died.length > 0) {
    const levels = died.map((r) => r.diedAtLevel).sort((a, b) => a - b);
    out(`  games that ended early   ${died.length}, at levels ${levels.join(", ")}`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      candidates: { type: "string" },
      timeout: { type: "string" },
      "latency-guess": { type: "string" },
      "no-preplan": { type: "boolean" },
      "no-fallback": { type: "boolean" },
      runs: { type: "string" },
      "max-seconds": { type: "string" },
      "play-seconds": { type: "string" },
      "target-score": { type: "string" },
      "target-level": { type: "string" },
      linger: { type: "string" },
      "start-level": { type: "string" },
      "key-delay": { type: "string" },
      "ad-timeout": { type: "string" },
      "no-ad-block": { type: "boolean" },
      "restart-delay": { type: "string" },
      url: { type: "string" },
      cdp: { type: "string" },
      channel: { type: "string" },
      headless: { type: "boolean" },
      config: { type: "string" },
      log: { type: "string" },
      "print-request": { type: "boolean", default: false },
      "check-key": { type: "boolean", default: false },
      "check-ads": { type: "boolean", default: false },
      "check-rules": { type: "boolean", default: false },
      simulate: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowNegative: false,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const configPath = values.config ?? (existsSync("agent.config.json") ? "agent.config.json" : undefined);
  const fileConfig = configPath ? loadConfigFile(configPath) : {};
  const cliRaw: Record<string, unknown> = {
    model: values.model,
    candidates: values.candidates,
    timeout: values.timeout,
    "latency-guess": values["latency-guess"],
    preplan: values["no-preplan"] ? false : undefined,
    fallback: values["no-fallback"] ? false : undefined,
    runs: values.runs,
    "max-seconds": values["play-seconds"] ?? values["max-seconds"],
    "target-score": values["target-score"],
    "target-level": values["target-level"],
    linger: values.linger,
    "start-level": values["start-level"],
    "key-delay": values["key-delay"],
    "ad-timeout": values["ad-timeout"],
    "ad-block": values["no-ad-block"] ? false : undefined,
    "restart-delay": values["restart-delay"],
    url: values.url,
    cdp: values.cdp,
    channel: values.channel,
    headless: values.headless,
    log: values.log,
  };
  const cfg: AgentConfig = mergeConfig(fileConfig, parseConfigObject(cliRaw, "command line"));

  if (values["print-request"]) {
    process.stdout.write(JSON.stringify({ model: cfg.model ?? "jev-latest", ...sampleRequest(cfg) }, null, 2) + "\n");
    return;
  }

  if (values["check-ads"]) {
    await checkAds(cfg);
    return;
  }

  if (values["check-rules"]) {
    await checkRules(cfg);
    return;
  }

  if (values.simulate !== undefined) {
    const games = Number(values.simulate);
    if (!Number.isFinite(games) || games < 1) throw new Error("--simulate needs a number of games");
    runSimulation(Math.floor(games), cfg);
    return;
  }

  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("TYPESAFE_API_KEY is not set. Put it in the repo root .env (see .env.example) or the environment.");
  const brain = new JevBrain({ model: cfg.model, timeoutMs: cfg.timeout });
  if (values["check-key"]) {
    const models = await brain.listModels();
    console.log(`API key OK. Models available: ${models.join(", ")}`);
    return;
  }

  if (cfg.log) mkdirSync(dirname(cfg.log), { recursive: true });
  const logStream = cfg.log ? createWriteStream(cfg.log, { flags: "a" }) : null;
  const log = logStream ? (event: Record<string, unknown>): void => void logStream.write(JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n") : undefined;

  const hud = new Hud();
  hud.println(`Settings: ${configPath ? `${configPath} + flags` : "defaults + flags"}. ${describeStopConditions(cfg)}. Games start at level ${cfg.startLevel}.`);
  // The score is bounded by the 300 lines the game lasts, so say up front
  // whether the target is reachable from where this run starts.
  if (cfg.targetScore > 0) {
    const ceiling = bestRemainingScore(cfg.startLevel, LINES_PER_LEVEL, false);
    hud.println(
      `Marathon is ${MAX_LEVEL} levels of ${LINES_PER_LEVEL} lines and then it ends. From level ${cfg.startLevel}, clearing every remaining line four at a time back to back is worth ${ceiling.toLocaleString("en-US")}, ` +
        (ceiling >= cfg.targetScore
          ? `so ${cfg.targetScore.toLocaleString("en-US")} needs about ${Math.round((100 * cfg.targetScore) / ceiling)}% of perfect tetris play.`
          : `so ${cfg.targetScore.toLocaleString("en-US")} cannot be reached from this starting level -- start at level 1 for the full 300 lines.`),
    );
  }
  hud.println(
    `Opening ${cfg.url} in ${cfg.cdp ? `Chrome at ${cfg.cdp}` : `Google Chrome (${cfg.channel})`}... ` +
      (cfg.adBlock
        ? "Ads are removed: their traffic is blocked and the site's own ad callbacks are answered in code."
        : "Ad removal is off: ads are waited out and closed with their own controls, never clicked."),
  );
  const session = await openGame({ url: cfg.url, cdpUrl: cfg.cdp, channel: cfg.channel, headless: cfg.headless, width: 1080, height: 820, blockAds: cfg.adBlock, log });

  let agent: Agent | null = null;
  const control = await connectPageAgent(session.page, { pushIntervalMs: 250, keyDelayMs: cfg.keyDelay }, (snap) => agent?.onSnapshot(snap));
  const ads = new AdHandler(session.page, control, { adTimeoutMs: cfg.adTimeout * 1000, adsRemoved: cfg.adBlock, log });
  agent = new Agent(control, ads, { brain, config: cfg, postureConfidenceFloor: 0.5, log });
  hud.println(`Brain: ${brain.name}. Keep the game window visible; press Ctrl+C to stop.`);
  hud.start(() => agent!.status());

  const stopText = (reason: StopReason | null): string => {
    switch (reason) {
      case "target-level":
        return `Stopped: reached the target level of ${cfg.targetLevel}.`;
      case "target-score":
        return `Stopped: reached the target score of ${cfg.targetScore}.`;
      case "time-limit":
        return `Stopped: the ${cfg.maxSeconds}s time limit is up.`;
      case "runs":
        return `Stopped: ${cfg.runs} game(s) finished.`;
      case "fatal":
        return "Stopped: unrecoverable error.";
      default:
        return "Stopped by request.";
    }
  };

  let closing = false;
  const shutdown = async (reason: StopReason | null): Promise<void> => {
    if (closing) return;
    closing = true;
    agent?.stop(reason ?? "manual");
    hud.stop();
    const st = agent?.status();
    if (st) {
      const runs = st.runs;
      const best = runs.reduce((m, r) => Math.max(m, r.score), 0);
      hud.println(stopText(st.stopReason ?? reason));
      const [singles, doubles, triples, tetrises] = st.stats.clears;
      const linesFromTetrises = tetrises * 4;
      const linesCleared = singles + doubles * 2 + triples * 3 + linesFromTetrises;
      hud.println(
        `Games: ${runs.length} (${runs.map((r) => `score ${r.score.toLocaleString("en-US")} / level ${r.level} / ${r.lines} lines${r.endedBy === "complete" ? " (whole marathon)" : ""}`).join("; ") || "none"}), best score ${best.toLocaleString("en-US")}.`,
      );
      // The one number that says whether the strategy worked: what share of the
      // lines were cleared four at a time.
      hud.println(
        `Clears: ${tetrises} tetris, ${triples} triple, ${doubles} double, ${singles} single` +
          `${linesCleared > 0 ? ` -- ${Math.round((100 * linesFromTetrises) / linesCleared)}% of the ${linesCleared} lines came four at a time` : ""}.`,
      );
      hud.println(
        `Jev answers ${st.stats.answers}, applied ${st.stats.applied} (pre-planned ${st.stats.preplanHits}), stale ${st.stats.stale}, late ${st.stats.late}, vetoed ${st.stats.vetoed}, ` +
          `errors ${st.stats.errors}, input tokens ${st.stats.inputTokens}. Pieces placed by Jev ${st.stats.placedByJev}, by code ${st.stats.placedByCode}, failed executions ${st.stats.execFailed}, off target ${st.stats.offTarget}. ` +
          `Ads handled by the safety net: interstitials closed ${ads.status.interstitialsClosed}, click-to-play ${ads.status.overlaysClicked}, skips ${ads.status.skipsClicked}, fallbacks ${ads.status.fallbacks}.`,
      );
      if (session.adBlock) {
        const report = await session.adBlock.report(session.page).catch(() => null);
        if (report) hud.println(session.adBlock.describe(report));
      }
    }
    logStream?.end();
    if (reason !== "manual" && cfg.linger > 0 && !session.attached) {
      hud.println(`Closing the game window in ${cfg.linger}s...`);
      await new Promise((resolve) => setTimeout(resolve, cfg.linger * 1000));
    }
    await session.close();
  };
  process.once("SIGINT", () => void shutdown("manual").finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("manual").finally(() => process.exit(0)));

  await agent.start();
  if (agent.fatal) {
    hud.println(`Fatal: ${describeApiError(agent.fatal).message}`);
    process.exitCode = 1;
  }
  await shutdown(agent.stopReason);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
