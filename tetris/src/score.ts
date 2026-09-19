/**
 * The game's own scoring and level rules, read out of the engine rather than
 * assumed (see `--check-rules`, which re-reads them from a live page).
 *
 * They decide the whole strategy, so they live in code as exact numbers:
 *
 *  - Marathon is 30 levels of 10 lines. `endGameAtMaxLevelCompletion` is true,
 *    so the game ENDS when level 30 is completed: the score is bounded, and
 *    300 lines is all anyone ever gets.
 *  - A clear is worth `base x level`, and `multiplyScoreByLevel` is true.
 *  - Two tetrises in a row (nothing else in between) keep the back-to-back
 *    chain alive and the second one is worth 1.5x.
 *
 * That makes one line cleared as part of a back-to-back tetris worth
 * 300 x level, against 100 x level for a single: three times as much. Taking
 * every clear that is offered tops out near 465,000, so the only route to
 * 1,000,000 is tetrises, in a chain, nearly all the way to level 30.
 */

export const MAX_LEVEL = 30;
export const LINES_PER_LEVEL = 10;
export const TOTAL_LINES = MAX_LEVEL * LINES_PER_LEVEL;

/** Gravity in ms per row, per level (index 0 = level 1). 0 from level 20: the piece is on the stack the frame it spawns. */
export const FALL_MS: readonly number[] = [
  1000, 793, 618, 473, 355, 262, 190, 135, 94, 64,
  43, 28, 18, 11, 7, 4, 3, 2, 1, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

/** How long a piece rests before it locks, per level (index 0 = level 1). */
export const LOCK_MS: readonly number[] = [
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 450,
  400, 350, 300, 250, 200, 195, 184, 167, 151, 150,
];

/**
 * Moving or rotating restarts the lock timer, but only this many times: the
 * 16th input locks the piece wherever it stands. Measured on the live game at
 * level 30 (15 moves landed, every time), and it is the guideline value.
 */
export const MOVE_RESET_LIMIT = 15;

/** Base points per clear, before the level multiplier. */
export const CLEAR_POINTS: Readonly<Record<number, number>> = { 1: 100, 2: 300, 3: 500, 4: 800 };

/** Points per row a hard drop travels. The level multiplier does NOT apply (`applyMultiplierToSoftAndHardDrop` is false). */
export const HARD_DROP_POINTS_PER_ROW = 2;
export const SOFT_DROP_POINTS_PER_ROW = 1;
/** Points per extra clear in a combo: `COMBO_POINTS x comboCount x level`. */
export const COMBO_POINTS = 50;
/** A back-to-back clear scores 1.5x (`backToBackBonusMultiplierFXPT` = 1500). */
export const BACK_TO_BACK_MULTIPLIER = 1.5;

/**
 * A clear that leaves the matrix completely empty is paid separately, and
 * enormously: these are base points, multiplied by the level like any other
 * clear. A back-to-back tetris that empties the board pays 3,200 x level --
 * at level 25 that is 80,000 from a single piece, about six ordinary
 * back-to-back tetrises. Rare, never worth building towards at the cost of the
 * well, but always worth taking when the board happens to offer one.
 */
export const PERFECT_CLEAR_POINTS: Readonly<Record<number, number>> = { 1: 800, 2: 1200, 3: 1800, 4: 2000 };
export const PERFECT_CLEAR_BACK_TO_BACK_TETRIS = 3200;

/** What the game pays for a clear that empties the matrix. */
export function perfectClearScore(linesCleared: number, level: number, backToBackActive: boolean): number {
  if (linesCleared <= 0) return 0;
  const base = linesCleared === 4 && backToBackActive
    ? PERFECT_CLEAR_BACK_TO_BACK_TETRIS
    : PERFECT_CLEAR_POINTS[Math.min(4, linesCleared)] ?? 0;
  return base * level;
}

export function fallMsForLevel(level: number): number {
  return FALL_MS[Math.min(MAX_LEVEL, Math.max(1, level)) - 1];
}

export function lockMsForLevel(level: number): number {
  return LOCK_MS[Math.min(MAX_LEVEL, Math.max(1, level)) - 1];
}

/**
 * True when gravity is instant, so a piece is resting on the stack before the
 * agent can act: it can only be rotated and walked along the surface.
 */
export function isTwentyG(level: number): boolean {
  return fallMsForLevel(level) <= 0;
}

/** Only a tetris keeps the back-to-back chain alive here (the agent never spins a T deliberately). */
export function keepsBackToBack(linesCleared: number): boolean {
  return linesCleared === 4;
}

/**
 * Points a clear is worth, exactly as the game awards them. `comboCount` is
 * the chain length BEFORE this clear (the game's `mCurrentComboCount`), so the
 * first clear of a chain adds no combo bonus.
 */
export function clearScore(linesCleared: number, level: number, backToBackActive: boolean, comboCount = 0): number {
  if (linesCleared <= 0) return 0;
  const base = CLEAR_POINTS[Math.min(4, linesCleared)] ?? 0;
  const bonus = backToBackActive && keepsBackToBack(linesCleared) ? BACK_TO_BACK_MULTIPLIER : 1;
  const combo = comboCount > 0 ? COMBO_POINTS * comboCount * level : 0;
  return Math.floor(base * level * bonus) + combo;
}

/** The level a game is on after `lines` cleared from `startLevel`, capped at 30. */
export function levelAfterLines(lines: number, startLevel = 1): number {
  return Math.min(MAX_LEVEL, startLevel + Math.floor(Math.max(0, lines) / LINES_PER_LEVEL));
}

/** Lines still to clear before the game ends, from the level and the lines left in it. */
export function linesLeftInGame(level: number, linesToNextLevel: number): number {
  return Math.max(0, (MAX_LEVEL - level) * LINES_PER_LEVEL + linesToNextLevel);
}

/**
 * The most that can still be scored from here: every remaining line cleared
 * four at a time, back to back. Used to tell the model (and the operator)
 * whether the target is still reachable at all.
 */
export function bestRemainingScore(level: number, linesToNextLevel: number, backToBackActive: boolean): number {
  let lines = linesLeftInGame(level, linesToNextLevel);
  let at = level;
  let toNext = linesToNextLevel;
  let b2b = backToBackActive;
  let total = 0;
  while (lines > 0) {
    const cleared = Math.min(4, lines);
    total += clearScore(cleared, at, b2b);
    b2b = keepsBackToBack(cleared);
    lines -= cleared;
    toNext -= cleared;
    while (toNext <= 0 && at < MAX_LEVEL) {
      at += 1;
      toNext += LINES_PER_LEVEL;
    }
  }
  return total;
}
