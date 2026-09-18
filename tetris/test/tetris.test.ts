import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PIECE_TYPES,
  VISIBLE_HEIGHT,
  WIDTH,
  boardToRows,
  computeFeatures,
  distinctOrientations,
  dropY,
  emptyBoard,
  enumeratePlacements,
  evaluateAll,
  lockPiece,
  normalizedKey,
  parseBoard,
  shapeCells,
} from "../src/tetris.ts";

test("every orientation of every piece has four connected cells", () => {
  for (const t of PIECE_TYPES) {
    for (let o = 0; o < 4; o++) {
      const cells = shapeCells(t, o);
      assert.equal(cells.length, 4, `${t}/${o}`);
      assert.equal(Math.min(...cells.map((c) => c.x)), 0);
      assert.equal(Math.min(...cells.map((c) => c.y)), 0);
      assert.equal(new Set(cells.map((c) => `${c.x},${c.y}`)).size, 4);
    }
    // 90 degree rotations cycle: orientation 2 of I/S/Z equals 0, and O never changes.
    assert.equal(normalizedKey(shapeCells(t, 0)) === normalizedKey(shapeCells(t, 2)), distinctOrientations(t) <= 2, t);
  }
});

test("placements on an empty board: every orientation times every column that fits", () => {
  const b = emptyBoard();
  assert.equal(enumeratePlacements(b, "I").length, 7 + 10);
  assert.equal(enumeratePlacements(b, "O").length, 9);
  assert.equal(enumeratePlacements(b, "T").length, 8 + 9 + 8 + 9);
  assert.equal(enumeratePlacements(b, "S").length, 8 + 9);
  for (const p of enumeratePlacements(b, "L")) assert.equal(p.y, 0, "everything lands on the floor");
});

test("drops stop on the stack and refuse blocked columns", () => {
  const b = parseBoard([
    "#.........",
    "#.........",
    "#.........",
    "##........",
  ]);
  assert.equal(dropY(b, "O", 0, 0), 4);
  assert.equal(dropY(b, "O", 0, 1), 1);
  assert.equal(dropY(b, "O", 0, 2), 0);
  // A column filled to the ceiling cannot be entered at all.
  const full = emptyBoard();
  for (let y = 0; y < 24; y++) full[y * WIDTH + 3] = 1;
  assert.equal(dropY(full, "I", 0, 0), null);
  assert.equal(dropY(full, "I", 1, 0), 0);
});

test("locking clears complete rows and reports eroded cells", () => {
  const b = parseBoard([
    "########..",
    "#########.",
  ]);
  const [vertical] = enumeratePlacements(b, "I").filter((p) => p.orientation === 1 && p.x === 9);
  const res = lockPiece(b, vertical);
  assert.equal(res.linesCleared, 1);
  assert.deepEqual(res.clearedRows, [0]);
  assert.equal(res.erodedCells, 1);
  assert.deepEqual(boardToRows(res.board, 3), [".........#", ".........#", "########.#"]);
  assert.equal(res.toppedOut, false);
});

test("features: heights, holes, bumpiness, wells, nearly full rows", () => {
  const b = parseBoard([
    "#.........",
    "#.#.......",
    "###.#....#",
    "#.###.####",
  ]);
  const f = computeFeatures(b);
  assert.deepEqual(f.heights, [4, 2, 3, 1, 2, 0, 1, 1, 1, 2]);
  assert.equal(f.holes, 1); // only (1,0), under the mino at (1,1)
  assert.deepEqual(f.holeColumns, [1]);
  assert.equal(f.maxHeight, 4);
  assert.ok(f.wells.some((w) => w.column === 5 && w.depth === 1) === false, "depth 1 is not a well");
  assert.equal(f.nearlyFullRows, 0);
  assert.equal(f.bumpiness, 2 + 1 + 2 + 1 + 2 + 1 + 0 + 0 + 1);
});

test("the heuristic prefers a line clear without holes over burying a hole", () => {
  const b = parseBoard([
    "#########.",
    "#########.",
  ]);
  const best = evaluateAll(b, "I")[0];
  assert.equal(best.lock.linesCleared, 2);
  assert.equal(best.placement.orientation, 1);
  assert.equal(best.placement.x, 9);
  const worst = evaluateAll(b, "I").at(-1)!;
  assert.ok(worst.score < best.score);
});

test("a piece locked above the visible rows is a top-out", () => {
  const b = emptyBoard();
  for (let y = 0; y < VISIBLE_HEIGHT; y++) for (let x = 0; x < WIDTH; x++) if (x !== 9) b[y * WIDTH + x] = 1;
  const p = enumeratePlacements(b, "O").find((q) => q.x === 0)!;
  assert.equal(lockPiece(b, p).toppedOut, true);
});
