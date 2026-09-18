/**
 * The Tetris board model the agent plans with: Tetrimino shapes (SRS
 * orientations), hard-drop placements, locking with line clears, and the
 * board features (heights, holes, wells, transitions) that the planner turns
 * into words for Jev and into a ranking for the code safety net.
 *
 * Coordinates follow the game engine: x from 0 (left) to 9, y from 0 (bottom
 * row) upwards; rows 20..23 are the hidden buffer above the visible matrix.
 */

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
  let wellSum = 0;
  for (let x = 0; x < WIDTH; x++) {
    const left = x === 0 ? HEIGHT : heights[x - 1];
    const right = x === WIDTH - 1 ? HEIGHT : heights[x + 1];
    const depth = Math.min(left, right) - heights[x];
    if (depth >= 2) {
      wells.push({ column: x, depth });
    }
    if (depth > 0) wellSum += (depth * (depth + 1)) / 2;
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
};

export interface Evaluation {
  placement: Placement;
  lock: LockResult;
  before: BoardFeatures;
  after: BoardFeatures;
  /** Height of the piece's centre when it lands, in rows from the floor. */
  landingHeight: number;
  newHoles: number;
  score: number;
}

export function evaluatePlacement(b: Board, before: BoardFeatures, p: Placement, w: Weights = DEFAULT_WEIGHTS): Evaluation {
  const lock = lockPiece(b, p);
  const after = computeFeatures(lock.board);
  const ys = p.cells.map((c) => c.y);
  const landingHeight = (Math.min(...ys) + Math.max(...ys)) / 2 + 0.5;
  const newHoles = Math.max(0, after.holes - before.holes);
  let score =
    w.landingHeight * landingHeight +
    w.erodedCells * lock.linesCleared * lock.erodedCells +
    w.rowTransitions * after.rowTransitions +
    w.columnTransitions * after.columnTransitions +
    w.holes * after.holes +
    w.wellSum * after.wellSum +
    w.newHoles * newHoles +
    w.lines * lock.linesCleared +
    (lock.linesCleared === 4 ? w.tetris : 0);
  if (lock.toppedOut) score -= 10_000;
  return { placement: p, lock, before, after, landingHeight, newHoles, score };
}

/** All placements of `type` on `b`, evaluated and sorted best first. */
export function evaluateAll(b: Board, type: PieceType, w: Weights = DEFAULT_WEIGHTS, viaHold = false, before = computeFeatures(b)): Evaluation[] {
  return enumeratePlacements(b, type, viaHold)
    .map((p) => evaluatePlacement(b, before, p, w))
    .sort((a, c) => c.score - a.score);
}
