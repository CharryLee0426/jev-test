/**
 * The Jev brain: turns a planning request into one TypeSafe System One call.
 *
 * Design, following the TypeSafe skill and docs:
 *  - code did all arithmetic (exact placement simulation, lookahead) and
 *    labelled every quantity in words, so the model judges facts instead of
 *    computing them;
 *  - the state carries only what the questions need;
 *  - the decisive judgment is one Choice over concrete placements whose
 *    consequences are spelled out in the criteria with the same field names,
 *    so the options can be compared directly;
 *  - a second, speculative Choice (the strategic posture) is asked in the same
 *    request and consumed by code as a weight preset for the next cycle;
 *  - probabilities and confidence come back for the HUD and for gating.
 */
import { APIError, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Brain, Decision, DecisionRequest } from "./brain.ts";
import { POSTURES, describeCandidate, type CandidateDescription, type Posture } from "./planner.ts";

export interface JevBrainOptions {
  apiKey?: string;
  model?: string;
  /** Per-attempt timeout; a slow answer is useless for a falling piece. */
  timeoutMs?: number;
  baseURL?: string;
}

const POSTURE_CRITERIA: Record<Posture, { what: string; right_when: string; not_for: string }> = {
  build_for_tetris: {
    what: "Keep stacking cleanly and keep one deep well open for the I piece, so four lines can be cleared at once.",
    right_when: "The stack is low or moderate, there are no holes, and there is no urgent pressure.",
    not_for: "A high stack, holes in the stack, or a level or score goal that is one or two lines away.",
  },
  clear_lines_now: {
    what: "Take every line clear available, singles included, to bring the stack down or to finish the goal.",
    right_when: "The stack is high, the pace is fast, or the next level or the target is only a few lines away.",
    not_for: "A low, clean stack with time to build.",
  },
  repair_surface: {
    what: "Fill the holes and flatten a jagged surface before anything else.",
    right_when: "There are buried holes or the surface is very jagged, and the stack is not yet dangerous.",
    not_for: "A clean, flat stack, or a stack so high that only line clears can save the game.",
  },
};

export function buildJevRequest(req: DecisionRequest) {
  const criteria = Object.fromEntries(req.candidates.map((c) => [c.id, describeCandidate(c, req.pieces)])) as Record<string, CandidateDescription>;
  const state = { objective: req.objective, situation: req.situation };
  const questions = {
    placement: {
      type: "choice" as const,
      instructions: {
        question: "Which placement should the live piece get right now?",
        goal: "Keep the game alive and make progress on `objective`: clear lines, keep the stack low and solid, and leave the following piece a good spot.",
        facts: "Each option's consequences were computed by simulating the placement exactly on the current board, then the following piece's best reply on the resulting board. Treat them as facts. `situation` describes the board and the pieces right now.",
        how_to_choose: [
          "Never choose an option whose risk says ENDS THE GAME while another option does not.",
          "Prefer an option that clears lines without creating a new hole; a double beats a single, a triple beats a double, a tetris beats everything.",
          "Among options without a line clear, prefer no new holes, then a lower stack, then a flatter surface.",
          "When the stack is dangerously high or critical, prefer whatever brings it down fastest, even a single line.",
          "When the stack is low and solid, keeping a deep well open for the I piece is good; filling it for no gain is bad.",
          "Use a hold option only when the piece it brings out has a clearly better placement than the live piece.",
          "When options are still similar, prefer the better next_piece_outlook.",
        ],
      },
      criteria,
    },
    posture: {
      type: "choice" as const,
      instructions: {
        question: "Given `situation` and `objective`, which posture should guide the next few placements?",
        note: "Answer for the board as it is now; the placement question above is decided separately.",
      },
      criteria: POSTURE_CRITERIA,
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
      // agent asks again on the next cycle anyway.
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
    const placement = result.answers.placement;
    const posture = result.answers.posture;
    const chosen = placement.choice;
    if (!req.candidates.some((c) => c.id === chosen)) throw new Error(`model chose unknown option ${String(chosen)}`);
    return {
      chosen,
      confidence: placement.confidence,
      probabilities: placement.probabilities,
      posture: POSTURES.includes(posture.choice as Posture) ? { choice: posture.choice as Posture, confidence: posture.confidence } : null,
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
