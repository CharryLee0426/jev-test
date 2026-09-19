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
import { parseBoard } from "./tetris.ts";

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
  --start-level <n>        Level to start each game at (default: 1)
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
  const candidates = planCandidates({ board, pieces, count: cfg.candidates });
  return buildJevRequest({
    pieceKey: "sample",
    situation: describeSituation(board, pieces, { level: 3, fallMsPerRow: 620 }),
    objective: describeObjective(cfg, { level: 3, score: 4120, linesToNextLevel: 4, secondsLeft: cfg.maxSeconds > 0 ? cfg.maxSeconds : null }),
    candidates,
    pieces,
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
      hud.println(
        `Games: ${runs.length} (${runs.map((r) => `score ${r.score} / level ${r.level} / ${r.lines} lines`).join("; ") || "none"}), best score ${best}. ` +
          `Jev answers ${st.stats.answers}, applied ${st.stats.applied} (pre-planned ${st.stats.preplanHits}), stale ${st.stats.stale}, late ${st.stats.late}, vetoed ${st.stats.vetoed}, ` +
          `errors ${st.stats.errors}, input tokens ${st.stats.inputTokens}. Pieces placed by Jev ${st.stats.placedByJev}, by code ${st.stats.placedByCode}, failed executions ${st.stats.execFailed}. ` +
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
