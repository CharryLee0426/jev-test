import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseByCode, describeCandidate, describeSituation, heldInPiece, piecesAfter, planCandidates, postureWeights, type PiecesInPlay } from "../src/planner.ts";
import { emptyBoard, parseBoard } from "../src/tetris.ts";

const pieces = (live: string, hold: string | null, queue: string, canHold = true): PiecesInPlay => ({ live: live as PiecesInPlay["live"], hold: hold as PiecesInPlay["hold"], canHold, queue: queue.split("") as PiecesInPlay["queue"] });

test("hold rules: an empty hold pulls the next piece and shifts the queue", () => {
  assert.deepEqual(piecesAfter(pieces("T", null, "IZO"), false), { next: "I", hold: null, queue: ["Z", "O"] });
  assert.deepEqual(piecesAfter(pieces("T", null, "IZO"), true), { next: "Z", hold: "T", queue: ["O"] });
  assert.deepEqual(piecesAfter(pieces("T", "L", "IZO"), true), { next: "I", hold: "T", queue: ["Z", "O"] });
  assert.equal(heldInPiece(pieces("T", null, "IZO")), "I");
  assert.equal(heldInPiece(pieces("T", "L", "IZO")), "L");
  assert.equal(heldInPiece(pieces("T", "L", "IZO", false)), null);
});

test("candidates are distinct, ranked, and include a hold option when allowed", () => {
  const board = parseBoard([
    "#########.",
    "#########.",
    "####.#####",
  ]);
  const cands = planCandidates({ board, pieces: pieces("T", null, "IZO"), count: 6 });
  assert.equal(cands.length, 6);
  assert.deepEqual(cands.map((c) => c.id), ["option_1", "option_2", "option_3", "option_4", "option_5", "option_6"]);
  for (let i = 1; i < cands.length; i++) assert.ok(cands[i - 1].total >= cands[i].total, "sorted by total");
  const keys = new Set(cands.map((c) => `${c.evaluation.placement.viaHold}:${c.evaluation.placement.orientation}:${c.evaluation.placement.x}`));
  assert.equal(keys.size, cands.length, "no duplicates");
  const holdOption = cands.find((c) => c.evaluation.placement.viaHold);
  assert.ok(holdOption, "a hold option is offered");
  assert.equal(holdOption.evaluation.placement.type, "I");
  // Holding for the I and dropping it in the well clears two lines: code ranks it first.
  const best = chooseByCode(cands);
  assert.equal(best.evaluation.placement.viaHold, true);
  assert.equal(best.evaluation.lock.linesCleared, 2);
});

test("no hold option when holding is not allowed", () => {
  const cands = planCandidates({ board: emptyBoard(), pieces: pieces("T", "I", "ZOS", false), count: 5 });
  assert.ok(cands.every((c) => !c.evaluation.placement.viaHold));
});

test("descriptions are words with the numbers as detail", () => {
  const board = parseBoard([
    "#########.",
    "#########.",
  ]);
  const cands = planCandidates({ board, pieces: pieces("I", null, "TZO"), count: 4 });
  const best = chooseByCode(cands);
  const d = describeCandidate(best, pieces("I", null, "TZO"));
  assert.equal(d.action, "place the I");
  assert.match(d.where, /standing upright, column 10 on the right, landing on row 1 from the bottom/);
  assert.equal(d.lines, "clears 2 lines at once (a double)");
  assert.match(d.holes, /creates no holes/);
  assert.match(d.stack_after, /very low|empty/);
  assert.match(d.next_piece_outlook, /the following T/);
  assert.match(d.risk, /^safe/);
  const s = describeSituation(board, pieces("I", null, "TZO"), { level: 1, fallMsPerRow: 1000 });
  assert.match(s.board.stack_height, /very low/);
  assert.match(s.board.wells, /2-deep|no deep well/);
  assert.equal(s.pieces.live, "I (the straight four-long bar)");
  assert.match(s.pieces.hold, /^empty \(holding/);
  assert.equal(s.pieces.next, "T, then Z, then O (the square)");
  assert.match(s.pace, /slowly/);
});

test("a top-out is described as ending the game and never chosen by code when avoidable", () => {
  const rows: string[] = [];
  for (let i = 0; i < 19; i++) rows.push("#########.");
  const board = parseBoard(rows);
  const cands = planCandidates({ board, pieces: pieces("O", null, "III"), count: 6 });
  const fatal = cands.filter((c) => c.evaluation.lock.toppedOut);
  const survivors = cands.filter((c) => !c.evaluation.lock.toppedOut);
  assert.ok(survivors.length > 0);
  for (const f of fatal) assert.match(describeCandidate(f, pieces("O", null, "III")).risk, /ENDS THE GAME/);
  assert.equal(chooseByCode(cands).evaluation.lock.toppedOut, false);
});

test("posture presets change the weights code ranks with", () => {
  assert.ok(postureWeights("clear_lines_now").lines > postureWeights(null).lines);
  assert.ok(postureWeights("repair_surface").holes < postureWeights(null).holes);
  assert.ok(postureWeights("build_for_tetris").tetris > postureWeights(null).tetris);
});

test("a resting piece gets a sliding candidate in its current orientation only", async () => {
  const { slidingCandidate } = await import("../src/agent.ts");
  const { parseBoard: pb } = await import("../src/tetris.ts");
  const board = pb([
    "..........",
    "#####.....",
    "#####.....",
    "##########",
  ]);
  // A flat I resting on the right half, row 1 (cells y=1), can slide right but not into the left step.
  const live = [[5, 1], [6, 1], [7, 1], [8, 1]];
  const c = slidingCandidate(board, "I", live);
  assert.ok(c, "resting piece yields a candidate");
  assert.equal(c.evaluation.placement.orientation, 0);
  assert.ok(c.evaluation.placement.x >= 5, "cannot slide into the wall on the left");
  // A piece high above the stack is not resting: the normal planner applies.
  assert.equal(slidingCandidate(board, "I", [[3, 15], [4, 15], [5, 15], [6, 15]]), null);
});
