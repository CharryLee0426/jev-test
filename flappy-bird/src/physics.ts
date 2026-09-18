/**
 * Exact replica of flappybird.io's fixed-point simulation (simVersion 4).
 *
 * The game integrates at 120 steps per second using integers scaled by 2^20.
 * Everything here mirrors the game's own `birdY`, `birdVy` and
 * `pipes[].x / gapY / halfGap` fields one to one, so a forecast produced by
 * this module agrees with the live game step for step (verified by
 * test/physics.test.ts against a recorded run).
 *
 * World units: the bird sits at x = 0, y grows upward, the visible frame is
 * 2.56 units tall (about -1.28 .. 1.28) and the ground is at -0.975.
 */

export const SCALE = 1 << 20;
export const STEPS_PER_SECOND = 120;
export const MS_PER_STEP = 1000 / STEPS_PER_SECOND;

/** World units to fixed point (the game's `Te`). */
export const fx = (units: number): number => Math.round(units * SCALE);
/** Fixed point to world units (the game's `bt`). */
export const toUnits = (v: number): number => v / SCALE;
/** Per-second fixed value to per-step (the game's `Th`). */
const perStep = (v: number): number => Math.trunc(v / STEPS_PER_SECOND);

const WORLD = {
  gravity: 5,
  flapVelocity: 1.55,
  flapVelocityV3: 1.4,
  fallCapV3: 1.5,
  fallCapV4: 2.2,
  lowestHeight: -0.975,
  radius: 0.068,
  displacement: 0.01,
  speed: 0.6,
  startX: 1.2,
  endX: -1.2,
  pipeGap: 0.47,
  openingPipeGaps: [0.62, 0.59, 0.56, 0.53, 0.5],
  pipeSpacing: 1,
  pipeMinY: -0.2,
  pipeMaxY: 0.8,
} as const;

export const GRAVITY_PER_STEP = perStep(fx(WORLD.gravity));
export const FLAP_VY_V1 = fx(WORLD.flapVelocity);
export const FLAP_VY_V3 = fx(WORLD.flapVelocityV3);
export const FALL_CAP_V3 = fx(WORLD.fallCapV3);
export const FALL_CAP_V4 = fx(WORLD.fallCapV4);
export const LOWEST_Y = fx(WORLD.lowestHeight);
export const BIRD_RADIUS = fx(WORLD.radius);
export const BIRD_RADIUS_SQ = BIRD_RADIUS * BIRD_RADIUS;
export const PIPE_DX_PER_STEP = perStep(fx(WORLD.speed));
export const PIPE_START_X = fx(WORLD.startX);
export const PIPE_END_X = fx(WORLD.endX);
export const PIPE_SPACING = fx(WORLD.pipeSpacing);
export const PIPE_MIN_Y = fx(WORLD.pipeMinY);
export const PIPE_MAX_Y = fx(WORLD.pipeMaxY);
export const HALF_GAP = Math.trunc(fx(WORLD.pipeGap) / 2);
export const OPENING_HALF_GAPS: readonly number[] = WORLD.openingPipeGaps.map((g) => Math.trunc(fx(g) / 2));
export const PIPE_HALF_WIDTH = Math.trunc((26 * fx(WORLD.displacement)) / 2);
const PIPE_BOTTOM_EXTENT = fx(-10);
const PIPE_TOP_EXTENT = fx(10);
export const FIRST_PIPE_STEP = 180;
export const CURRENT_SIM_VERSION = 4;
/** A pipe can still touch the bird while its x is above this value. */
export const PIPE_CLEAR_X = -(PIPE_HALF_WIDTH + BIRD_RADIUS);
/** Where a sensible bird idles before the first pipe exists: the middle of the possible gap range. */
export const IDLE_TARGET_Y = Math.trunc((PIPE_MIN_Y + PIPE_MAX_Y) / 2);

export const flapVelocity = (simVersion: number): number => (simVersion < 3 ? FLAP_VY_V1 : FLAP_VY_V3);
export const fallCap = (simVersion: number): number | null =>
  simVersion < 3 ? null : simVersion < 4 ? FALL_CAP_V3 : FALL_CAP_V4;
export const halfGapFor = (simVersion: number, spawnCount: number): number =>
  simVersion < 2 ? HALF_GAP : spawnCount < OPENING_HALF_GAPS.length ? OPENING_HALF_GAPS[spawnCount] : HALF_GAP;

export type Phase = "getready" | "play" | "gameover";
export type DeathCause = "ground" | "pipeTop" | "pipeBottom";

export interface Pipe {
  x: number;
  gapY: number;
  halfGap: number;
  passed: boolean;
  /** True for a pipe the forecast had to invent because the game has not rolled it yet. */
  unknown?: boolean;
}

export interface SimState {
  phase: Phase;
  birdY: number;
  birdVy: number;
  pipes: Pipe[];
  score: number;
  playStep: number;
  spawnCount: number;
  simVersion: number;
  deathCause: DeathCause | null;
}

export function cloneState(s: SimState): SimState {
  return { ...s, pipes: s.pipes.map((p) => ({ ...p })) };
}

/** The game's `A_`: the bird's bottom went below the ground line. */
export const hitsGround = (birdY: number): boolean => birdY - BIRD_RADIUS < LOWEST_Y;

/** The game's `L_`: circle-versus-pipe test for the bird at x = 0. */
export function pipeCollision(birdY: number, pipe: Pipe): "top" | "bottom" | null {
  const left = pipe.x - PIPE_HALF_WIDTH;
  const right = pipe.x + PIPE_HALF_WIDTH;
  const dx = -Math.max(left, Math.min(0, right));
  if (Math.abs(dx) >= BIRD_RADIUS) return null;
  const bottomPipeTop = pipe.gapY - pipe.halfGap;
  const nearestBottom = Math.max(PIPE_BOTTOM_EXTENT, Math.min(birdY, bottomPipeTop));
  const dyBottom = birdY - nearestBottom;
  if (dx * dx + dyBottom * dyBottom < BIRD_RADIUS_SQ) return "bottom";
  const topPipeBottom = pipe.gapY + pipe.halfGap;
  const nearestTop = Math.max(topPipeBottom, Math.min(birdY, PIPE_TOP_EXTENT));
  const dyTop = birdY - nearestTop;
  return dx * dx + dyTop * dyTop < BIRD_RADIUS_SQ ? "top" : null;
}

/** The game's `flap()`, for the phases the agent cares about. */
export function flap(s: SimState): void {
  if (s.phase === "getready") {
    s.phase = "play";
    s.birdVy = flapVelocity(s.simVersion);
    return;
  }
  if (s.phase === "play") s.birdVy = flapVelocity(s.simVersion);
}

/**
 * The game's `step()`. `nextGapY` is consulted when a pipe spawns; return
 * null when the real value is unknown (the forecast then marks the pipe
 * `unknown` and ignores it for collisions).
 */
export function step(s: SimState, nextGapY: () => number | null): void {
  const wasPlaying = s.phase === "play";
  if (s.phase === "play" || s.phase === "gameover") {
    const cap = fallCap(s.simVersion);
    if (cap !== null && s.birdVy < -cap) s.birdVy = -cap;
    s.birdVy -= GRAVITY_PER_STEP;
    s.birdY += Math.trunc(s.birdVy / STEPS_PER_SECOND);
    if (hitsGround(s.birdY)) {
      s.birdY = LOWEST_Y + BIRD_RADIUS;
      s.birdVy = 0;
      if (s.phase === "play") {
        s.deathCause = "ground";
        s.phase = "gameover";
      }
    }
  } else {
    // "getready" bobbing: irrelevant to control, and we never forecast it.
    s.birdVy = 0;
  }
  if (s.phase === "play") {
    for (const p of s.pipes) {
      if (p.unknown) continue;
      const hit = pipeCollision(s.birdY, p);
      if (hit !== null) {
        s.deathCause = hit === "top" ? "pipeTop" : "pipeBottom";
        s.phase = "gameover";
        break;
      }
    }
  }
  if (s.phase === "play") advancePipes(s, nextGapY);
  if (wasPlaying) s.playStep += 1;
}

function advancePipes(s: SimState, nextGapY: () => number | null): void {
  const last = s.pipes[s.pipes.length - 1];
  const spawn = last ? PIPE_START_X - last.x >= PIPE_SPACING : s.playStep >= FIRST_PIPE_STEP;
  if (spawn) {
    const gapY = nextGapY();
    s.pipes.push({
      x: PIPE_START_X,
      gapY: gapY ?? IDLE_TARGET_Y,
      halfGap: halfGapFor(s.simVersion, s.spawnCount),
      passed: false,
      ...(gapY === null ? { unknown: true } : {}),
    });
    s.spawnCount += 1;
  }
  for (const p of s.pipes) {
    p.x -= PIPE_DX_PER_STEP;
    if (!p.passed && p.x <= 0) {
      p.passed = true;
      s.score += 1;
    }
  }
  if (s.pipes.length > 0 && s.pipes[0].x < PIPE_END_X) s.pipes.shift();
}

/** The first pipe the bird has not fully cleared yet, and the one after it. */
export function upcomingPipes(pipes: readonly Pipe[]): { target?: Pipe; following?: Pipe } {
  const idx = pipes.findIndex((p) => p.x > PIPE_CLEAR_X);
  if (idx < 0) return {};
  return { target: pipes[idx], following: pipes[idx + 1] };
}

/** Steps until the pipe's leading edge can first touch the bird (0 if already in range). */
export function stepsUntilPipe(pipe: Pipe): number {
  const gap = pipe.x - (PIPE_HALF_WIDTH + BIRD_RADIUS);
  return gap <= 0 ? 0 : Math.ceil(gap / PIPE_DX_PER_STEP);
}
