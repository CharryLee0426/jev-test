/**
 * The script injected into flappybird.io. It runs inside the page and is the
 * agent's hands and eyes:
 *
 *  - eyes: wraps the game's `step()` so every simulation step is observed and
 *    a compact snapshot is pushed to Node through `__agentPush`;
 *  - hands: executes flap plans at exact simulation steps (a plan names the
 *    absolute step to flap on), and runs the hover fallback only when no plan
 *    covers the current step.
 *
 * The page sees no API key and makes no network calls of its own.
 */

export interface PageConstants {
  gravityPerStep: number;
  stepsPerSecond: number;
  hoverOffset: number;
  idleTargetY: number;
  pipeClearX: number;
  /** How late (in steps) a scheduled flap may still be executed before it is dropped. */
  lateTolerance: number;
  pushEverySteps: number;
}

export interface PagePipe {
  x: number;
  gapY: number;
  halfGap: number;
  passed: boolean;
}

export interface ExecutedFlap {
  step: number;
  source: "plan" | "plan-late" | "fallback" | "start";
  planId: number | null;
}

export interface PageSnapshot {
  t: number;
  phase: "getready" | "play" | "gameover";
  step: number;
  y: number;
  vy: number;
  pipes: PagePipe[];
  score: number;
  best: number;
  spawnCount: number;
  simVersion: number;
  deathCause: string | null;
  flaps: ExecutedFlap[];
  planId: number | null;
  stateElapsed: number;
}

export interface PagePlan {
  id: number;
  maneuver: string;
  /** Absolute steps the chosen maneuver flaps on (at most one today). */
  flapSteps: number[];
  /**
   * Flaps the forecast behind this plan assumed would happen before it takes
   * effect (pending flaps of the previous plan, predicted fallback flaps).
   * The page keeps these, so the world evolves exactly as forecast.
   */
  keepFlaps: number[];
  /** Steps at or after this value are no longer covered by the plan. */
  windowEnd: number;
  builtAtStep: number;
}

/** Installed on `window.__agent` inside the page. */
export interface PageAgentApi {
  setPlan(plan: PagePlan): { accepted: boolean; reason?: string };
  clearPlan(): void;
  setFallback(enabled: boolean): void;
  /** Drops every flap the active plan still has scheduled; returns how many were dropped. */
  cancelPendingFlaps(): number;
  /** Strategic shift of the hover line in fixed-point units; mirrors the planner's hoverBias. */
  setHoverBias(bias: number): void;
  startRun(ranked: boolean): void;
  restart(): void;
  snapshot(): PageSnapshot;
}

declare global {
  interface Window {
    __game?: any;
    __agent?: PageAgentApi;
    __agentPush?: (snapshot: PageSnapshot) => void;
  }
}

/**
 * Runs in the browser. Keep it self-contained: Playwright serializes this
 * function's source, so it must not reference module scope.
 */
export function installPageAgent(constants: PageConstants): { ok: boolean; reason?: string } {
  const g = window.__game;
  if (!g || typeof g.step !== "function") return { ok: false, reason: "window.__game is not available" };
  if (window.__agent) return { ok: true, reason: "already installed" };

  let plan: PagePlan | null = null;
  let fallbackEnabled = true;
  let hoverBias = 0;
  /** Steps on which a flap was executed, so a re-sent schedule never flaps twice. */
  const executedSteps: number[] = [];
  let pending: ExecutedFlap[] = [];
  let lastPushStep = -1;
  let lastPhase = g.currentState as string;
  let lastPushTime = 0;

  const targetLine = (): number => {
    const pipes = g.pipes as PagePipe[];
    let gapY = constants.idleTargetY;
    for (const p of pipes) {
      if (p.x > constants.pipeClearX) {
        gapY = p.gapY;
        break;
      }
    }
    return gapY - constants.hoverOffset + hoverBias;
  };

  const hoverWantsFlap = (): boolean => {
    const vy = g.birdVy as number;
    const y = g.birdY as number;
    return vy <= 0 && y + Math.trunc((vy - constants.gravityPerStep) / constants.stepsPerSecond) < targetLine();
  };

  const snapshot = (): PageSnapshot => {
    const flaps = pending;
    pending = [];
    return {
      t: performance.now(),
      phase: g.currentState,
      step: g.playStep,
      y: g.birdY,
      vy: g.birdVy,
      pipes: (g.pipes as PagePipe[]).map((p) => ({ x: p.x, gapY: p.gapY, halfGap: p.halfGap, passed: p.passed })),
      score: g.score,
      best: g.bestScore,
      spawnCount: g.spawnCount,
      simVersion: g.simVersion,
      deathCause: g.deathCause ?? null,
      flaps,
      planId: plan ? plan.id : null,
      stateElapsed: g.stateElapsed,
    };
  };

  const push = (): void => {
    if (typeof window.__agentPush !== "function") return;
    lastPushStep = g.playStep;
    lastPushTime = performance.now();
    try {
      window.__agentPush(snapshot());
    } catch {
      /* Node side gone; ignore */
    }
  };

  const doFlap = (source: ExecutedFlap["source"]): void => {
    g.flap();
    pending.push({ step: g.playStep, source, planId: plan ? plan.id : null });
    executedSteps.push(g.playStep);
    if (executedSteps.length > 64) executedSteps.shift();
  };

  const original = g.step.bind(g);
  g.step = (dt: number): void => {
    const phase = g.currentState as string;
    let acted = false;
    if (phase === "play") {
      const at = g.playStep as number;
      if (plan) {
        const idx = plan.flapSteps.findIndex((s) => s <= at);
        if (idx >= 0) {
          const scheduled = plan.flapSteps[idx];
          plan.flapSteps.splice(idx, 1);
          if (at - scheduled <= constants.lateTolerance) {
            doFlap(scheduled === at ? "plan" : "plan-late");
            acted = true;
          }
        }
        if (!acted && at >= plan.windowEnd && fallbackEnabled && hoverWantsFlap()) {
          doFlap("fallback");
          acted = true;
        }
      } else if (fallbackEnabled && hoverWantsFlap()) {
        doFlap("fallback");
        acted = true;
      }
    }
    original(dt);
    const now = g.currentState as string;
    const phaseChanged = now !== lastPhase;
    lastPhase = now;
    if (phaseChanged || acted) push();
    else if (now === "play" && g.playStep - lastPushStep >= constants.pushEverySteps) push();
    else if (now !== "play" && performance.now() - lastPushTime > 100) push();
  };

  const api: PageAgentApi = {
    setPlan(next) {
      if (g.currentState !== "play") return { accepted: false, reason: `phase is ${g.currentState}` };
      const at = g.playStep as number;
      if (plan && plan.builtAtStep > next.builtAtStep) return { accepted: false, reason: "older than the active plan" };
      const own = next.flapSteps.filter((s) => at - s <= constants.lateTolerance);
      if (next.flapSteps.length > 0 && own.length === 0) return { accepted: false, reason: "flap step already passed" };
      if (next.flapSteps.length === 0 && at >= next.windowEnd) return { accepted: false, reason: "window already over" };
      // Keep the flaps this plan's forecast assumed, unless they already happened or are too late to matter.
      const keep = next.keepFlaps.filter((s) => !executedSteps.includes(s) && at - s <= constants.lateTolerance);
      const flapSteps = [...new Set([...keep, ...own])].sort((a, b) => a - b);
      plan = { ...next, flapSteps, keepFlaps: [] };
      return { accepted: true };
    },
    clearPlan() {
      plan = null;
    },
    setFallback(enabled) {
      fallbackEnabled = enabled;
    },
    setHoverBias(bias) {
      hoverBias = bias;
    },
    cancelPendingFlaps() {
      if (!plan) return 0;
      const n = plan.flapSteps.length;
      plan.flapSteps = [];
      return n;
    },
    startRun(ranked) {
      if (g.currentState !== "getready") return;
      if (!ranked) g.setNetMode("offline");
      plan = null;
      pending.push({ step: 0, source: "start", planId: null });
      g.flap();
      push();
    },
    restart() {
      if (g.currentState !== "gameover") return;
      plan = null;
      g.restart();
      push();
    },
    snapshot,
  };
  window.__agent = api;
  push();
  return { ok: true };
}
