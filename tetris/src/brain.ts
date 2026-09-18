import type { Candidate, PiecesInPlay, Posture, Situation } from "./planner.ts";

export interface DecisionRequest {
  /** Identifies the piece the request is about (the game's live piece id, or the predicted next one). */
  pieceKey: string;
  situation: Situation;
  objective: string;
  candidates: Candidate[];
  pieces: PiecesInPlay;
}

export interface Decision {
  chosen: string;
  /** Choice confidence reported by the model. */
  confidence: number | null;
  probabilities: Record<string, number> | null;
  /** Strategic posture for the next cycle, with its confidence. */
  posture: { choice: Posture; confidence: number } | null;
  latencyMs: number;
  usage: { input_tokens: number; output_tokens: number } | null;
  model: string | null;
  source: "jev";
}

export interface Brain {
  readonly name: string;
  decide(req: DecisionRequest, signal?: AbortSignal): Promise<Decision>;
}
