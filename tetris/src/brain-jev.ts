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
  build_tetris_well: {
    what: "Stack the nine columns beside the well flat and level, and never put anything in the well column. Take no clear smaller than a tetris.",
    right_when: "The default. The stack is below about twelve rows, the well is open and there are no holes worth digging out.",
    not_for: "A stack near the top, or a well with a block in it that has to be dug out first.",
  },
  cash_the_tetris: {
    what: "Four rows are ready and an I piece is in hand or next: drop it in the well and take the tetris.",
    right_when: "The well has four ready rows and an I piece is the live piece, the held piece or the next one.",
    not_for: "Fewer than four ready rows, or no I piece in sight.",
  },
  survive_now: {
    what: "Forget the well and the back-to-back chain; take whatever clear brings the stack down fastest.",
    right_when: "The stack is dangerously high or the surface is so jagged that the next piece cannot be walked to where it is needed.",
    not_for: "Any board that is still safe. This posture spends rows cheaply, and there are only 300 in the whole game.",
  },
  repair_surface: {
    what: "Fill the holes and flatten the surface, keeping the well open, before going back to building.",
    right_when: "There are buried holes, or the surface is jagged enough to trap the next piece, and the stack is not yet dangerous.",
    not_for: "A clean flat stack, or a stack so high that only a clear will save it.",
  },
};

export function buildJevRequest(req: DecisionRequest) {
  const criteria = Object.fromEntries(req.candidates.map((c) => [c.id, describeCandidate(c, req.pieces, req.context)])) as Record<string, CandidateDescription>;
  const state = { objective: req.objective, situation: req.situation };
  const questions = {
    placement: {
      type: "choice" as const,
      instructions: {
        question: "Which placement should the live piece get right now?",
        goal: "Score as much as possible before the game ends, and do not end it early. `objective` says how far along that is.",
        facts: "Each option's consequences were computed by simulating the placement exactly on the current board, then the following piece's best reply on the resulting board. The points in each option are what the game will actually add to the score. Only placements the piece can still be brought to at this level's gravity are listed. Treat all of it as facts. `situation` describes the board and the pieces right now.",
        the_economics: [
          "This game is 30 levels of 10 lines and then it ends, so only 300 lines will ever be cleared. What decides the score is what each line is paid, not how many are cleared.",
          "A tetris pays 800 x level for four rows. A single pays 100 x level for one. Four singles therefore pay a third of what one tetris pays for the same four rows.",
          "Two tetrises in a row with nothing in between pay half as much again for the second one, and every one after it. Clearing one, two or three lines breaks that chain.",
          "So the whole game is: keep one column empty, stack the other nine flat and level, wait for an I piece, and clear four at a time, over and over.",
        ],
        how_to_choose: [
          "Never choose an option whose risk says ENDS THE GAME while another option does not.",
          "A tetris is almost always the right answer when one is offered.",
          "Otherwise prefer the option that adds ready rows to the well without creating a hole, and keeps the surface flat.",
          "Refuse a single, double or triple unless the stack is genuinely dangerous: it pays badly and it breaks the back-to-back chain. Read the points field, which spells out what it costs.",
          "Never put a block in the tetris well unless every other option is worse than that; it stops all scoring until it is dug out.",
          "A new buried hole is worse than a slightly higher stack, because it has to be dug out before the well can be used again.",
          "When the stack is dangerously high or critical, that overrides all of the above: take whatever brings it down fastest.",
          "Use a hold option only when the piece it brings out has a clearly better placement, or to save an I piece for the well.",
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
