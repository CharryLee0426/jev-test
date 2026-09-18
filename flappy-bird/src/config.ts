/**
 * Agent settings, resolved from three layers: built-in defaults, an optional
 * JSON config file (agent.config.json by default), and CLI flags. Later
 * layers win. File keys may be written kebab-case like the CLI flags
 * ("target-score") or camelCase ("targetScore").
 */
import { readFileSync } from "node:fs";

export interface AgentConfig {
  model?: string;
  /** Decision cadence in ms. */
  interval: number;
  /** Max concurrent model requests. */
  inFlight: number;
  /** Per-request model timeout in ms. */
  timeout: number;
  /** Assumed round trip in ms before measurements exist. */
  latencyGuess: number;
  /** Stop after this many finished runs; 0 = unlimited. */
  runs: number;
  /** Stop after this many seconds of session time; 0 = no limit. */
  maxSeconds: number;
  /** Stop as soon as a run reaches this score; 0 = no target. */
  targetScore: number;
  /** Seconds to keep the game window open after a stop condition is met. */
  linger: number;
  /** Let runs count for the site's leaderboard. */
  ranked: boolean;
  /** In-page hover safety net when no plan covers the current step. */
  fallback: boolean;
  startDelay: number;
  restartDelay: number;
  url: string;
  /** Attach to a running Chrome (http://localhost:9222) instead of launching one. */
  cdp?: string;
  channel: string;
  headless: boolean;
  /** JSON-lines log of every decision and run summary. */
  log?: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  interval: 100,
  inFlight: 3,
  timeout: 1500,
  latencyGuess: 250,
  runs: 0,
  maxSeconds: 0,
  targetScore: 0,
  linger: 3,
  ranked: false,
  fallback: true,
  startDelay: 800,
  restartDelay: 2500,
  url: "https://flappybird.io/",
  channel: "chrome",
  headless: false,
};

const NUMBER_KEYS = new Set<keyof AgentConfig>([
  "interval", "inFlight", "timeout", "latencyGuess", "runs", "maxSeconds", "targetScore", "linger", "startDelay", "restartDelay",
]);
const BOOLEAN_KEYS = new Set<keyof AgentConfig>(["ranked", "fallback", "headless"]);
const STRING_KEYS = new Set<keyof AgentConfig>(["model", "url", "cdp", "channel", "log"]);
/** Aliases accepted in files and on the CLI. */
const ALIASES: Record<string, keyof AgentConfig> = {
  playSeconds: "maxSeconds",
  seconds: "maxSeconds",
  score: "targetScore",
  maxScore: "targetScore",
};

/** "target-score" -> "targetScore"; camelCase passes through. */
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
  return out as unknown as AgentConfig;
}

export function describeStopConditions(c: AgentConfig): string {
  const parts: string[] = [];
  if (c.targetScore > 0) parts.push(`reach score ${c.targetScore}`);
  if (c.maxSeconds > 0) parts.push(`play ${c.maxSeconds}s`);
  if (c.runs > 0) parts.push(`finish ${c.runs} run${c.runs === 1 ? "" : "s"}`);
  return parts.length === 0 ? "play until Ctrl+C" : `stop at the first of: ${parts.join(", ")}`;
}
