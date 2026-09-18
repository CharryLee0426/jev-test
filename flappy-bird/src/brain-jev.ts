/**
 * The Jev brain: turns a planning request into one TypeSafe System One call.
 *
 * Design, following the TypeSafe skill and docs:
 *  - code did all arithmetic (exact forecasts) and labelled every quantity in
 *    words, so the model judges facts instead of computing them;
 *  - the state carries only what the questions need;
 *  - the decisive judgment is one Choice over concrete maneuvers whose
 *    consequences are spelled out in the criteria;
 *  - a second, speculative Choice (which part of the gap to fly through) is
 *    asked in the same request and only used when a following gap is known;
 *  - probabilities and confidence come back for the HUD and for gating.
 */
import { APIError, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Brain, Decision, DecisionRequest, LineChoice } from "./brain.ts";
import { MANEUVERS, describeForecast, type ManeuverDescription, type ManeuverId, type Situation } from "./planner.ts";

export interface JevBrainOptions {
  apiKey?: string;
  model?: string;
  /** Per-attempt timeout; a slow answer is useless for a bird in flight. */
  timeoutMs?: number;
  baseURL?: string;
}

export type JevState = {
  situation: Situation;
};

const LINE_CRITERIA: Record<LineChoice, string> = {
  high: "Fly through the upper part of the upcoming gap. Right when the following gap is much higher, so the bird needs less climbing afterwards.",
  centered: "Fly through the middle of the upcoming gap. Right when the following gap is about level, or has not been rolled yet, or when the bird is already struggling to line up.",
  low: "Fly through the lower part of the upcoming gap. Right when the following gap is much lower, so the bird can drop into it without a steep dive.",
};

export function buildJevRequest(req: DecisionRequest) {
  const maneuvers = Object.fromEntries(req.forecasts.map((f) => [f.id, describeForecast(f)])) as Record<ManeuverId, ManeuverDescription>;
  for (const m of MANEUVERS) if (!(m.id in maneuvers)) throw new Error(`forecast missing for ${m.id}`);
  const state: JevState = { situation: req.situation };
  const questions = {
    maneuver: {
      type: "choice" as const,
      instructions: {
        question: "Which maneuver should the bird execute right now?",
        goal: "Fly through the upcoming gap between the pipes without touching a pipe or the ground, and be well placed for the following gap.",
        facts: "Each option's result and clearances were computed by an exact physics simulation of the game. Treat them as facts. `situation` describes the bird right now.",
        how_to_choose: [
          "Never choose an option whose result mentions a crash while another option's result has no crash.",
          "Among options without a crash, prefer the best worst_clearance_at_upcoming_gap: generous beats comfortable, comfortable beats tight, tight beats razor-thin.",
          "When that is the same, prefer the best worst_clearance_at_following_gap, then balanced clearance_above and clearance_below over lopsided ones.",
          "When still similar, prefer the option whose position_when_reaching_following_gap is closest to level with the following gap.",
          "When still tied, prefer fewer flaps.",
        ],
      },
      criteria: maneuvers,
    },
    line_through_gap: {
      type: "choice" as const,
      instructions: {
        question: "Through which part of the upcoming gap should the bird fly, given `situation.following_gap`?",
        note: "Pick centered whenever the following gap is not rolled yet or is about level.",
      },
      criteria: LINE_CRITERIA,
    },
  };
  return { state, questions };
}

export class JevBrain implements Brain {
  readonly name: string;
  readonly client: TypeSafeClient;
  readonly model: string | undefined;

  constructor(options: JevBrainOptions = {}) {
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      defaultModel: options.model,
      timeout: options.timeoutMs ?? 1500,
      // Real time: a retry after a timeout would arrive far too late. The
      // agent loop already sends a fresh request every cycle.
      retry: { maxRetries: 0 },
      logLevel: "error",
    });
    this.model = options.model;
    this.name = `jev (${this.client.defaultModel})`;
  }

  async decide(req: DecisionRequest, signal?: AbortSignal): Promise<Decision> {
    const { state, questions } = buildJevRequest(req);
    const t0 = performance.now();
    const result = await this.client.systemOne({ state, questions }, { signal });
    const latencyMs = performance.now() - t0;
    const maneuver = result.answers.maneuver;
    const line = result.answers.line_through_gap;
    const chosen = maneuver.choice;
    if (!req.forecasts.some((f) => f.id === chosen)) throw new Error(`model chose unknown maneuver ${String(chosen)}`);
    return {
      chosen,
      confidence: maneuver.confidence,
      probabilities: maneuver.probabilities,
      line: { choice: line.choice, confidence: line.confidence },
      latencyMs,
      usage: result.usage,
      model: result.model,
      source: "jev",
    };
  }

  /** Lists the models the key can use; a cheap way to validate the key at startup. */
  async listModels(): Promise<string[]> {
    const models = await this.client.models.list();
    return models.map((m) => m.name);
  }
}

export function describeApiError(err: unknown): { kind: "rate_limit" | "auth" | "timeout" | "connection" | "api" | "other"; message: string; status?: number } {
  if (err instanceof APIError) {
    const status = err.status;
    if (status === 429 || status === 529) return { kind: "rate_limit", message: `HTTP ${status}`, status };
    if (status === 401 || status === 403) return { kind: "auth", message: `HTTP ${status}: check TYPESAFE_API_KEY`, status };
    return { kind: "api", message: `HTTP ${status}: ${err.message}`, status };
  }
  const name = (err as { name?: string })?.name ?? "";
  if (name === "APITimeoutError") return { kind: "timeout", message: "request timed out" };
  if (name === "APIConnectionError") return { kind: "connection", message: (err as Error).message };
  return { kind: "other", message: err instanceof Error ? err.message : String(err) };
}
