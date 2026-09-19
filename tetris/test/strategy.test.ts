import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseByCode, describeCandidate, describeSituation, planCandidates, type PiecesInPlay } from "../src/planner.ts";
import { READY_ROWS_PAID, SAFE_HEIGHT, WIDTH, chooseWellColumn, parseBoard, wellStats, type EvalContext } from "../src/tetris.ts";

const WELL = WIDTH - 1;
const ctx = (over: Partial<EvalContext> = {}): EvalContext => ({ wellColumn: WELL, level: 12, backToBack: true, combo: 0, ...over });
const pieces = (live: string, hold: string | null, queue: string, canHold = true): PiecesInPlay =>
  ({ live: live as PiecesInPlay["live"], hold: hold as PiecesInPlay["hold"], canHold, queue: queue.split("") as PiecesInPlay["queue"] });

/** Four rows full except the well: an I dropped in scores a tetris. */
const fourReady = parseBoard([
  "#########.",
  "#########.",
  "#########.",
  "#########.",
]);

/** Three rows ready: a vertical I here would only score a triple. */
const threeReady = parseBoard([
  "#########.",
  "#########.",
  "#########.",
]);

test("well stats count the rows that are paid for and the cells that block them", () => {
  const s = wellStats(fourReady, WELL);
  assert.equal(s.readyRows, 4);
  assert.equal(s.blocked, 0);
  assert.equal(s.depth, 4);
  // A cell dropped into the well on a row that is not otherwise complete blocks it.
  const capped = parseBoard([
    ".........#",
    "#########.",
    "#########.",
  ]);
  const c = wellStats(capped, WELL);
  assert.equal(c.blocked, 1, "the lone cell in the well is in the way");
  assert.equal(c.readyRows, 2);
});

test("the well is kept against a wall, where no piece has to be walked across it", () => {
  assert.ok([0, WIDTH - 1].includes(chooseWellColumn(fourReady)), "an edge wins");
  assert.equal(chooseWellColumn(fourReady), WELL, "the column already open is the one kept");
  // Once chosen it stays put rather than wandering from piece to piece.
  assert.equal(chooseWellColumn(threeReady, WELL), WELL);
});

test("four ready rows and an I: the tetris is taken", () => {
  const cands = planCandidates({ board: fourReady, pieces: pieces("I", null, "TZO"), count: 6, context: ctx() });
  const best = chooseByCode(cands);
  assert.equal(best.evaluation.lock.linesCleared, 4, "code takes the four");
  assert.equal(best.evaluation.placement.x, WELL, "by dropping the I into the well");
  // This board is exactly four rows deep, so the tetris also empties it: the
  // clear pays 14,400 and the perfect clear pays 3,200 x level on top.
  assert.equal(best.evaluation.points, 14_400 + 3_200 * 12, "the tetris plus the perfect-clear bonus");
  assert.ok(cands.some((c) => c.tags.includes("tetris")), "the tetris is always offered to the model");
});

test("three ready rows and an I: the triple is refused, because the fourth row pays double", () => {
  const cands = planCandidates({ board: threeReady, pieces: pieces("I", null, "TZO"), count: 6, context: ctx() });
  const best = chooseByCode(cands);
  assert.notEqual(best.evaluation.lock.linesCleared, 3, "cashing three rows for 500 x level throws the chain away");
  assert.ok(best.evaluation.well!.after.blocked === 0, "and the well stays open");
  const triple = cands.find((c) => c.evaluation.lock.linesCleared === 3);
  if (triple) {
    assert.ok(triple.total < best.total, "the triple is ranked below building the fourth row");
    assert.match(describeCandidate(triple, pieces("I", null, "TZO"), ctx()).points, /BREAKS the back-to-back chain/);
  }
});

test("nothing is dropped into the well while it is being kept", () => {
  // Every column is level, so the only thing separating the options is the well.
  const cands = planCandidates({ board: fourReady, pieces: pieces("O", null, "TZI"), count: 6, context: ctx() });
  const best = chooseByCode(cands);
  assert.ok(best.evaluation.placement.cells.every((c) => c.x !== WELL), `the O must not cap the well (went to column ${best.evaluation.placement.x + 1})`);
  assert.equal(best.evaluation.well!.after.readyRows, 4, "the four ready rows survive");
});

test("a dangerous stack overrides the strategy: survival comes first", () => {
  const rows: string[] = [];
  for (let i = 0; i < 18; i++) rows.push("#########.");
  const cands = planCandidates({ board: parseBoard(rows), pieces: pieces("I", null, "TZO"), count: 6, context: ctx() });
  const best = chooseByCode(cands);
  assert.equal(best.evaluation.lock.toppedOut, false, "code never picks a certain top-out");
  assert.equal(best.evaluation.lock.linesCleared, 4, "with the stack at the ceiling the four is taken at once");
});

test("the model is told what each option pays and what it does to the well", () => {
  const cands = planCandidates({ board: fourReady, pieces: pieces("I", null, "TZO"), count: 6, context: ctx() });
  const tetris = cands.find((c) => c.evaluation.lock.linesCleared === 4)!;
  const d = describeCandidate(tetris, pieces("I", null, "TZO"), ctx());
  assert.match(d.points, /scores 52,800 points/);
  assert.match(d.points, /back-to-back bonus/);
  assert.match(d.lines, /TETRIS/);
  assert.match(d.tetris_well, /ready/);
  const s = describeSituation(fourReady, pieces("I", null, "TZO"), { level: 12, fallMsPerRow: 28 }, ctx());
  assert.match(s.board.tetris_well, /column 10 is being kept empty/);
  assert.match(s.board.tetris_well, /4 of the 4 rows needed are ready/);
  assert.match(s.scoring.back_to_back, /ALIVE/);
  assert.match(s.scoring.level_pays, /a tetris pays 14,400 and a single pays 1,200/);
});

test("at 20G the situation says the piece is already on the stack", () => {
  const s = describeSituation(fourReady, pieces("I", null, "TZO"), { level: 25, fallMsPerRow: 0 }, ctx({ level: 25 }));
  assert.match(s.pace, /already resting on the stack/);
  assert.match(s.pace, /surface must stay flat/);
});

/** Eight rows banked against the well: two tetrises' worth, and a ten-row stack. */
const eightReady = parseBoard(Array.from({ length: 8 }, () => "#########."));

test("ready rows past the fourth are not rewarded: hoarding them built a tower to the ceiling", () => {
  assert.equal(READY_ROWS_PAID, 4, "a tetris only ever clears four rows");
  const cands = planCandidates({ board: eightReady, pieces: pieces("I", null, "TZO"), count: 6, context: ctx() });
  const best = chooseByCode(cands);
  assert.equal(best.evaluation.lock.linesCleared, 4, "with rows banked and an I in hand, cash it rather than stack higher");
});

test("height risk overrides the strategy before the stack reaches the ceiling", () => {
  // Fifteen rows: well past SAFE_HEIGHT, and nothing banked is worth dying for.
  const tall = parseBoard(Array.from({ length: 15 }, () => "#########."));
  assert.ok(15 > SAFE_HEIGHT);
  const cands = planCandidates({ board: tall, pieces: pieces("I", null, "TZO"), count: 6, context: ctx() });
  const best = chooseByCode(cands);
  assert.equal(best.evaluation.lock.linesCleared, 4, "the I goes in the well to bring the stack down");
  assert.ok(best.evaluation.after.maxHeight < 15, "and the stack actually comes down");
});

test("the well never wanders while rows are banked against it", () => {
  // Every ready row is measured against one column, so moving the well throws
  // them all away. It stays put even when another column looks tempting.
  assert.equal(chooseWellColumn(eightReady, WELL), WELL);
  const cappedWell = parseBoard([
    ".........#",
    "..........",
    "#########.",
  ]);
  assert.equal(chooseWellColumn(cappedWell, WELL), WELL, "a blocked well with rows still banked is dug out, not abandoned");
});

test("an I is held for the well, not laid flat: it is the only piece that scores a tetris", () => {
  // Three rows ready, so dropping the I in now would only pay for a triple.
  // Holding it costs nothing -- the piece hold brings out has to be placed anyway.
  const cands = planCandidates({ board: threeReady, pieces: pieces("I", null, "TZO"), count: 6, context: ctx() });
  const best = chooseByCode(cands);
  assert.equal(best.evaluation.placement.viaHold, true, "the I goes to hold and the T is placed instead");
  assert.notEqual(best.evaluation.placement.type, "I");
  // And the option that spends it flat is named as such for the model.
  const flat = cands.find((c) => c.evaluation.placement.type === "I" && !c.evaluation.placement.cells.some((q) => q.x === WELL));
  if (flat) assert.match(describeCandidate(flat, pieces("I", null, "TZO"), ctx()).tetris_well, /WASTES THE I PIECE/);
});

test("a held I comes straight back out when the rows are ready", () => {
  const cands = planCandidates({ board: fourReady, pieces: pieces("T", "I", "ZOS"), count: 6, context: ctx() });
  const best = chooseByCode(cands);
  assert.equal(best.evaluation.placement.viaHold, true, "swap the T out for the I that was saved");
  assert.equal(best.evaluation.placement.type, "I");
  assert.equal(best.evaluation.lock.linesCleared, 4);
});

test("the planner always offers the live piece somewhere to go", () => {
  // Same guarantee one level up: whatever the board and whatever the level,
  // there is always something on the shortlist, because an empty shortlist
  // means the agent stops playing without stopping the game.
  for (const level of [1, 10, 13, 16, 20, 25, 30]) {
    for (const height of [0, 5, 10, 15]) {
      const board = parseBoard(Array.from({ length: height }, () => "#########."));
      const cands = planCandidates({ board, pieces: pieces("S", "I", "ZOT"), count: 6, context: ctx({ level }) });
      assert.ok(cands.length > 0, `level ${level}, stack ${height}: the shortlist came back empty`);
    }
  }
});

test("the board signature Node sends matches the one the page checks", async () => {
  // An armed plan only fires if the page finds the board the plan was built
  // on. Node and the page each build that string themselves, so they have to
  // agree exactly -- when they did not, the page silently refused to fire and
  // the agent was left holding a plan that never finished.
  const { boardFromSnapshot, boardSignature } = await import("../src/agent.ts");
  const rows: string[] = [];
  for (let y = 0; y < 24; y++) {
    let r = "";
    for (let x = 0; x < 10; x++) r += (x + y) % 3 === 0 && y < 12 ? "#" : ".";
    rows.push(r);
  }
  const pageString = rows.join("");
  const snap = { board: pageString, width: 10, height: 24 } as Parameters<typeof boardFromSnapshot>[0];
  assert.equal(boardSignature(boardFromSnapshot(snap)), pageString, "the round trip has to be exact");
  assert.equal(pageString.length, 240);
});
