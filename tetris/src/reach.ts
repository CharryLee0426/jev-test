/**
 * Which placements a piece can actually reach.
 *
 * This is not a question of level but of how long the piece stays in the air.
 * A piece can be slid sideways freely only while it is still falling, so what
 * matters is the fall time from the spawn rows down to the stack against the
 * time a key press takes:
 *
 *  - at level 1 a row takes 1000 ms, so there is time for any move;
 *  - by level 14 a row takes 11 ms, so a piece with five rows of air above the
 *    stack is resting 55 ms after it spawns -- about three key presses' worth;
 *  - from level 20 a row takes 0 ms: the piece is on the stack in the frame it
 *    spawns (measured: it then locks 150 ms later if untouched).
 *
 * So `freeColumnSteps` works out how many columns the piece can be moved while
 * it is still in the air, and everything past that has to be walked: rotated
 * where it stands and stepped sideways along the surface, falling again after
 * every step. A walk can go down a slope but never up one, so a tall column is
 * a wall. That is why the tetris strategy has to keep the surface flat -- on a
 * jagged stack most of the board simply stops being reachable.
 *
 * The second limit is the lock timer. It restarts on every move or rotation,
 * but only `MOVE_RESET_LIMIT` times (measured: exactly 15 moves land at level
 * 30, then the piece locks). So a plan that needs more key presses than that
 * cannot be executed at all, whatever the board looks like.
 */
import { MOVE_RESET_LIMIT, fallMsForLevel } from "./score.ts";
import {
  VISIBLE_HEIGHT,
  WIDTH,
  columnHeights,
  distinctOrientations,
  dropY,
  enumeratePlacements,
  fits,
  shapeCells,
  shapeWidth,
  type Board,
  type PieceType,
  type Placement,
} from "./tetris.ts";

/** Left-most column a piece occupies when it spawns (SRS: the 3-wide box at columns 4-6, the O at 5-6). */
export function spawnMinX(type: PieceType): number {
  return type === "O" ? 4 : 3;
}

/**
 * Where the piece ends up horizontally after being rotated at the top, which
 * is where a walk starts. The executor corrects the column afterwards, so this
 * only has to be close: `KEY_MARGIN` covers the error.
 */
export function startColumn(type: PieceType, orientation: number): number {
  const maxX = WIDTH - shapeWidth(type, orientation);
  // The I piece is the one that moves noticeably: rotating it clockwise at
  // spawn leaves the vertical bar in column 6 (measured on the live game).
  const base = type === "I" && orientation % 2 === 1 ? 5 : spawnMinX(type);
  return Math.max(0, Math.min(maxX, base));
}

/** Key presses that turn a spawned piece into `orientation` (clockwise, or one counter-clockwise for 3). */
export function rotationKeys(orientation: number): number {
  const o = ((orientation % 4) + 4) % 4;
  return o === 0 ? 0 : o === 2 ? 2 : 1;
}

/** Spare presses kept back for the rotation nudging the piece a column or two sideways. */
export const KEY_MARGIN = 2;

/**
 * Columns the piece can walk to in `orientation`, starting from `startX` where
 * it first comes to rest. Each step shifts one column at the current height and
 * then falls; a column it cannot shift into blocks everything beyond it.
 */
export function walkableColumns(board: Board, type: PieceType, orientation: number, startX: number): number[] {
  const cells = shapeCells(type, orientation);
  const maxX = WIDTH - shapeWidth(type, orientation);
  if (startX < 0 || startX > maxX) return [];
  const restY = dropY(board, type, orientation, startX);
  if (restY === null) return [];
  const reached = [startX];
  for (const dir of [-1, 1]) {
    let x = startX;
    let y = restY;
    for (;;) {
      const nx = x + dir;
      if (nx < 0 || nx > maxX) break;
      // The shift happens at the height the piece is at now; if the shape does
      // not fit there, the column beside it is a wall.
      if (!fits(board, cells, nx, y)) break;
      let ny = y;
      while (ny > 0 && fits(board, cells, nx, ny - 1)) ny--;
      reached.push(nx);
      x = nx;
      y = ny;
    }
  }
  return reached.sort((a, b) => a - b);
}

export interface ReachOptions {
  /** The level being played; sets the gravity when `fallMs` is not given. */
  level: number;
  /** Gravity in ms per row, when the game reports it; otherwise the level's own value is used. */
  fallMs?: number | null;
  /** Milliseconds a key press costs, which is what the fall time is spent on. */
  keyDelayMs?: number;
  /** True when the placement swaps the piece in from hold. */
  viaHold?: boolean;
  /** Presses available before the piece locks itself. */
  keyBudget?: number;
}

/** The row a piece's lowest cell starts on: the bottom of the spawn box above the visible matrix. */
export const SPAWN_ROW = VISIBLE_HEIGHT;

/**
 * How many columns the piece can still be moved through the air before it
 * lands, given the gravity and how much room there is above the stack. Once
 * this runs out the piece is on the surface and can only be walked.
 */
export function freeColumnSteps(fallMs: number, rowsOfAir: number, keyDelayMs: number): number {
  if (fallMs <= 0) return 0;
  if (keyDelayMs <= 0) return WIDTH;
  const msInTheAir = Math.max(0, rowsOfAir) * fallMs;
  // Half the air time is kept back: the plan also has to rotate, and the
  // snapshot that started it is already a frame or two old.
  return Math.max(0, Math.floor((msInTheAir * 0.5) / keyDelayMs));
}

/** A placement plus what it costs to execute. */
export interface ReachablePlacement extends Placement {
  /** Key presses the plan needs: rotations, steps sideways and the hard drop. */
  keys: number;
}

/**
 * Every placement the piece can actually be brought to on this board. Below
 * 20G that is all of them; at 20G it is the walk from the spawn column, in
 * each orientation, within the key budget.
 */
export function reachablePlacements(board: Board, type: PieceType, opts: ReachOptions): ReachablePlacement[] {
  const viaHold = opts.viaHold ?? false;
  const budget = opts.keyBudget && opts.keyBudget > 0 ? opts.keyBudget : MOVE_RESET_LIMIT;
  const fallMs = opts.fallMs ?? fallMsForLevel(opts.level);
  const keyDelayMs = opts.keyDelayMs ?? 16;
  const stackTop = Math.max(...columnHeights(board));
  const free = freeColumnSteps(fallMs, SPAWN_ROW - stackTop, keyDelayMs);
  if (free >= WIDTH) {
    // Slow enough that the piece can be put anywhere before it lands.
    return enumeratePlacements(board, type, viaHold).map((p) => ({
      ...p,
      keys: rotationKeys(p.orientation) + Math.abs(p.x - startColumn(type, p.orientation)) + 1,
    }));
  }
  const seen = new Set<string>();
  const out: ReachablePlacement[] = [];
  for (let o = 0; o < distinctOrientations(type); o++) {
    const home = startColumn(type, o);
    const turns = rotationKeys(o);
    const maxX = WIDTH - shapeWidth(type, o);
    // Columns the piece can still be carried to through the air. From there it
    // drops onto the stack and any further travel has to be walked.
    for (let drop = Math.max(0, home - free); drop <= Math.min(maxX, home + free); drop++) {
      const airSteps = Math.abs(drop - home);
      for (const x of walkableColumns(board, type, o, drop)) {
        const keys = turns + airSteps + Math.abs(x - drop) + 1;
        if (keys + KEY_MARGIN > budget) continue;
        const key = `${o}:${x}`;
        const y = dropY(board, type, o, x);
        if (y === null) continue;
        const existing = seen.has(key);
        if (existing) {
          // Keep the cheapest route to the same placement.
          const at = out.find((p) => p.orientation === o && p.x === x)!;
          if (keys < at.keys) at.keys = keys;
          continue;
        }
        seen.add(key);
        out.push({
          type,
          orientation: o,
          x,
          y,
          cells: shapeCells(type, o).map((c) => ({ x: x + c.x, y: y + c.y })),
          viaHold,
          keys,
        });
      }
    }
  }
  return out;
}

/**
 * Placements still open to a piece that is already resting on the stack, from
 * its real cells rather than the spawn column. Used for the piece on screen
 * when a plan has to be remade mid-flight.
 */
export function reachableFromLive(board: Board, type: PieceType, liveCells: readonly (readonly number[])[], opts: ReachOptions): ReachablePlacement[] {
  const minX = Math.min(...liveCells.map((c) => c[0]));
  const budget = opts.keyBudget && opts.keyBudget > 0 ? opts.keyBudget : MOVE_RESET_LIMIT;
  const out: ReachablePlacement[] = [];
  for (let o = 0; o < distinctOrientations(type); o++) {
    // A rotation where it stands keeps the piece in roughly the same columns.
    const startX = Math.max(0, Math.min(WIDTH - shapeWidth(type, o), minX));
    const turns = rotationKeys(o);
    for (const x of walkableColumns(board, type, o, startX)) {
      const keys = turns + Math.abs(x - startX) + 1;
      if (keys + KEY_MARGIN > budget) continue;
      const y = dropY(board, type, o, x);
      if (y === null) continue;
      out.push({ type, orientation: o, x, y, cells: shapeCells(type, o).map((c) => ({ x: x + c.x, y: y + c.y })), viaHold: opts.viaHold ?? false, keys });
    }
  }
  return out;
}
