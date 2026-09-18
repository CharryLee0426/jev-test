import type { SimState } from "./physics.ts";
import type { Forecast, ManeuverId, Situation } from "./planner.ts";

export type LineChoice = "high" | "centered" | "low";

export interface DecisionRequest {
  builtAtStep: number;
  earliestStep: number;
  situation: Situation;
  forecasts: Forecast[];
  state: SimState;
}

export interface Decision {
  chosen: ManeuverId;
  /** Choice confidence reported by the model. */
  confidence: number | null;
  probabilities: Partial<Record<ManeuverId, number>> | null;
  /** Which part of the gap to fly through, with its confidence; null when not asked. */
  line: { choice: LineChoice; confidence: number } | null;
  latencyMs: number;
  usage: { input_tokens: number; output_tokens: number } | null;
  model: string | null;
  /** Who decided; recorded in the decision log. */
  source: "jev";
}

export interface Brain {
  readonly name: string;
  decide(req: DecisionRequest, signal?: AbortSignal): Promise<Decision>;
}
