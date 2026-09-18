#!/usr/bin/env node
/**
 * jev-flappy-agent: plays https://flappybird.io/ in your Chrome with
 * TypeSafe's Jev model choosing every maneuver in real time.
 *
 *   npm start                      # Jev brain (needs TYPESAFE_API_KEY)
 *   npm run print-request          # show one Jev request to try in the Playground
 *   node src/main.ts --help
 */
import { parseArgs } from "node:util";
import { createWriteStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Agent, type StopReason } from "./agent.ts";
import { JevBrain, buildJevRequest, describeApiError } from "./brain-jev.ts";
import { connectPageAgent, openGame } from "./browser.ts";
import { describeStopConditions, loadConfigFile, mergeConfig, parseConfigObject, type AgentConfig } from "./config.ts";
import { Hud } from "./hud.ts";
import { fx, type SimState } from "./physics.ts";
import { describeSituation, forecastManeuvers } from "./planner.ts";

const HELP = `jev-flappy-agent: plays flappybird.io in your Chrome using TypeSafe's Jev model.

Settings come from built-in defaults, then agent.config.json (or --config <file>), then these flags.

Stop conditions (the first one met ends the session)
  --play-seconds <s>       Play for this many seconds (alias: --max-seconds; 0 = no limit)
  --target-score <n>       Stop as soon as a run reaches this score (0 = no target)
  --runs <n>               Stop after n finished runs (0 = unlimited)
  --linger <s>             Keep the game window open this long after stopping (default: 3)

Decision making
  --model <name>           TypeSafe model (default: jev-latest)
  --interval <ms>          Decision cadence (default: 100)
  --in-flight <n>          Max concurrent model requests (default: 3)
  --timeout <ms>           Per-request model timeout (default: 1500)
  --latency-guess <ms>     Assumed round trip before measurements exist (default: 250)
  --no-fallback            Disable the in-page hover fallback (bird only flaps on model plans)

Game and browser
  --ranked                 Let runs count for the site's leaderboard (default: off, runs are unranked)
  --start-delay <ms>       Pause on the ready screen before starting (default: 800)
  --restart-delay <ms>     Pause on the game-over screen before restarting (default: 2500)
  --url <url>              Game URL (default: https://flappybird.io/)
  --cdp <url>              Attach to a running Chrome, e.g. http://localhost:9222
  --channel <name>         Playwright browser channel to launch (default: chrome)
  --headless               Run without a window (not recommended: rAF throttling)

Other
  --config <file>          Settings file (default: agent.config.json if present)
  --log <file>             Append every decision and run summary as JSON lines
  --print-request          Print one Jev request for a sample situation and exit
  --check-key              Validate TYPESAFE_API_KEY by listing models and exit
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

function sampleState(): SimState {
  // Mid-run: standard gap 0.35 units ahead, following gap much higher, bird slightly low and starting to fall.
  return {
    phase: "play",
    birdY: fx(0.16),
    birdVy: fx(-0.4),
    pipes: [
      { x: fx(0.35), gapY: fx(0.2), halfGap: fx(0.235), passed: false },
      { x: fx(1.35), gapY: fx(0.55), halfGap: fx(0.235), passed: false },
    ],
    score: 7,
    playStep: 2400,
    spawnCount: 8,
    simVersion: 4,
    deathCause: null,
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      interval: { type: "string" },
      "in-flight": { type: "string" },
      timeout: { type: "string" },
      "latency-guess": { type: "string" },
      runs: { type: "string" },
      "max-seconds": { type: "string" },
      "play-seconds": { type: "string" },
      "target-score": { type: "string" },
      linger: { type: "string" },
      ranked: { type: "boolean" },
      "no-fallback": { type: "boolean" },
      "start-delay": { type: "string" },
      "restart-delay": { type: "string" },
      url: { type: "string" },
      cdp: { type: "string" },
      channel: { type: "string" },
      headless: { type: "boolean" },
      config: { type: "string" },
      log: { type: "string" },
      "print-request": { type: "boolean", default: false },
      "check-key": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowNegative: false,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  // Layer 2: the config file. Layer 3: flags, which use the same names.
  const configPath = values.config ?? (existsSync("agent.config.json") ? "agent.config.json" : undefined);
  const fileConfig = configPath ? loadConfigFile(configPath) : {};
  const cliRaw: Record<string, unknown> = {
    model: values.model,
    interval: values.interval,
    "in-flight": values["in-flight"],
    timeout: values.timeout,
    "latency-guess": values["latency-guess"],
    runs: values.runs,
    "max-seconds": values["play-seconds"] ?? values["max-seconds"],
    "target-score": values["target-score"],
    linger: values.linger,
    ranked: values.ranked,
    fallback: values["no-fallback"] ? false : undefined,
    "start-delay": values["start-delay"],
    "restart-delay": values["restart-delay"],
    url: values.url,
    cdp: values.cdp,
    channel: values.channel,
    headless: values.headless,
    log: values.log,
  };
  const cfg: AgentConfig = mergeConfig(fileConfig, parseConfigObject(cliRaw, "command line"));

  const hasKey = Boolean(process.env.TYPESAFE_API_KEY?.trim());

  if (values["print-request"]) {
    const state = sampleState();
    const earliestStep = state.playStep + 15;
    const forecasts = forecastManeuvers({ state, earliestStep, committedFlaps: [] });
    const req = buildJevRequest({ builtAtStep: state.playStep, earliestStep, situation: describeSituation(state), forecasts, state });
    process.stdout.write(JSON.stringify({ model: cfg.model ?? "jev-latest", ...req }, null, 2) + "\n");
    return;
  }

  if (!hasKey) throw new Error("TYPESAFE_API_KEY is not set. Put it in the repo root .env (see .env.example) or the environment.");
  const brain = new JevBrain({ model: cfg.model, timeoutMs: cfg.timeout });
  if (values["check-key"]) {
    const models = await brain.listModels();
    console.log(`API key OK. Models available: ${models.join(", ")}`);
    return;
  }

  const logStream = cfg.log ? createWriteStream(cfg.log, { flags: "a" }) : null;
  const log = logStream ? (event: Record<string, unknown>): void => void logStream.write(JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n") : undefined;

  const hud = new Hud();
  hud.println(`Settings: ${configPath ? `${configPath} + flags` : "defaults + flags"}. ${describeStopConditions(cfg)}.`);
  hud.println(`Opening ${cfg.url} in ${cfg.cdp ? `Chrome at ${cfg.cdp}` : `Google Chrome (${cfg.channel})`}...`);
  const session = await openGame({
    url: cfg.url,
    cdpUrl: cfg.cdp,
    channel: cfg.channel,
    headless: cfg.headless,
    width: 520,
    height: 860,
  });

  let agent: Agent | null = null;
  const control = await connectPageAgent(session.page, (snap) => agent?.onSnapshot(snap));
  agent = new Agent(control, {
    brain,
    intervalMs: cfg.interval,
    maxInFlight: Math.max(1, cfg.inFlight),
    ranked: cfg.ranked,
    runs: cfg.runs,
    maxSeconds: cfg.maxSeconds,
    targetScore: cfg.targetScore,
    restartDelayMs: cfg.restartDelay,
    startDelayMs: cfg.startDelay,
    fallbackEnabled: cfg.fallback,
    latencyGuessMs: cfg.latencyGuess,
    lineConfidenceFloor: 0.5,
    log,
  });
  hud.println(`Brain: ${brain.name}. Runs are ${cfg.ranked ? "RANKED (leaderboard)" : "unranked"}. Keep the game window visible; press Ctrl+C to stop.`);
  hud.start(() => agent!.status());

  const stopText = (reason: StopReason | null): string => {
    switch (reason) {
      case "target-score":
        return `Stopped: reached the target score of ${cfg.targetScore}.`;
      case "time-limit":
        return `Stopped: the ${cfg.maxSeconds}s time limit is up.`;
      case "runs":
        return `Stopped: ${cfg.runs} run(s) finished.`;
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
      const best = Math.max(runs.reduce((m, r) => Math.max(m, r.score), 0), st.phase === "play" ? st.score : 0);
      const current = st.phase === "play" ? ` Run ${st.run} was still going at score ${st.score}.` : "";
      hud.println(stopText(st.stopReason ?? reason));
      hud.println(
        `Runs finished: ${runs.length}, best score ${best}, scores [${runs.map((r) => r.score).join(", ")}].${current} ` +
          `Model answers ${st.stats.answers}, applied ${st.stats.applied}, stale/rejected ${st.stats.stale + st.stats.rejected}, ` +
          `vetoed ${st.stats.vetoed}, cancelled ${st.stats.cancelled}, errors ${st.stats.errors}, input tokens ${st.stats.inputTokens}.`,
      );
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
