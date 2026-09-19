/**
 * Agent settings, resolved from three layers: built-in defaults, an optional
 * JSON config file (agent.config.json by default), and CLI flags. Later
 * layers win. File keys may be written kebab-case like the CLI flags
 * ("target-level") or camelCase ("targetLevel").
 */
import { readFileSync } from "node:fs";
import { MAX_LEVEL, bestRemainingScore, clearScore, linesLeftInGame } from "./score.ts";

export interface AgentConfig {
  model?: string;
  /** Stop as soon as a game reaches this level (the level shown in the game, 1-based); 0 = no target. */
  targetLevel: number;
  /** Stop as soon as a game reaches this score; 0 = no target. */
  targetScore: number;
  /** Stop after this many seconds of session time; 0 = no limit. */
  maxSeconds: number;
  /** Stop after this many finished games; 0 = unlimited. */
  runs: number;
  /** Seconds to keep the game window open after a stop condition is met. */
  linger: number;
  /** Level to start each game at (as shown in the game, 1-based). */
  startLevel: number;
  /** How many candidate placements Jev chooses between. */
  candidates: number;
  /** Per-request model timeout in ms. */
  timeout: number;
  /** Assumed round trip in ms before measurements exist. */
  latencyGuess: number;
  /** Ask Jev about the next piece while the current one is still being placed. */
  preplan: boolean;
  /** Code places the piece itself when Jev's answer is late or failed. */
  fallback: boolean;
  /** Milliseconds between key presses sent to the game. */
  keyDelay: number;
  /** Seconds to wait for an ad's own close control before the fallback that tells the page the ad is over; 0 = wait forever. */
  adTimeout: number;
  /** Remove ads in code: block their traffic and answer the site's ad callbacks (see ad-block.ts). */
  adBlock: boolean;
  /** Pause on the game-over screen before starting the next game, in ms. */
  restartDelay: number;
  url: string;
  /** Attach to a running Chrome (http://localhost:9222) instead of launching one. */
  cdp?: string;
  channel: string;
  headless: boolean;
  /** JSON-lines log of every decision and game summary. */
  log?: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  targetLevel: 0,
  targetScore: 1_000_000,
  maxSeconds: 0,
  runs: 0,
  linger: 3,
  startLevel: 1,
  candidates: 6,
  timeout: 1500,
  latencyGuess: 250,
  preplan: true,
  fallback: true,
  keyDelay: 16,
  adTimeout: 90,
  adBlock: true,
  restartDelay: 2000,
  url: "https://play.tetris.com/",
  channel: "chrome",
  headless: false,
};

const NUMBER_KEYS = new Set<keyof AgentConfig>([
  "targetLevel", "targetScore", "maxSeconds", "runs", "linger", "startLevel", "candidates", "timeout", "latencyGuess", "keyDelay", "adTimeout", "restartDelay",
]);
const BOOLEAN_KEYS = new Set<keyof AgentConfig>(["preplan", "fallback", "headless", "adBlock"]);
const STRING_KEYS = new Set<keyof AgentConfig>(["model", "url", "cdp", "channel", "log"]);
/** Aliases accepted in files and on the CLI. */
const ALIASES: Record<string, keyof AgentConfig> = {
  playSeconds: "maxSeconds",
  seconds: "maxSeconds",
  time: "maxSeconds",
  score: "targetScore",
  level: "targetLevel",
  games: "runs",
  blockAds: "adBlock",
};

/** "target-level" -> "targetLevel"; camelCase passes through. */
export function normalizeKey(key: string): string {
  const camel = key.trim().replace(/[-_]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
  return ALIASES[camel] ?? camel;
}

export function parseConfigObject(raw: unknown, source: string): Partial<AgentConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${source}: expected a JSON object`);
  const out: Partial<AgentConfig> = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (rawKey.startsWith("_") || rawKey === "$schema") continue; // comments
    const key = normalizeKey(rawKey) as keyof AgentConfig;
    if (value === null || value === undefined) continue;
    if (NUMBER_KEYS.has(key)) {
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`${source}: "${rawKey}" must be a non-negative number`);
      (out as Record<string, unknown>)[key] = n;
    } else if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== "boolean") throw new Error(`${source}: "${rawKey}" must be true or false`);
      (out as Record<string, unknown>)[key] = value;
    } else if (STRING_KEYS.has(key)) {
      if (typeof value !== "string") throw new Error(`${source}: "${rawKey}" must be a string`);
      (out as Record<string, unknown>)[key] = value;
    } else {
      throw new Error(`${source}: unknown setting "${rawKey}"`);
    }
  }
  return out;
}

export function loadConfigFile(path: string): Partial<AgentConfig> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read config file ${path}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfigObject(raw, path);
}

/** Later layers override earlier ones; undefined values never override. */
export function mergeConfig(...layers: Partial<AgentConfig>[]): AgentConfig {
  const out: Record<string, unknown> = { ...DEFAULT_CONFIG };
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) if (v !== undefined) out[k] = v;
  }
  const cfg = out as unknown as AgentConfig;
  if (cfg.startLevel < 1) cfg.startLevel = 1;
  if (cfg.candidates < 2) cfg.candidates = 2;
  return cfg;
}

export function describeStopConditions(c: AgentConfig): string {
  const parts: string[] = [];
  if (c.targetLevel > 0) parts.push(`reach level ${c.targetLevel}`);
  if (c.targetScore > 0) parts.push(`reach score ${c.targetScore}`);
  if (c.maxSeconds > 0) parts.push(`play ${c.maxSeconds}s`);
  if (c.runs > 0) parts.push(`finish ${c.runs} game${c.runs === 1 ? "" : "s"}`);
  return parts.length === 0 ? "play until Ctrl+C" : `stop at the first of: ${parts.join(", ")}`;
}

/**
 * The objective in words, for the model's state. It is written so the model
 * can see the arithmetic it is up against: the game is 300 lines long, the
 * target needs a certain number of tetrises, and there is a ceiling below
 * which it stops being reachable at all.
 */
export function describeObjective(
  c: AgentConfig,
  now: { level: number; score: number; linesToNextLevel: number; secondsLeft: number | null; backToBack?: boolean },
): string {
  const n = (v: number): string => v.toLocaleString("en-US");
  const parts: string[] = [];
  if (c.targetScore > 0) {
    const missing = Math.max(0, c.targetScore - now.score);
    const linesLeft = linesLeftInGame(now.level, now.linesToNextLevel);
    const ceiling = bestRemainingScore(now.level, now.linesToNextLevel, now.backToBack ?? false);
    const perTetris = clearScore(4, now.level, now.backToBack ?? false, 0);
    parts.push(
      `score ${n(c.targetScore)} before the game ends (now ${n(now.score)}, ${n(missing)} still needed). ` +
        `The game is ${MAX_LEVEL} levels of 10 lines and then it stops, so only ${n(linesLeft)} more line${linesLeft === 1 ? "" : "s"} will ever be cleared. ` +
        `Clearing every one of them four at a time, back to back, is worth about ${n(ceiling)} from here, so the target ` +
        (ceiling >= missing
          ? `is still reachable, but only with tetrises: at level ${now.level} one pays ${n(perTetris)} and a single pays ${n(clearScore(1, now.level, false, 0))}.`
          : `can no longer be reached even with perfect play; score as much as possible and keep the game alive.`),
    );
  }
  if (c.targetLevel > 0) parts.push(`reach level ${c.targetLevel} (now level ${now.level}, ${now.linesToNextLevel} more line${now.linesToNextLevel === 1 ? "" : "s"} to the next level)`);
  if (c.maxSeconds > 0 && now.secondsLeft !== null) parts.push(`the session stops in ${now.secondsLeft}s whatever happens`);
  if (parts.length === 0) parts.push(`score as much as possible in the ${linesLeftInGame(now.level, now.linesToNextLevel)} lines the game has left; a tetris pays ${n(clearScore(4, now.level, now.backToBack ?? false, 0))} at level ${now.level} against ${n(clearScore(1, now.level, false, 0))} for a single`);
  parts.push("a top-out ends the game immediately and forfeits every line that is left");
  return parts.join("; ");
}
