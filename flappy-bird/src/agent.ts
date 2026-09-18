/**
 * The agent loop: receives game snapshots from the page, plans with exact
 * forecasts, asks the brain for a decision every cycle, checks that the
 * answer still applies to the world it was asked about, and installs the
 * chosen flap schedule in the page.
 *
 * Latency handling: every request is built for the future. Forecasts start at
 * `earliestStep`, the step by which an answer is expected back (from the
 * measured round-trip), so a plan is executable the moment it arrives. Flaps
 * that will happen before then (from the active plan or the hover fallback)
 * are predicted in code and baked into the forecast baseline.
 */
import { MS_PER_STEP, cloneState, flap, fx, step, upcomingPipes, type SimState } from "./physics.ts";
import {
  chooseByCode,
  describeSituation,
  forecastManeuvers,
  hoverLine,
  hoverWantsFlap,
  simulatePlan,
  type Forecast,
  type ManeuverId,
} from "./planner.ts";
import type { Brain, Decision, DecisionRequest } from "./brain.ts";
import { describeApiError } from "./brain-jev.ts";
import type { PagePlan, PageSnapshot } from "./page-agent.ts";

export interface PageControl {
  setPlan(plan: PagePlan): Promise<{ accepted: boolean; reason?: string }>;
  setHoverBias(bias: number): Promise<void>;
  cancelPendingFlaps(): Promise<void>;
  startRun(ranked: boolean): Promise<void>;
  restart(): Promise<void>;
}

export interface AgentOptions {
  brain: Brain;
  intervalMs: number;
  maxInFlight: number;
  ranked: boolean;
  /** Stop after this many finished runs; 0 = unlimited. */
  runs: number;
  /** Stop after this many seconds of session time; 0 = no limit. */
  maxSeconds: number;
  /** Stop as soon as a run reaches this score; 0 = no target. */
  targetScore: number;
  restartDelayMs: number;
  startDelayMs: number;
  fallbackEnabled: boolean;
  latencyGuessMs: number;
  lineConfidenceFloor: number;
  log?: (event: Record<string, unknown>) => void;
}

export type StopReason = "target-score" | "time-limit" | "runs" | "fatal" | "manual";

export type Danger = "comfortable" | "tight" | "critical" | "none";

export interface AgentStats {
  requests: number;
  answers: number;
  applied: number;
  stale: number;
  superseded: number;
  rejected: number;
  vetoed: number;
  cancelled: number;
  errors: number;
  rateLimited: number;
  flapsByPlan: number;
  flapsByFallback: number;
  flapsLate: number;
  inputTokens: number;
}

export interface RunSummary {
  run: number;
  score: number;
  deathCause: string | null;
  durationSteps: number;
  flapsByPlan: number;
  flapsByFallback: number;
  jevAnswers: number;
}

export interface AgentStatus {
  phase: PageSnapshot["phase"] | "connecting";
  goal: { targetScore: number; secondsLeft: number | null; runsLeft: number | null };
  stopReason: StopReason | null;
  run: number;
  score: number;
  best: number;
  step: number;
  latencyP50: number;
  latencyP90: number;
  requestsPerSecond: number;
  lastDecision: Decision | null;
  lastManeuver: ManeuverId | null;
  danger: Danger;
  hoverBias: number;
  stats: AgentStats;
  runs: RunSummary[];
  brain: string;
  message: string | null;
}

const LATE_TOLERANCE_STEPS = 6;
const SAFETY_MS = 25;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

export function toSimState(s: PageSnapshot): SimState {
  return {
    phase: s.phase,
    birdY: s.y,
    birdVy: s.vy,
    pipes: s.pipes.map((p) => ({ ...p })),
    score: s.score,
    playStep: s.step,
    spawnCount: s.spawnCount,
    simVersion: s.simVersion,
    deathCause: (s.deathCause as SimState["deathCause"]) ?? null,
  };
}

export function dangerOf(forecasts: readonly Forecast[]): Danger {
  const reach = forecasts.filter((f) => f.outcome !== "no_pipe_in_range");
  if (reach.length === 0) return "none";
  const survivors = reach.filter((f) => f.survives);
  const best = Math.max(...survivors.map((f) => Math.min(f.minClearance ?? 0, f.followingMinClearance ?? 1)), -1);
  if (survivors.length === 0 || best < 0.03) return "critical";
  if (survivors.length <= 2 || best < 0.07) return "tight";
  return "comfortable";
}

export class Agent {
  readonly opts: AgentOptions;
  readonly page: PageControl;
  readonly stats: AgentStats = {
    requests: 0, answers: 0, applied: 0, stale: 0, superseded: 0, rejected: 0, vetoed: 0, cancelled: 0, errors: 0, rateLimited: 0,
    flapsByPlan: 0, flapsByFallback: 0, flapsLate: 0, inputTokens: 0,
  };
  readonly runs: RunSummary[] = [];

  private latest: PageSnapshot | null = null;
  private latestAt = 0;
  private executed: { step: number; source: string; planId: number | null }[] = [];
  private activePlan: (PagePlan & { chosen: ManeuverId }) | null = null;
  private planSeq = 0;
  private lastAppliedBuiltAt = -1;
  private inFlight = 0;
  private rtts: number[] = [];
  private requestTimes: number[] = [];
  private lastDecision: Decision | null = null;
  private lastManeuver: ManeuverId | null = null;
  private danger: Danger = "none";
  private hoverBias = 0;
  private run = 0;
  private runFlapsByPlan = 0;
  private runFlapsByFallback = 0;
  private runJevAnswers = 0;
  private startTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private slowUntil = 0;
  private stopped = false;
  private message: string | null = null;
  private lastPhase: PageSnapshot["phase"] | null = null;
  private finished: (() => void) | null = null;
  private deadline: number | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  /** Why the loop stopped, once it has. */
  stopReason: StopReason | null = null;
  /** Set when the loop stopped because of an unrecoverable error (bad API key). */
  fatal: Error | null = null;

  constructor(page: PageControl, opts: AgentOptions) {
    this.page = page;
    this.opts = opts;
  }

  /** Resolves when the configured number of runs has finished (never, when unlimited). */
  start(): Promise<void> {
    this.schedule(this.opts.intervalMs);
    if (this.opts.maxSeconds > 0) {
      this.deadline = performance.now() + this.opts.maxSeconds * 1000;
      this.deadlineTimer = setTimeout(() => {
        this.message = `time limit of ${this.opts.maxSeconds}s reached`;
        this.stop("time-limit");
      }, this.opts.maxSeconds * 1000);
    }
    return new Promise((resolve) => {
      this.finished = resolve;
    });
  }

  /** Decision cadence: a timer chain that never re-enters itself; tighter spots get a faster cadence. */
  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.tickTimer = setTimeout(() => {
      try {
        this.tick();
      } catch (err) {
        this.stats.errors++;
        this.message = err instanceof Error ? err.message : String(err);
      }
      const factor = this.danger === "critical" ? 0.5 : this.danger === "tight" ? 0.75 : 1;
      this.schedule(Math.max(30, this.opts.intervalMs * factor));
    }, delayMs);
  }

  stop(reason: StopReason = "manual"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.finished?.();
  }

  status(): AgentStatus {
    const sorted = [...this.rtts].sort((a, b) => a - b);
    const now = performance.now();
    this.requestTimes = this.requestTimes.filter((t) => now - t < 5000);
    return {
      phase: this.latest?.phase ?? "connecting",
      goal: {
        targetScore: this.opts.targetScore,
        secondsLeft: this.deadline === null ? null : Math.max(0, Math.ceil((this.deadline - now) / 1000)),
        runsLeft: this.opts.runs > 0 ? Math.max(0, this.opts.runs - this.run) : null,
      },
      stopReason: this.stopReason,
      run: this.run,
      score: this.latest?.score ?? 0,
      best: this.latest?.best ?? 0,
      step: this.latest?.step ?? 0,
      latencyP50: percentile(sorted, 0.5),
      latencyP90: percentile(sorted, 0.9),
      requestsPerSecond: this.requestTimes.length / 5,
      lastDecision: this.lastDecision,
      lastManeuver: this.lastManeuver,
      danger: this.danger,
      hoverBias: this.hoverBias,
      stats: this.stats,
      runs: this.runs,
      brain: this.opts.brain.name,
      message: this.message,
    };
  }

  /** Called by the browser layer for every snapshot the page pushes. */
  onSnapshot(snap: PageSnapshot): void {
    if (this.stopped) return;
    this.latest = snap;
    this.latestAt = performance.now();
    for (const f of snap.flaps) {
      this.executed.push(f);
      if (f.source === "plan" || f.source === "plan-late") {
        this.stats.flapsByPlan++;
        this.runFlapsByPlan++;
        if (f.source === "plan-late") this.stats.flapsLate++;
      } else if (f.source === "fallback") {
        this.stats.flapsByFallback++;
        this.runFlapsByFallback++;
      }
    }
    if (this.executed.length > 400) this.executed.splice(0, this.executed.length - 400);
    if (snap.phase !== this.lastPhase) this.onPhaseChange(snap);
    if (this.opts.targetScore > 0 && snap.phase === "play" && snap.score >= this.opts.targetScore) {
      this.message = `reached target score ${this.opts.targetScore} in run ${this.run}`;
      this.opts.log?.({ type: "target", run: this.run, score: snap.score, step: snap.step });
      this.stop("target-score");
    }
  }

  private onPhaseChange(snap: PageSnapshot): void {
    const prev = this.lastPhase;
    this.lastPhase = snap.phase;
    if (snap.phase === "getready") {
      this.activePlan = null;
      this.executed = [];
      this.lastAppliedBuiltAt = -1;
      this.runFlapsByPlan = 0;
      this.runFlapsByFallback = 0;
      this.runJevAnswers = 0;
      this.hoverBias = 0;
      void this.page.setHoverBias(0);
      if (this.opts.runs > 0 && this.run >= this.opts.runs) {
        this.message = `finished ${this.run} run(s)`;
        this.stop("runs");
        return;
      }
      this.startTimer = setTimeout(() => {
        this.run += 1;
        this.message = null;
        void this.page.startRun(this.opts.ranked);
      }, this.opts.startDelayMs);
    } else if (snap.phase === "gameover" && prev === "play") {
      const summary: RunSummary = {
        run: this.run,
        score: snap.score,
        deathCause: snap.deathCause,
        durationSteps: snap.step,
        flapsByPlan: this.runFlapsByPlan,
        flapsByFallback: this.runFlapsByFallback,
        jevAnswers: this.runJevAnswers,
      };
      this.runs.push(summary);
      this.opts.log?.({ type: "run", ...summary });
      this.activePlan = null;
      this.danger = "none";
      const done = this.opts.runs > 0 && this.run >= this.opts.runs;
      if (done) {
        this.message = `finished ${this.run} run(s)`;
        this.stop("runs");
        return;
      }
      this.restartTimer = setTimeout(() => void this.page.restart(), this.opts.restartDelayMs);
    }
  }

  private latencyBudgetMs(): number {
    if (this.rtts.length < 3) return this.opts.latencyGuessMs;
    const sorted = [...this.rtts].sort((a, b) => a - b);
    return percentile(sorted, 0.9);
  }

  /** Steps in [fromStep, untilStep) on which the page will flap without a new plan: mirrors the page's own rules. */
  private predictCommittedFlaps(state: SimState, untilStep: number): number[] {
    const sim = cloneState(state);
    const plan = this.activePlan;
    const flaps: number[] = [];
    while (sim.playStep < untilStep && sim.phase === "play") {
      const at = sim.playStep;
      let acted = false;
      if (plan && plan.flapSteps.includes(at)) {
        flap(sim);
        flaps.push(at);
        acted = true;
      }
      if (!acted && (!plan || at >= plan.windowEnd) && this.opts.fallbackEnabled) {
        const { target } = upcomingPipes(sim.pipes);
        if (hoverWantsFlap(sim.birdY, sim.birdVy, hoverLine(target, this.hoverBias))) {
          flap(sim);
          flaps.push(at);
        }
      }
      step(sim, () => null);
    }
    return flaps;
  }

  /**
   * A flap scheduled by an earlier plan can turn fatal when the world moves on
   * (typically when the next pipe becomes the target). Code checks the pending
   * schedule against a fresh forecast every cycle and cancels it when dropping
   * it is what keeps the bird alive.
   */
  private pruneFatalPendingFlaps(state: SimState): void {
    const plan = this.activePlan;
    if (!plan) return;
    const pending = plan.flapSteps.filter((s) => s >= state.playStep);
    if (pending.length === 0) return;
    const withFlaps = simulatePlan(state, pending, Math.max(...pending) + 1, this.hoverBias);
    if (withFlaps.survives) return;
    const without = simulatePlan(state, [], state.playStep, this.hoverBias);
    if (!without.survives) return;
    plan.flapSteps = plan.flapSteps.filter((s) => s < state.playStep);
    plan.windowEnd = state.playStep;
    this.stats.cancelled++;
    this.opts.log?.({ type: "cancel", run: this.run, step: state.playStep, cancelled: pending, planId: plan.id });
    void this.page.cancelPendingFlaps();
  }

  private tick(): void {
    if (this.stopped || !this.latest || this.latest.phase !== "play") return;
    if (this.inFlight >= this.opts.maxInFlight) return;
    const now = performance.now();
    if (now < this.slowUntil) return;
    if (now - this.latestAt > 500) {
      this.message = "no game snapshots for 500 ms: is the game window visible?";
      return;
    }
    const snap = this.latest;
    const state = toSimState(snap);
    if (!upcomingPipes(state.pipes).target) return; // warm-up: no pipe yet, the hover fallback idles the bird
    this.pruneFatalPendingFlaps(state);
    const marginSteps = Math.ceil((this.latencyBudgetMs() + SAFETY_MS + (now - this.latestAt)) / MS_PER_STEP);
    const earliestStep = snap.step + marginSteps;
    const committedFlaps = this.predictCommittedFlaps(state, earliestStep);
    const forecasts = forecastManeuvers({ state, earliestStep, committedFlaps, hoverBias: this.hoverBias });
    this.danger = dangerOf(forecasts);
    const req: DecisionRequest = { builtAtStep: snap.step, earliestStep, situation: describeSituation(state), forecasts, state };
    this.stats.requests++;
    this.requestTimes.push(now);
    void this.dispatch(req, committedFlaps);
  }

  /** One request from send to apply; runs concurrently with other in-flight requests. */
  private async dispatch(req: DecisionRequest, committedFlaps: number[]): Promise<void> {
    this.inFlight++;
    const t0 = performance.now();
    let decision: Decision | null = null;
    try {
      try {
        decision = await this.opts.brain.decide(req);
        this.stats.answers++;
        this.runJevAnswers++;
        if (decision.usage) this.stats.inputTokens += decision.usage.input_tokens;
      } catch (err) {
        this.stats.errors++;
        const info = describeApiError(err);
        if (info.kind === "rate_limit") {
          this.stats.rateLimited++;
          this.slowUntil = performance.now() + 1000;
        }
        this.message = `${info.kind}: ${info.message}`;
        this.opts.log?.({ type: "error", builtAtStep: req.builtAtStep, ...info });
        if (info.kind === "auth") {
          this.fatal = err instanceof Error ? err : new Error(info.message);
          this.stop("fatal");
          return;
        }
        // No decision this cycle: the active plan and the in-page hover safety net keep the
        // bird flying until the next answer arrives.
      }
      const rtt = performance.now() - t0;
      this.rtts.push(rtt);
      if (this.rtts.length > 30) this.rtts.shift();
      if (decision) await this.apply(req, decision, committedFlaps, rtt);
    } catch (err) {
      if (!this.stopped) {
        this.stats.errors++;
        this.message = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.inFlight--;
    }
  }

  private async apply(req: DecisionRequest, decision: Decision, committedFlaps: number[], rtt: number): Promise<void> {
    if (this.stopped || !this.latest || this.latest.phase !== "play") return;
    void committedFlaps;
    this.lastDecision = decision;
    const logBase = {
      type: "decision",
      run: this.run,
      builtAtStep: req.builtAtStep,
      earliestStep: req.earliestStep,
      rttMs: Math.round(rtt),
      chosen: decision.chosen,
      confidence: decision.confidence,
      probabilities: decision.probabilities,
      line: decision.line,
      source: decision.source,
      danger: this.danger,
      situation: req.situation,
      forecasts: req.forecasts.map((f) => ({ id: f.id, outcome: f.outcome, following: f.followingOutcome, survives: f.survives, min: f.minClearance, followingMin: f.followingMinClearance, above: f.clearanceAbove, below: f.clearanceBelow, arrival: f.arrivalOffset, flapStep: f.flapStep })),
    };
    if (req.builtAtStep < this.lastAppliedBuiltAt) {
      this.stats.superseded++;
      this.opts.log?.({ ...logBase, result: "superseded" });
      return;
    }
    let chosen = req.forecasts.find((f) => f.id === decision.chosen)!;
    const anySurvives = req.forecasts.some((f) => f.survives);
    if (!chosen.survives && anySurvives) {
      // The model picked a certain crash: code verifies claims against evidence and overrides.
      chosen = chooseByCode(req.forecasts);
      this.stats.vetoed++;
    }
    // Freshness: re-run the chosen schedule from the world as it is now. Flaps that will
    // happen before it takes effect (pending plan flaps, hover fallback) are part of it.
    const stateNow = toSimState(this.latest);
    const effectStep = chosen.flapStep ?? chosen.windowEnd;
    const keepFlaps = this.predictCommittedFlaps(stateNow, effectStep);
    const schedule = chosen.flapStep === null ? keepFlaps : [...keepFlaps, chosen.flapStep];
    const check = simulatePlan(stateNow, schedule, chosen.windowEnd, this.hoverBias);
    if (!check.survives && anySurvives) {
      this.stats.stale++;
      this.opts.log?.({ ...logBase, result: "stale", reason: `no longer survives from step ${stateNow.playStep}: ${check.outcome}/${check.followingOutcome}` });
      return;
    }
    const plan: PagePlan & { chosen: ManeuverId } = {
      id: ++this.planSeq,
      maneuver: chosen.id,
      flapSteps: chosen.flapStep === null ? [] : [chosen.flapStep],
      keepFlaps,
      windowEnd: chosen.windowEnd,
      builtAtStep: req.builtAtStep,
      chosen: chosen.id,
    };
    const nowStep = this.latest.step + Math.floor((performance.now() - this.latestAt) / MS_PER_STEP);
    if (chosen.flapStep !== null && nowStep - chosen.flapStep > LATE_TOLERANCE_STEPS) {
      this.stats.stale++;
      this.opts.log?.({ ...logBase, result: "stale", reason: "answer arrived after the flap step" });
      return;
    }
    if (this.stopped) return;
    const res = await this.page.setPlan(plan);
    if (!res.accepted) {
      this.stats.rejected++;
      this.opts.log?.({ ...logBase, result: "rejected", reason: res.reason });
      return;
    }
    // Node's copy mirrors what the page will execute: kept flaps plus the chosen one.
    this.activePlan = { ...plan, flapSteps: [...new Set([...keepFlaps, ...plan.flapSteps])].sort((a, b) => a - b) };
    this.lastAppliedBuiltAt = req.builtAtStep;
    this.lastManeuver = chosen.id;
    this.stats.applied++;
    this.opts.log?.({ ...logBase, result: "applied", planId: plan.id, vetoed: chosen.id !== decision.chosen });
    if (decision.line) {
      const known = req.situation.following_gap !== "not rolled yet";
      const bias = known && decision.line.confidence >= this.opts.lineConfidenceFloor
        ? decision.line.choice === "high" ? fx(0.05) : decision.line.choice === "low" ? -fx(0.05) : 0
        : 0;
      if (bias !== this.hoverBias) {
        this.hoverBias = bias;
        void this.page.setHoverBias(bias);
      }
    }
  }
}
