/**
 * Agent settings, resolved from three layers: built-in defaults, an optional
 * JSON config file (agent.config.json by default), and CLI flags. Later
 * layers win. File keys may be written kebab-case like the CLI flags
 * ("target-level") or camelCase ("targetLevel").
 */
import { readFileSync } from "node:fs";

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
  targetScore: 0,
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
  restartDelay: 2000,
  url: "https://play.tetris.com/",
  channel: "chrome",
  headless: false,
};

const NUMBER_KEYS = new Set<keyof AgentConfig>([
  "targetLevel", "targetScore", "maxSeconds", "runs", "linger", "startLevel", "candidates", "timeout", "latencyGuess", "keyDelay", "adTimeout", "restartDelay",
]);
const BOOLEAN_KEYS = new Set<keyof AgentConfig>(["preplan", "fallback", "headless"]);
const STRING_KEYS = new Set<keyof AgentConfig>(["model", "url", "cdp", "channel", "log"]);
/** Aliases accepted in files and on the CLI. */
const ALIASES: Record<string, keyof AgentConfig> = {
  playSeconds: "maxSeconds",
  seconds: "maxSeconds",
  time: "maxSeconds",
  score: "targetScore",
  level: "targetLevel",
  games: "runs",
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

/** The objective in words, for the model's state. */
export function describeObjective(c: AgentConfig, now: { level: number; score: number; linesToNextLevel: number; secondsLeft: number | null }): string {
  const parts: string[] = [];
  if (c.targetLevel > 0) parts.push(`reach level ${c.targetLevel} (now level ${now.level}, ${now.linesToNextLevel} more line${now.linesToNextLevel === 1 ? "" : "s"} to the next level); every line cleared counts, but a top-out ends the game`);
  if (c.targetScore > 0) parts.push(`reach a score of ${c.targetScore} (now ${now.score}); clearing several lines at once scores far more than singles (a tetris, four lines at once, scores the most), and a top-out ends the game`);
  if (c.maxSeconds > 0) parts.push(`keep the game alive for the whole session${now.secondsLeft === null ? "" : ` (${now.secondsLeft}s left)`}; survival matters more than points`);
  if (parts.length === 0) parts.push("keep the game alive as long as possible while clearing lines; a top-out ends the game");
  return parts.join("; ");
}
