import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY_MARGIN, SPAWN_ROW, freeColumnSteps, reachableFromLive, reachablePlacements, rotationKeys, startColumn, walkableColumns } from "../src/reach.ts";
import { fallMsForLevel } from "../src/score.ts";
import { WIDTH, parseBoard } from "../src/tetris.ts";

/** Flat stack two rows high, with column 10 kept empty as the tetris well. */
const flatWithWell = parseBoard([
  "#########.",
  "#########.",
]);

/** A twelve-row tower in column index 7 (the 8th column) that a piece at 20G cannot climb. */
const towerAt8 = parseBoard([
  ".......#..",
  ".......#..",
  ".......#..",
  ".......#..",
  ".......#..",
  ".......#..",
  ".......#..",
  ".......#..",
  ".......#..",
  ".......#..",
  "##########",
  "##########",
]);

test("below level 20 gravity leaves time to reach every placement", () => {
  const all = reachablePlacements(towerAt8, "O", { level: 5 });
  const columns = new Set(all.map((p) => p.x));
  assert.equal(columns.size, WIDTH - 1, "an O fits in all nine starting columns");
  assert.ok(columns.has(8), "the far side is reachable when the piece can be moved at the top");
});

test("at 20G a piece cannot be walked across a taller column", () => {
  const reach = reachablePlacements(towerAt8, "O", { level: 25 });
  const columns = [...new Set(reach.map((p) => p.x))].sort((a, b) => a - b);
  assert.ok(columns.length > 0, "something is reachable");
  assert.equal(Math.max(...columns), 5, `the tower walls off the right: reached ${columns.join(",")}`);
  assert.ok(columns.includes(0), "the open left side is still reachable");
});

test("at 20G a flat surface leaves the whole board reachable, well included", () => {
  const reach = reachablePlacements(flatWithWell, "I", { level: 30 });
  const upright = reach.filter((p) => p.orientation % 2 === 1);
  assert.ok(upright.some((p) => p.x === WIDTH - 1), "the I can still be walked into the well");
  const flat = reach.filter((p) => p.orientation % 2 === 0);
  assert.ok(flat.length > 0, "and laid flat elsewhere");
});

test("the walk stops at the first column the piece cannot shift into", () => {
  // An O spans two columns, so it is blocked one column before the tower.
  const cols = walkableColumns(towerAt8, "O", 0, 0);
  assert.deepEqual(cols, [0, 1, 2, 3, 4, 5], "it walks the low ground and stops at the tower");
  assert.ok(!cols.includes(6), "at x=6 the piece would overlap the tower in column index 7");
});

test("placements that need more presses than the lock allows are dropped", () => {
  const generous = reachablePlacements(flatWithWell, "I", { level: 25, keyBudget: 15 });
  const tight = reachablePlacements(flatWithWell, "I", { level: 25, keyBudget: 4 });
  assert.ok(tight.length < generous.length, "a small budget rules placements out");
  for (const p of tight) assert.ok(p.keys + KEY_MARGIN <= 4, `${p.keys} presses is within the budget`);
});

test("key cost counts the turns, the steps and the drop", () => {
  assert.equal(rotationKeys(0), 0);
  assert.equal(rotationKeys(1), 1, "one clockwise");
  assert.equal(rotationKeys(2), 2, "two clockwise");
  assert.equal(rotationKeys(3), 1, "one counter-clockwise is shorter than three clockwise");
  assert.equal(startColumn("O", 0), 4, "the O spawns one column right of the others");
  assert.equal(startColumn("T", 0), 3);
  const reach = reachablePlacements(flatWithWell, "T", { level: 30 });
  const home = reach.find((p) => p.orientation === 0 && p.x === startColumn("T", 0));
  assert.ok(home && home.keys === 1, "the placement under the spawn is one press: the drop");
});

test("a resting piece is planned from where it stands, not from the spawn column", () => {
  const live = [[0, 2], [1, 2], [2, 2], [3, 2]];
  const reach = reachableFromLive(flatWithWell, "I", live, { level: 30 });
  assert.ok(reach.length > 0);
  // It starts on the far left, so the well on the right costs more presses than
  // it would from the spawn column.
  const toWell = reach.find((p) => p.orientation % 2 === 1 && p.x === WIDTH - 1);
  const fromSpawn = reachablePlacements(flatWithWell, "I", { level: 30 }).find((p) => p.orientation % 2 === 1 && p.x === WIDTH - 1);
  if (toWell && fromSpawn) assert.ok(toWell.keys > fromSpawn.keys, "further to walk from the left edge");
});

test("how far a piece can be carried through the air follows the fall speed, not the level number", () => {
  const air = SPAWN_ROW - 4; // a four-row stack
  // Level 1: a row takes a second, so there is time to cross the board twice over.
  assert.ok(freeColumnSteps(fallMsForLevel(1), air, 16) >= WIDTH);
  // Level 14: 11 ms a row. The piece is on the stack in under 200 ms.
  const mid = freeColumnSteps(fallMsForLevel(14), air, 16);
  assert.ok(mid > 0 && mid < WIDTH, `level 14 gives partial freedom, got ${mid}`);
  // Level 20 and up: none at all.
  assert.equal(freeColumnSteps(fallMsForLevel(20), air, 16), 0);
  // A taller stack means less air, so less freedom, at the same level.
  assert.ok(freeColumnSteps(fallMsForLevel(14), 4, 16) < mid, "a high stack gives the piece less time");
});

test("the board starts closing off well before level 20, which is where games were being lost", () => {
  // The bug this pins: reachability used to switch on at level 20, so at
  // levels 12-19 the planner still offered columns the page could not get the
  // piece to in time. Here the far side of the tower is only reachable while
  // there is air time to carry the piece over it.
  const atFive = reachablePlacements(towerAt8, "O", { level: 5, keyDelayMs: 16 });
  const atEighteen = reachablePlacements(towerAt8, "O", { level: 18, keyDelayMs: 16 });
  assert.ok(atFive.some((p) => p.x === 8), "level 5 carries the piece over the tower");
  assert.ok(atEighteen.length < atFive.length, `level 18 reaches less: ${atEighteen.length} against ${atFive.length}`);
  assert.equal(Math.max(...atEighteen.map((p) => p.x)), 5, "by level 18 the tower is a wall, as it is at 20G");
  // And reaching the far columns costs more presses once the walk is involved.
  const far = atFive.find((p) => p.x === 8)!;
  assert.ok(far.keys > 4, "crossing the board is not free even when it is possible");
});

test("a placement is always found, at every level and every stack height", () => {
  // The bug this pins cost every run above level 12: the key budget was passed
  // in as 0, which the reachability pass read as "no presses allowed", so it
  // returned nothing. The agent then never touched another piece -- they fell
  // and locked where they spawned, the score stopped moving, and the stack
  // rose two rows a piece until the game ended. It looked exactly like a
  // top-out, which is why it survived several rounds of tuning.
  for (let level = 1; level <= 30; level++) {
    for (const height of [0, 3, 8, 13, 17]) {
      const board = parseBoard(Array.from({ length: height }, () => "#########."));
      for (const type of ["I", "O", "T", "S", "Z", "J", "L"] as const) {
        const reach = reachablePlacements(board, type, { level, keyDelayMs: 16 });
        assert.ok(reach.length > 0, `level ${level}, stack ${height}, piece ${type}: nothing reachable`);
      }
    }
  }
});

test("a key budget of zero means unmeasured, not immovable", () => {
  const board = parseBoard(["#########.", "#########."]);
  assert.ok(reachablePlacements(board, "T", { level: 13, keyBudget: 0 }).length > 0);
  assert.ok(reachableFromLive(board, "T", [[4, 3], [5, 3], [6, 3], [5, 4]], { level: 13, keyBudget: 0 }).length > 0);
});
