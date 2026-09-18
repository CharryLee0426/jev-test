/**
 * Candidate maneuvers and exact forecasts.
 *
 * Code owns everything that is arithmetic: which flap timings are on the
 * table, what each one leads to (simulated with the game's own physics), and
 * the plain-language labels that turn those numbers into facts a System One
 * model can judge. The model's job is only the judgment: which of these
 * maneuvers should the bird execute now.
 */
import {
  BIRD_RADIUS,
  GRAVITY_PER_STEP,
  IDLE_TARGET_Y,
  LOWEST_Y,
  MS_PER_STEP,
  PIPE_CLEAR_X,
  PIPE_DX_PER_STEP,
  PIPE_HALF_WIDTH,
  STEPS_PER_SECOND,
  cloneState,
  flap,
  fx,
  step,
  stepsUntilPipe,
  toUnits,
  upcomingPipes,
  type Pipe,
  type SimState,
} from "./physics.ts";

export type ManeuverId = "flap_now" | "flap_soon" | "flap_later" | "flap_much_later" | "hold_off";

export interface ManeuverSpec {
  id: ManeuverId;
  /** Flap delay in simulation steps after the earliest executable step; null means no flap in the window. */
  offset: number | null;
  timing: string;
}

/** How long `hold_off` promises not to flap, in steps (250 ms). */
export const HOLD_WINDOW_STEPS = 30;
/** Longest forecast per candidate, in steps (5 s). */
const MAX_FORECAST_STEPS = 600;
/**
 * The hover policy keeps the bird between the line and roughly 0.19 units above
 * it (one flap's rise), so the line sits a little under the gap center to
 * center that arc inside the gap.
 */
export const HOVER_OFFSET = fx(0.095);

export const MANEUVERS: readonly ManeuverSpec[] = [
  { id: "flap_now", offset: 0, timing: "flap immediately" },
  { id: "flap_soon", offset: 6, timing: "wait 50 ms, then flap" },
  { id: "flap_later", offset: 12, timing: "wait 100 ms, then flap" },
  { id: "flap_much_later", offset: 20, timing: "wait 170 ms, then flap" },
  { id: "hold_off", offset: null, timing: "do not flap for the next 250 ms (keep falling or coasting)" },
];

export type Outcome = "clears" | "hits_top_pipe" | "hits_bottom_pipe" | "hits_ground" | "no_pipe_in_range";

export interface Forecast {
  id: ManeuverId;
  timing: string;
  /** Absolute simulation step of the maneuver's flap; null for hold_off. */
  flapStep: number | null;
  /** Absolute step from which the hover policy is assumed to take over. */
  windowEnd: number;
  /** What happens at the upcoming pipe. */
  outcome: Outcome;
  /** What happens at the following pipe, when it is already known; null otherwise or when never reached. */
  followingOutcome: Outcome | null;
  /** True when no crash occurs at any pipe the forecast could see. */
  survives: boolean;
  /** World units, minimum while passing the upcoming pipe; null when the bird never reached it. */
  clearanceAbove: number | null;
  clearanceBelow: number | null;
  minClearance: number | null;
  /** Minimum clearance while passing the following pipe, when known and reached. */
  followingMinClearance: number | null;
  /** Bird height minus the following gap's center at the moment the upcoming pipe is cleared; null if unknown. */
  arrivalOffset: number | null;
  /** Bird height minus the upcoming gap's center right after the maneuver window. */
  positionAfterManeuver: number;
  flapsUsed: number;
  stepsSimulated: number;
  deathStep: number | null;
}

export interface PlanningInput {
  state: SimState;
  /** First step at which a plan chosen from this input can take effect (accounts for decision latency). */
  earliestStep: number;
  /** Flaps already scheduled before `earliestStep`; they happen no matter what is chosen now. */
  committedFlaps: readonly number[];
  /** Strategic shift of the hover line in fixed-point units (positive = fly higher through the gap). */
  hoverBias?: number;
}

/** The height the hover policy defends, for the pipe the bird is heading to. */
export function hoverLine(target: Pipe | undefined, bias = 0): number {
  return (target && !target.unknown ? target.gapY : IDLE_TARGET_Y) - HOVER_OFFSET + bias;
}

/** The hover policy: flap when falling and the next step would drop below the line. Mirrored in the page agent. */
export function hoverWantsFlap(birdY: number, birdVy: number, line: number): boolean {
  return birdVy <= 0 && birdY + Math.trunc((birdVy - GRAVITY_PER_STEP) / STEPS_PER_SECOND) < line;
}

function pipeInReach(pipe: Pipe): boolean {
  return pipe.x > PIPE_CLEAR_X && pipe.x < PIPE_HALF_WIDTH + 2 * BIRD_RADIUS;
}

/**
 * Clearance between the bird (a circle at x = 0) and each half of a pipe, in
 * fixed-point units, using the same nearest-point geometry as the game's
 * collision test, so a clearance below zero means exactly a collision.
 */
export function pipeClearance(birdY: number, pipe: Pipe): { above: number; below: number } {
  const nx = Math.max(pipe.x - PIPE_HALF_WIDTH, Math.min(0, pipe.x + PIPE_HALF_WIDTH));
  const bottomTop = pipe.gapY - pipe.halfGap;
  const topBottom = pipe.gapY + pipe.halfGap;
  const nyBottom = Math.min(birdY, bottomTop);
  const nyTop = Math.max(birdY, topBottom);
  return {
    below: Math.hypot(nx, birdY - nyBottom) - BIRD_RADIUS,
    above: Math.hypot(nx, birdY - nyTop) - BIRD_RADIUS,
  };
}

export interface PlanSimulation {
  outcome: Outcome;
  followingOutcome: Outcome | null;
  survives: boolean;
  clearanceAbove: number | null;
  clearanceBelow: number | null;
  minClearance: number | null;
  followingMinClearance: number | null;
  arrivalOffset: number | null;
  positionAfterManeuver: number;
  flapsUsed: number;
  stepsSimulated: number;
  deathStep: number | null;
}

const crashOutcome = (s: SimState): Outcome =>
  s.deathCause === "ground" ? "hits_ground" : s.deathCause === "pipeTop" ? "hits_top_pipe" : "hits_bottom_pipe";

/**
 * Simulates a flap schedule from `state`: scheduled flaps happen on their
 * steps, and from `hoverFrom` on the hover policy adds flaps of its own. Runs
 * through the upcoming pipe and, when already rolled, the following one.
 */
export function simulatePlan(state: SimState, scheduledFlaps: Iterable<number>, hoverFrom: number, hoverBias = 0): PlanSimulation {
  const sim = cloneState(state);
  const flapSteps = new Set<number>(scheduledFlaps);
  const { target, following } = upcomingPipes(sim.pipes);
  const knownFollowing = following && !following.unknown ? following : undefined;
  let current: Pipe | undefined = target;
  let stage: "target" | "following" = "target";
  let line = hoverLine(current, hoverBias);
  const u = (v: number | null): number | null => (v === null ? null : toUnits(v));

  let clearanceAbove: number | null = null;
  let clearanceBelow: number | null = null;
  let followingMin: number | null = null;
  let flapsUsed = 0;
  let outcome: Outcome = target ? "clears" : "no_pipe_in_range";
  let followingOutcome: Outcome | null = null;
  let deathStep: number | null = null;
  let arrivalOffset: number | null = null;
  let positionAfterManeuver: number | null = null;
  let steps = 0;

  for (; steps < MAX_FORECAST_STEPS; steps++) {
    const at = sim.playStep;
    if (at >= hoverFrom && positionAfterManeuver === null) positionAfterManeuver = sim.birdY - (target ? target.gapY : IDLE_TARGET_Y);
    if (flapSteps.has(at)) {
      flap(sim);
      flapsUsed++;
    } else if (at >= hoverFrom && hoverWantsFlap(sim.birdY, sim.birdVy, line)) {
      flap(sim);
      flapsUsed++;
    }
    // The game tests collisions after the bird moves and before the pipes
    // advance, so clearances are measured against the pipe's pre-step x.
    const xBefore = current ? current.x : 0;
    step(sim, () => null);
    if (sim.phase === "gameover") {
      deathStep = at;
      if (stage === "target") outcome = crashOutcome(sim);
      else followingOutcome = crashOutcome(sim);
      break;
    }
    if (!current) {
      if (at >= hoverFrom + 12) break;
      continue;
    }
    const atCheck: Pipe = { ...current, x: xBefore };
    if (pipeInReach(atCheck)) {
      const { above, below } = pipeClearance(sim.birdY, atCheck);
      if (stage === "target") {
        clearanceAbove = clearanceAbove === null ? above : Math.min(clearanceAbove, above);
        clearanceBelow = clearanceBelow === null ? below : Math.min(clearanceBelow, below);
      } else {
        const m = Math.min(above, below);
        followingMin = followingMin === null ? m : Math.min(followingMin, m);
      }
    }
    if (current.x <= PIPE_CLEAR_X) {
      if (stage === "target") {
        outcome = "clears";
        if (knownFollowing) {
          arrivalOffset = sim.birdY - knownFollowing.gapY;
          current = knownFollowing;
          stage = "following";
          line = hoverLine(current, hoverBias);
          followingOutcome = "clears";
          continue;
        }
        break;
      }
      followingOutcome = "clears";
      break;
    }
  }
  if (positionAfterManeuver === null) positionAfterManeuver = sim.birdY - (target ? target.gapY : IDLE_TARGET_Y);
  const ca = u(clearanceAbove);
  const cb = u(clearanceBelow);
  const survives = (outcome === "clears" || outcome === "no_pipe_in_range") && (followingOutcome === null || followingOutcome === "clears");
  return {
    outcome,
    followingOutcome,
    survives,
    clearanceAbove: ca,
    clearanceBelow: cb,
    minClearance: ca === null || cb === null ? null : Math.min(ca, cb),
    followingMinClearance: u(followingMin),
    arrivalOffset: u(arrivalOffset),
    positionAfterManeuver: toUnits(positionAfterManeuver),
    flapsUsed,
    stepsSimulated: steps,
    deathStep,
  };
}

export function forecastManeuver(input: PlanningInput, spec: ManeuverSpec): Forecast {
  const flapStep = spec.offset === null ? null : input.earliestStep + spec.offset;
  const windowEnd = flapStep !== null ? flapStep + 1 : input.earliestStep + HOLD_WINDOW_STEPS;
  const flaps = flapStep === null ? [...input.committedFlaps] : [...input.committedFlaps, flapStep];
  const sim = simulatePlan(input.state, flaps, windowEnd, input.hoverBias ?? 0);
  return { id: spec.id, timing: spec.timing, flapStep, windowEnd, ...sim };
}

export function forecastManeuvers(input: PlanningInput): Forecast[] {
  return MANEUVERS.map((m) => forecastManeuver(input, m));
}

/** Code's own pick, used to veto an answer the forecasts show to be a certain crash: the surviving maneuver with the widest margin, then the best setup for the next gap. */
export function chooseByCode(forecasts: readonly Forecast[]): Forecast {
  const survivors = forecasts.filter((f) => f.survives);
  if (survivors.length === 0) {
    return [...forecasts].sort((a, b) => (b.deathStep ?? 0) - (a.deathStep ?? 0))[0];
  }
  const key = (f: Forecast): number => {
    const margin = Math.min(f.minClearance ?? 0.1, f.followingMinClearance ?? 1);
    const setup = f.arrivalOffset === null ? 0 : Math.abs(f.arrivalOffset);
    const idle = f.outcome === "no_pipe_in_range" ? Math.abs(f.positionAfterManeuver + toUnits(HOVER_OFFSET) - 0.09) : 0;
    return margin - 0.25 * setup - 0.5 * idle - 0.002 * f.flapsUsed;
  };
  return [...survivors].sort((a, b) => key(b) - key(a))[0];
}

// ---------------------------------------------------------------------------
// Plain-language labels. Jev reads words far better than numbers, so every
// quantity that matters is described in words and the number is kept as a
// secondary detail.
// ---------------------------------------------------------------------------

const r2 = (v: number): number => Math.round(v * 100) / 100;

export function describeOffset(dy: number): string {
  const a = Math.abs(dy);
  const dir = dy >= 0 ? "above" : "below";
  if (a < 0.04) return "level with the gap center";
  if (a < 0.12) return `slightly ${dir} the gap center`;
  if (a < 0.25) return `well ${dir} the gap center`;
  return `far ${dir} the gap center, outside the gap`;
}

export function describeMotion(vyUnitsPerSecond: number): string {
  if (vyUnitsPerSecond > 0.8) return "climbing fast";
  if (vyUnitsPerSecond > 0.2) return "climbing";
  if (vyUnitsPerSecond > -0.2) return "near the top of its arc, about to fall";
  if (vyUnitsPerSecond > -1.0) return "falling";
  return "falling fast";
}

export function describeClearance(c: number | null): string {
  if (c === null) return "not reached";
  if (c < 0) return "none (collision)";
  if (c < 0.03) return "razor-thin";
  if (c < 0.07) return "tight";
  if (c < 0.12) return "comfortable";
  return "generous";
}

export function describeDistance(steps: number): string {
  if (steps === 0) return "the bird is between the pipes right now";
  if (steps < 24) return "very close";
  if (steps < 60) return "close";
  if (steps < 120) return "approaching";
  return "far";
}

export function describeRelativeGap(dy: number): string {
  const a = Math.abs(dy);
  const dir = dy >= 0 ? "higher" : "lower";
  if (a < 0.05) return "about level with the upcoming gap";
  if (a < 0.2) return `somewhat ${dir} than the upcoming gap`;
  return `much ${dir} than the upcoming gap`;
}

function crashText(o: Outcome): string {
  switch (o) {
    case "hits_top_pipe":
      return "crashes into the top pipe";
    case "hits_bottom_pipe":
      return "crashes into the bottom pipe";
    case "hits_ground":
      return "crashes into the ground";
    default:
      return "clears";
  }
}

export function describeOutcome(f: Forecast): string {
  if (f.outcome === "no_pipe_in_range") return "no pipe within reach yet";
  if (f.outcome !== "clears") return `${crashText(f.outcome)} of the upcoming gap`;
  if (f.followingOutcome === null) return "clears the upcoming gap (following gap not rolled yet)";
  if (f.followingOutcome === "clears") return "clears the upcoming gap and then the following gap";
  return `clears the upcoming gap but then ${crashText(f.followingOutcome)} of the following gap`;
}

export type Situation = {
  bird: { height_vs_upcoming_gap: string; vertical_motion: string; height_above_ground: string };
  upcoming_gap: { distance: string; time_until_reached_seconds: number; size: string };
  following_gap: string;
};

export function describeSituation(state: SimState): Situation {
  const { target, following } = upcomingPipes(state.pipes);
  const gapY = target ? target.gapY : IDLE_TARGET_Y;
  const dy = toUnits(state.birdY - gapY);
  const vy = toUnits(state.birdVy);
  const ground = toUnits(state.birdY - BIRD_RADIUS - LOWEST_Y);
  const steps = target ? stepsUntilPipe(target) : Infinity;
  const gapUnits = target ? toUnits(target.halfGap * 2) : 0;
  return {
    bird: {
      height_vs_upcoming_gap: `${describeOffset(dy)} (${r2(dy)} units)`,
      vertical_motion: `${describeMotion(vy)} (${r2(vy)} units/s)`,
      height_above_ground: ground < 0.15 ? `dangerously low (${r2(ground)} units)` : ground < 0.35 ? `low (${r2(ground)} units)` : `safe (${r2(ground)} units)`,
    },
    upcoming_gap: {
      distance: target ? describeDistance(steps) : "no pipe has appeared yet",
      time_until_reached_seconds: target ? r2((steps * MS_PER_STEP) / 1000) : -1,
      size: !target ? "n/a" : gapUnits > 0.5 ? `wide opening gap (${r2(gapUnits)} units tall)` : `standard gap (${r2(gapUnits)} units tall)`,
    },
    following_gap: following && !following.unknown ? `${describeRelativeGap(toUnits(following.gapY - target!.gapY))} (${r2(toUnits(following.gapY - target!.gapY))} units)` : "not rolled yet",
  };
}

export type ManeuverDescription = {
  timing: string;
  result: string;
  worst_clearance_at_upcoming_gap: string;
  clearance_above: string;
  clearance_below: string;
  position_when_reaching_following_gap: string;
  worst_clearance_at_following_gap: string;
  flaps_needed: number;
};

export function describeForecast(f: Forecast): ManeuverDescription {
  const fmt = (label: string, v: number | null): string => (v === null ? label : `${label} (${r2(v)} units)`);
  return {
    timing: f.timing,
    result: describeOutcome(f),
    worst_clearance_at_upcoming_gap: f.outcome === "clears" ? describeClearance(f.minClearance === null ? null : Math.max(0, f.minClearance)) : "none (collision)",
    clearance_above: fmt(describeClearance(f.clearanceAbove), f.clearanceAbove),
    clearance_below: fmt(describeClearance(f.clearanceBelow), f.clearanceBelow),
    position_when_reaching_following_gap:
      f.outcome !== "clears" ? "never gets there" : f.arrivalOffset === null ? "following gap not rolled yet" : fmt(describeOffset(f.arrivalOffset), f.arrivalOffset),
    worst_clearance_at_following_gap:
      f.outcome !== "clears" ? "never gets there" : f.followingOutcome === null ? "following gap not rolled yet" : f.followingOutcome === "clears" ? describeClearance(f.followingMinClearance) : "none (collision)",
    flaps_needed: f.flapsUsed,
  };
}

/** Milliseconds until the target pipe reaches the bird, for HUD and cadence decisions. */
export function msUntilTarget(state: SimState): number | null {
  const { target } = upcomingPipes(state.pipes);
  return target ? stepsUntilPipe(target) * MS_PER_STEP : null;
}

export { PIPE_DX_PER_STEP };
