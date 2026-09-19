/**
 * The Tetris board model the agent plans with: Tetrimino shapes (SRS
 * orientations), hard-drop placements, locking with line clears, and the
 * board features (heights, holes, wells, transitions) that the planner turns
 * into words for Jev and into a ranking for the code safety net.
 *
 * Coordinates follow the game engine: x from 0 (left) to 9, y from 0 (bottom
 * row) upwards; rows 20..23 are the hidden buffer above the visible matrix.
 */
import { clearScore, fallMsForLevel, keepsBackToBack, perfectClearScore } from "./score.ts";

export type PieceType = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
export const PIECE_TYPES: readonly PieceType[] = ["I", "O", "T", "S", "Z", "J", "L"];

export const WIDTH = 10;
/** Rows the game keeps, including the hidden buffer above the visible area. */
export const HEIGHT = 24;
/** Rows the player can see. A piece locked fully above this line ends the game. */
export const VISIBLE_HEIGHT = 20;

export interface Cell {
  x: number;
  y: number;
}

/** WIDTH*HEIGHT cells, row-major from the bottom row; 0 = empty, 1..7 = the piece that left the mino (PIECE_TYPES index + 1). */
export type Board = Uint8Array;

/**
 * Shapes per orientation, normalized so the smallest x and y are 0. Orientation
 * 0 is the spawn orientation of the Super Rotation System; 1, 2 and 3 are
 * successive clockwise rotations. Shapes that repeat (I, S, Z after two turns,
 * O always) are listed anyway so an orientation index is always valid.
 */
const SHAPES: Record<PieceType, readonly (readonly Cell[])[]> = {
  I: [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }],
  ],
  O: [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
  ],
  T: [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }], // point up
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 1 }], // point right
    [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }], // point down
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 1 }], // point left
  ],
  S: [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
  ],
  Z: [
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
  ],
  J: [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
    [{ x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
  ],
  L: [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 0 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 0, y: 2 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
  ],
};

/** Orientations that produce distinct shapes: O has 1, I/S/Z have 2, T/J/L have 4. */
export function distinctOrientations(type: PieceType): number {
  return type === "O" ? 1 : type === "I" || type === "S" || type === "Z" ? 2 : 4;
}

export function shapeCells(type: PieceType, orientation: number): readonly Cell[] {
  return SHAPES[type][((orientation % 4) + 4) % 4];
}

export function shapeWidth(type: PieceType, orientation: number): number {
  return Math.max(...shapeCells(type, orientation).map((c) => c.x)) + 1;
}

export function shapeHeight(type: PieceType, orientation: number): number {
  return Math.max(...shapeCells(type, orientation).map((c) => c.y)) + 1;
}

/** A shape's cells normalized to min x = 0 and min y = 0, sorted, as a string key: lets two orientations be compared. */
export function normalizedKey(cells: readonly Cell[]): string {
  const minX = Math.min(...cells.map((c) => c.x));
  const minY = Math.min(...cells.map((c) => c.y));
  return cells
    .map((c) => `${c.x - minX},${c.y - minY}`)
    .sort()
    .join(";");
}

export function pieceCode(type: PieceType): number {
  return PIECE_TYPES.indexOf(type) + 1;
}

export function emptyBoard(): Board {
  return new Uint8Array(WIDTH * HEIGHT);
}

export function cloneBoard(b: Board): Board {
  return new Uint8Array(b);
}

export function cellAt(b: Board, x: number, y: number): number {
  if (x < 0 || x >= WIDTH || y < 0) return 1; // outside = solid
  if (y >= HEIGHT) return 0;
  return b[y * WIDTH + x];
}

export function setCell(b: Board, x: number, y: number, v: number): void {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  b[y * WIDTH + x] = v;
}

/** Builds a board from text rows (top row first, '.' = empty, anything else = filled). Shorter input leaves the top empty. */
export function parseBoard(rows: readonly string[]): Board {
  const b = emptyBoard();
  const n = rows.length;
  rows.forEach((row, i) => {
    const y = n - 1 - i;
    for (let x = 0; x < WIDTH && x < row.length; x++) {
      const ch = row[x];
      if (ch !== "." && ch !== " ") setCell(b, x, y, /[1-7]/.test(ch) ? Number(ch) : 8);
    }
  });
  return b;
}

/** Text rows, top row first, only the visible area unless `rows` says otherwise. */
export function boardToRows(b: Board, rows = VISIBLE_HEIGHT): string[] {
  const out: string[] = [];
  for (let y = rows - 1; y >= 0; y--) {
    let s = "";
    for (let x = 0; x < WIDTH; x++) s += b[y * WIDTH + x] ? "#" : ".";
    out.push(s);
  }
  return out;
}

export function fits(b: Board, cells: readonly Cell[], x: number, y: number): boolean {
  for (const c of cells) if (cellAt(b, x + c.x, y + c.y) !== 0) return false;
  return true;
}

export interface Placement {
  type: PieceType;
  orientation: number;
  /** Left-most column of the shape. */
  x: number;
  /** Bottom row of the shape after the drop. */
  y: number;
  /** Absolute cells the piece occupies once locked. */
  cells: Cell[];
  /** True when the piece is swapped in from hold (or the next piece when hold is empty) instead of the live piece. */
  viaHold: boolean;
  /** Key presses the plan needs, when the reachability pass measured it. */
  keys?: number;
}

/** Row where the shape comes to rest when dropped straight down from the top of the buffer; null when it cannot even enter. */
export function dropY(b: Board, type: PieceType, orientation: number, x: number, from = HEIGHT - 1): number | null {
  const cells = shapeCells(type, orientation);
  const top = from - (shapeHeight(type, orientation) - 1);
  if (!fits(b, cells, x, top)) return null;
  let y = top;
  while (y > 0 && fits(b, cells, x, y - 1)) y--;
  return y;
}

/** Every hard-drop placement of `type` reachable by rotating at the top and moving sideways. */
export function enumeratePlacements(b: Board, type: PieceType, viaHold = false): Placement[] {
  const out: Placement[] = [];
  for (let o = 0; o < distinctOrientations(type); o++) {
    const cells = shapeCells(type, o);
    const w = shapeWidth(type, o);
    for (let x = 0; x + w <= WIDTH; x++) {
      const y = dropY(b, type, o, x);
      if (y === null) continue;
      out.push({ type, orientation: o, x, y, cells: cells.map((c) => ({ x: x + c.x, y: y + c.y })), viaHold });
    }
  }
  return out;
}

export interface LockResult {
  board: Board;
  linesCleared: number;
  clearedRows: number[];
  /** True when the piece locked entirely above the visible matrix: the game ends. */
  toppedOut: boolean;
  /** Cells of the piece that were in a cleared row (Dellacherie's "eroded" cells). */
  erodedCells: number;
}

/** Locks a placement and clears complete rows. Never mutates `b`. */
export function lockPiece(b: Board, p: Placement): LockResult {
  const board = cloneBoard(b);
  const code = pieceCode(p.type);
  for (const c of p.cells) setCell(board, c.x, c.y, code);
  const toppedOut = p.cells.every((c) => c.y >= VISIBLE_HEIGHT);
  const clearedRows: number[] = [];
  for (let y = 0; y < HEIGHT; y++) {
    let full = true;
    for (let x = 0; x < WIDTH; x++) if (!board[y * WIDTH + x]) { full = false; break; }
    if (full) clearedRows.push(y);
  }
  const erodedCells = p.cells.filter((c) => clearedRows.includes(c.y)).length;
  if (clearedRows.length > 0) {
    let write = 0;
    for (let y = 0; y < HEIGHT; y++) {
      if (clearedRows.includes(y)) continue;
      if (write !== y) board.copyWithin(write * WIDTH, y * WIDTH, (y + 1) * WIDTH);
      write++;
    }
    board.fill(0, write * WIDTH);
  }
  return { board, linesCleared: clearedRows.length, clearedRows, toppedOut, erodedCells };
}

export interface BoardFeatures {
  /** Height of each column: 0 when empty, else top filled row + 1. */
  heights: number[];
  maxHeight: number;
  aggregateHeight: number;
  /** Empty cells with at least one filled cell above them in the same column. */
  holes: number;
  /** Columns that have at least one hole. */
  holeColumns: number[];
  /** Sum of height differences between neighbouring columns. */
  bumpiness: number;
  /** Depth of each column relative to its lower neighbour (walls count as tall); a well is a column deeper than 1 on both sides. */
  wells: { column: number; depth: number }[];
  /** Well depth per column, 0 when the column is not lower than its neighbours. Lets the tetris well be scored separately. */
  wellDepths: number[];
  /** Cumulative well depth (Dellacherie): sum over wells of 1 + 2 + ... + depth. */
  wellSum: number;
  rowTransitions: number;
  columnTransitions: number;
  /** Rows that are complete except for exactly one cell. */
  nearlyFullRows: number;
}

export function columnHeights(b: Board): number[] {
  const heights: number[] = [];
  for (let x = 0; x < WIDTH; x++) {
    let h = 0;
    for (let y = HEIGHT - 1; y >= 0; y--) if (b[y * WIDTH + x]) { h = y + 1; break; }
    heights.push(h);
  }
  return heights;
}

export function computeFeatures(b: Board): BoardFeatures {
  const heights = columnHeights(b);
  let holes = 0;
  const holeColumns: number[] = [];
  for (let x = 0; x < WIDTH; x++) {
    let colHoles = 0;
    for (let y = 0; y < heights[x]; y++) if (!b[y * WIDTH + x]) colHoles++;
    if (colHoles > 0) holeColumns.push(x);
    holes += colHoles;
  }
  let bumpiness = 0;
  for (let x = 0; x + 1 < WIDTH; x++) bumpiness += Math.abs(heights[x] - heights[x + 1]);
  const wells: { column: number; depth: number }[] = [];
  const wellDepths = new Array<number>(WIDTH).fill(0);
  let wellSum = 0;
  for (let x = 0; x < WIDTH; x++) {
    const left = x === 0 ? HEIGHT : heights[x - 1];
    const right = x === WIDTH - 1 ? HEIGHT : heights[x + 1];
    const depth = Math.min(left, right) - heights[x];
    if (depth >= 2) {
      wells.push({ column: x, depth });
    }
    if (depth > 0) {
      wellDepths[x] = depth;
      wellSum += (depth * (depth + 1)) / 2;
    }
  }
  let rowTransitions = 0;
  for (let y = 0; y < VISIBLE_HEIGHT; y++) {
    let prev = 1; // the wall
    for (let x = 0; x < WIDTH; x++) {
      const v = b[y * WIDTH + x] ? 1 : 0;
      if (v !== prev) rowTransitions++;
      prev = v;
    }
    if (prev !== 1) rowTransitions++;
  }
  let columnTransitions = 0;
  for (let x = 0; x < WIDTH; x++) {
    let prev = 1; // the floor
    for (let y = 0; y < HEIGHT; y++) {
      const v = b[y * WIDTH + x] ? 1 : 0;
      if (v !== prev) columnTransitions++;
      prev = v;
    }
  }
  let nearlyFullRows = 0;
  for (let y = 0; y < VISIBLE_HEIGHT; y++) {
    let empty = 0;
    for (let x = 0; x < WIDTH; x++) if (!b[y * WIDTH + x]) empty++;
    if (empty === 1) nearlyFullRows++;
  }
  return {
    heights,
    maxHeight: Math.max(...heights),
    aggregateHeight: heights.reduce((a, v) => a + v, 0),
    holes,
    holeColumns,
    bumpiness,
    wells,
    wellDepths,
    wellSum,
    rowTransitions,
    columnTransitions,
    nearlyFullRows,
  };
}

export interface Weights {
  landingHeight: number;
  erodedCells: number;
  rowTransitions: number;
  columnTransitions: number;
  holes: number;
  wellSum: number;
  /** Extra penalty per hole created by this placement (on top of the total-holes term). */
  newHoles: number;
  /** Bonus per line cleared, on top of the eroded-cells term. */
  lines: number;
  /** Bonus for a four-line clear. */
  tetris: number;
  /** Weight on the points the clear actually scores, taken at level 1 so the balance does not drift with the level. */
  points: number;
  /** Bonus per row that is full except the tetris well: a row already paid for, waiting for an I. */
  readyRows: number;
  /** Penalty per cell sitting in the tetris well on a row that is not otherwise complete: it blocks the tetris. */
  wellBlocked: number;
  /** Penalty for a clear of one to three lines, which spends rows cheaply and drops the back-to-back chain. */
  nonTetrisClear: number;
  /** Penalty per unit of surface unevenness. A flat surface is what keeps the board reachable once gravity is fast. */
  bumpiness: number;
  /** Penalty on the square of how far the stack rises above `SAFE_HEIGHT`. Square, so danger grows faster than height. */
  heightRisk: number;
  /**
   * Penalty for spending an I piece anywhere but the well while the well is
   * usable. The I is the only piece that scores a tetris, and one arrives
   * roughly every seven pieces, so laying one flat costs a whole tetris.
   */
  wasteI: number;
  /**
   * Penalty for leaving a board an I piece can no longer be walked to the well
   * on. That is how games are lost: once the well is out of reach nothing can
   * be cleared, the stack rises, and the rising stack cuts the reach further.
   */
  wellUnreachable: number;
  /**
   * Penalty per key press a plan needs, applied only once gravity is instant.
   * Every step of a walk is a chance for the model of where the piece is to be
   * a column out, and a walk that gets blocked ends with the piece locking
   * somewhere nobody chose. Costs a little stacking quality to buy accuracy.
   */
  keyCost: number;
}

/** Dellacherie's weights (a strong hand-tuned survival heuristic), plus small extras for line clears. */
export const DEFAULT_WEIGHTS: Weights = {
  landingHeight: -4.5,
  erodedCells: 3.4,
  rowTransitions: -3.2,
  columnTransitions: -9.3,
  holes: -7.9,
  wellSum: -3.4,
  newHoles: -4,
  lines: 1,
  tetris: 12,
  points: 0,
  readyRows: 0,
  wellBlocked: 0,
  nonTetrisClear: 0,
  bumpiness: 0,
  heightRisk: 0,
  wasteI: 0,
  wellUnreachable: 0,
  keyCost: 0,
};

/**
 * The weights that actually chase 1,000,000. Marathon is 300 lines and no
 * more, so what matters is not how many lines are cleared but what each one is
 * worth: a back-to-back tetris pays 300 x level per line against 100 x level
 * for a single. So partial clears earn nothing here (`erodedCells` and `lines`
 * are 0) and are taxed (`nonTetrisClear`), rows stacked flat against the well
 * are paid for in advance (`readyRows`), anything that caps the well is
 * treated as nearly as bad as a hole, and an I piece spent anywhere but the
 * well is charged the tetris it threw away.
 *
 * Every number here was measured with `--simulate`, not guessed. The ones that
 * matter most, in order: guarding the well (`wellBlocked`, `nonTetrisClear`)
 * was worth about 170,000; hoarding the I piece (`wasteI`) about 70,000; and
 * capping `readyRows` at four -- see `READY_ROWS_PAID` -- was what stopped the
 * agent building a tower to the ceiling while it waited for a piece that only
 * ever clears four rows anyway.
 */
export const TETRIS_WEIGHTS: Weights = {
  landingHeight: -3.0,
  erodedCells: 0,
  rowTransitions: -3.2,
  columnTransitions: -9.3,
  holes: -20,
  wellSum: -1.0,
  newHoles: -13,
  lines: 0,
  tetris: 80,
  points: 0.02,
  readyRows: 11,
  wellBlocked: -60,
  nonTetrisClear: -40,
  bumpiness: -1.2,
  heightRisk: -1.5,
  wasteI: -45,
  wellUnreachable: -45,
  keyCost: -1.0,
};

/**
 * How tall the stack may get before height starts to dominate everything else,
 * when there is time to place pieces freely. A tetris only ever takes four
 * rows off, so a stack much above this cannot be brought back down by the
 * strategy alone.
 */
export const SAFE_HEIGHT = 13;

/**
 * The same limit, but against the clock. A piece can only be steered while it
 * is in the air, and the air is whatever is left between the spawn rows and
 * the top of the stack. So the faster gravity gets, the lower the stack has to
 * be kept to keep the board reachable at all.
 */
export function safeHeightFor(fallMsPerRow: number): number {
  if (fallMsPerRow >= 300) return SAFE_HEIGHT;
  if (fallMsPerRow >= 100) return 11;
  if (fallMsPerRow >= 30) return 9;
  if (fallMsPerRow >= 10) return 8;
  return 7;
}

/** Ready rows beyond this are just stack height: one tetris only ever clears four. */
export const READY_ROWS_PAID = 4;

export interface WellStats {
  column: number;
  /** Rows that are full except the well column: an I dropped in clears them all. */
  readyRows: number;
  /** Filled cells in the well column on rows that are not otherwise complete. Each one blocks a tetris. */
  blocked: number;
  /** Empty cells in the well column below the surrounding stack, i.e. how deep the well runs. */
  depth: number;
}

/** How the board stands against a well in `column`. */
export function wellStats(b: Board, column: number): WellStats {
  let readyRows = 0;
  let blocked = 0;
  for (let y = 0; y < VISIBLE_HEIGHT; y++) {
    let othersFull = true;
    for (let x = 0; x < WIDTH; x++) {
      if (x === column) continue;
      if (!b[y * WIDTH + x]) { othersFull = false; break; }
    }
    const wellFilled = Boolean(b[y * WIDTH + column]);
    if (othersFull && !wellFilled) readyRows++;
    if (wellFilled && !othersFull) blocked++;
  }
  const heights = columnHeights(b);
  const around = heights.filter((_, x) => x !== column);
  const depth = Math.max(0, Math.min(...around) - heights[column]);
  return { column, readyRows, blocked, depth };
}

/**
 * Which column to keep open. An edge is worth a lot: a well against a wall has
 * only one neighbour to stack against, and at 20G no piece ever has to be
 * walked across it. The column already lowest wins; `preferred` keeps the
 * choice stable from piece to piece unless it has been buried.
 */
export function chooseWellColumn(b: Board, preferred?: number): number {
  const heights = columnHeights(b);
  const score = (x: number): number => {
    const stats = wellStats(b, x);
    const edge = x === 0 || x === WIDTH - 1 ? 6 : 0;
    return edge + stats.readyRows * 3 + stats.depth - heights[x] - stats.blocked * 4;
  };
  if (preferred !== undefined && preferred >= 0 && preferred < WIDTH) {
    const current = wellStats(b, preferred);
    // Moving the well throws away every row already stacked against it, so it
    // only happens when the current one has been buried and has nothing banked.
    if (current.blocked === 0 || current.readyRows > 0) return preferred;
    const best = [0, WIDTH - 1].reduce((a, x) => (score(x) > score(a) ? x : a), 0);
    return score(best) > score(preferred) + 25 ? best : preferred;
  }
  let best = WIDTH - 1;
  for (let x = 0; x < WIDTH; x++) if (score(x) > score(best)) best = x;
  return best;
}

/** What the placement is being judged against: the well, the level and the chain. */
export interface EvalContext {
  /** Column kept open for the I piece; -1 turns the tetris terms off. */
  wellColumn: number;
  /** Level being played (1-based), for the points a clear is worth. */
  level: number;
  /** True when the next tetris would score 1.5x. */
  backToBack: boolean;
  /** Clears chained so far, for the combo bonus. */
  combo: number;
  /** Gravity in ms per row. It sets how tall the stack may safely get, because it sets how far a piece can still be steered. */
  fallMs?: number | null;
}

export const NO_CONTEXT: EvalContext = { wellColumn: -1, level: 1, backToBack: false, combo: 0 };

export interface Evaluation {
  placement: Placement;
  lock: LockResult;
  before: BoardFeatures;
  after: BoardFeatures;
  /** Height of the piece's centre when it lands, in rows from the floor. */
  landingHeight: number;
  newHoles: number;
  score: number;
  /** Points the game awards for this placement: the clear (with the level and back-to-back multipliers) plus the hard drop. */
  points: number;
  /** True when the placement leaves the back-to-back chain alive (it clears four, or clears nothing). */
  keepsChain: boolean;
  /** The well before and after, when a well column was given. */
  well: { before: WellStats; after: WellStats } | null;
  /** Key presses the plan needs, filled in by the reachability pass; null when it was not measured. */
  keys: number | null;
  /** Set by the planner when this placement would leave the well unreachable for an I piece. */
  wellOutOfReach?: boolean;
}

export function evaluatePlacement(b: Board, before: BoardFeatures, p: Placement, w: Weights = DEFAULT_WEIGHTS, ctx: EvalContext = NO_CONTEXT): Evaluation {
  const lock = lockPiece(b, p);
  const after = computeFeatures(lock.board);
  const ys = p.cells.map((c) => c.y);
  const landingHeight = (Math.min(...ys) + Math.max(...ys)) / 2 + 0.5;
  const newHoles = Math.max(0, after.holes - before.holes);
  const lines = lock.linesCleared;
  const well = ctx.wellColumn >= 0 ? { before: wellStats(b, ctx.wellColumn), after: wellStats(lock.board, ctx.wellColumn) } : null;
  // A well the strategy is keeping open must not be counted as a defect by the
  // generic well term, or every placement would try to fill it in.
  const keptWellDepth = ctx.wellColumn >= 0 ? after.wellDepths[ctx.wellColumn] : 0;
  const wellSumOutsideTheWell = after.wellSum - (keptWellDepth * (keptWellDepth + 1)) / 2;
  // What the game will actually add to the score for this placement. Hard-drop
  // points depend on how far the piece falls, which is a handful of points and
  // never worth choosing on, so they are left out.
  // A clear that leaves nothing behind is paid a large bonus on top.
  const perfectClear = lines > 0 && after.aggregateHeight === 0;
  const points = clearScore(lines, ctx.level, ctx.backToBack, ctx.combo) + (perfectClear ? perfectClearScore(lines, ctx.level, ctx.backToBack) : 0);
  let score =
    w.landingHeight * landingHeight +
    w.erodedCells * lines * lock.erodedCells +
    w.rowTransitions * after.rowTransitions +
    w.columnTransitions * after.columnTransitions +
    w.holes * after.holes +
    w.wellSum * wellSumOutsideTheWell +
    w.newHoles * newHoles +
    w.lines * lines +
    (lines === 4 ? w.tetris : 0);
  // Points at level 1, so the same weights behave the same way on level 3 and
  // on level 28; the level multiplier is common to every option anyway.
  if (w.points !== 0) score += w.points * (clearScore(lines, 1, ctx.backToBack, 0) + (perfectClear ? perfectClearScore(lines, 1, ctx.backToBack) : 0));
  if (well) {
    // Only the first four ready rows are paid for. Beyond that they are not
    // progress towards anything -- a tetris still only clears four -- they are
    // just stack height, and rewarding them builds a tower to the ceiling.
    const paid = (n: number): number => Math.min(READY_ROWS_PAID, n);
    score += w.readyRows * (paid(well.after.readyRows) - paid(well.before.readyRows));
    score += w.wellBlocked * (well.after.blocked - well.before.blocked);
    if (lines > 0 && lines < 4) score += w.nonTetrisClear;
  }
  // An I laid flat while the well is open and waiting is a tetris thrown away.
  // Holding it instead costs nothing, because the piece hold brings out has to
  // be placed anyway.
  if (well && w.wasteI !== 0 && p.type === "I" && lines < 4 && well.before.blocked === 0) {
    const usesTheWell = p.cells.some((c) => c.x === ctx.wellColumn);
    if (!usesTheWell) score += w.wasteI;
  }
  if (w.keyCost !== 0 && p.keys !== undefined && (ctx.fallMs ?? fallMsForLevel(ctx.level)) <= 0) score += w.keyCost * p.keys;
  score += w.bumpiness * after.bumpiness;
  // Height risk is squared, so it is nearly free while the stack is low and
  // overwhelms the strategy once it is not.
  const over = Math.max(0, after.maxHeight - safeHeightFor(ctx.fallMs ?? fallMsForLevel(ctx.level)));
  score += w.heightRisk * over * over;
  if (lock.toppedOut) score -= 10_000;
  return {
    placement: p,
    lock,
    before,
    after,
    landingHeight,
    newHoles,
    score,
    points,
    keepsChain: lines === 0 || keepsBackToBack(lines),
    well,
    keys: null,
  };
}

/** All placements of `type` on `b`, evaluated and sorted best first. */
export function evaluateAll(b: Board, type: PieceType, w: Weights = DEFAULT_WEIGHTS, viaHold = false, before = computeFeatures(b), ctx: EvalContext = NO_CONTEXT): Evaluation[] {
  return enumeratePlacements(b, type, viaHold)
    .map((p) => evaluatePlacement(b, before, p, w, ctx))
    .sort((a, c) => c.score - a.score);
}

/** Evaluates placements that were already filtered for reachability, keeping each one's key cost. */
export function evaluateReachable(b: Board, placements: readonly (Placement & { keys?: number })[], w: Weights, before: BoardFeatures, ctx: EvalContext): Evaluation[] {
  return placements
    .map((p) => {
      const ev = evaluatePlacement(b, before, p, w, ctx);
      ev.keys = p.keys ?? null;
      return ev;
    })
    .sort((a, c) => c.score - a.score);
}
