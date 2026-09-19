import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACK_TO_BACK_MULTIPLIER,
  MAX_LEVEL,
  MOVE_RESET_LIMIT,
  bestRemainingScore,
  clearScore,
  fallMsForLevel,
  isTwentyG,
  keepsBackToBack,
  levelAfterLines,
  linesLeftInGame,
  lockMsForLevel,
} from "../src/score.ts";

test("clears are worth what the engine says they are worth", () => {
  assert.equal(clearScore(1, 1, false), 100);
  assert.equal(clearScore(2, 1, false), 300);
  assert.equal(clearScore(3, 1, false), 500);
  assert.equal(clearScore(4, 1, false), 800);
  assert.equal(clearScore(4, 12, false), 9_600, "the level multiplies the clear");
  assert.equal(clearScore(4, 12, true), 14_400, "back to back is half as much again");
  assert.equal(clearScore(1, 12, true), 1_200, "a single never gets the back-to-back bonus");
  assert.equal(clearScore(0, 20, true), 0);
});

test("the combo bonus is paid per chained clear and scales with the level", () => {
  assert.equal(clearScore(1, 10, false, 0), 1_000, "the first clear of a chain has no combo");
  assert.equal(clearScore(1, 10, false, 3), 1_000 + 50 * 3 * 10);
});

test("only a tetris keeps the chain alive", () => {
  assert.equal(keepsBackToBack(4), true);
  for (const n of [1, 2, 3]) assert.equal(keepsBackToBack(n), false);
});

test("a back-to-back tetris pays three times a single for the same row", () => {
  const level = 15;
  const perLineTetris = clearScore(4, level, true) / 4;
  const perLineSingle = clearScore(1, level, false) / 1;
  assert.equal(perLineTetris / perLineSingle, 3 * BACK_TO_BACK_MULTIPLIER / 1.5);
  assert.ok(perLineTetris > perLineSingle * 2.9, "this ratio is the whole strategy");
});

test("gravity goes instant at level 20 and the lock window keeps shrinking", () => {
  assert.equal(fallMsForLevel(1), 1000);
  assert.equal(fallMsForLevel(19), 1);
  assert.equal(fallMsForLevel(20), 0);
  for (let l = 1; l <= 19; l++) assert.equal(isTwentyG(l), false, `level ${l} still has gravity`);
  for (let l = 20; l <= MAX_LEVEL; l++) assert.equal(isTwentyG(l), true, `level ${l} is 20G`);
  assert.equal(lockMsForLevel(19), 500);
  assert.equal(lockMsForLevel(30), 150);
  assert.equal(MOVE_RESET_LIMIT, 15);
});

test("the game is 30 levels of 10 lines and then it stops", () => {
  assert.equal(levelAfterLines(0), 1);
  assert.equal(levelAfterLines(9), 1);
  assert.equal(levelAfterLines(10), 2);
  assert.equal(levelAfterLines(295), MAX_LEVEL, "the level is capped");
  assert.equal(linesLeftInGame(1, 10), 300);
  assert.equal(linesLeftInGame(30, 10), 10);
  assert.equal(linesLeftInGame(30, 0), 0);
});

test("the ceiling: perfect play from level 1 is about 1.39 million, and a late start cannot reach a million", () => {
  const fromStart = bestRemainingScore(1, 10, false);
  assert.ok(fromStart > 1_300_000 && fromStart < 1_450_000, `ceiling from level 1 was ${fromStart}`);
  // Starting high trades away the lines that the target needs.
  assert.ok(bestRemainingScore(20, 10, false) < 1_000_000, "a level-20 start can never reach 1,000,000");
  assert.ok(bestRemainingScore(12, 10, false) > 1_000_000, "a level-12 start still can, barely");
  assert.equal(bestRemainingScore(30, 0, false), 0, "nothing is left once level 30 is complete");
});

test("a clear that empties the board is paid a separate, very large bonus", async () => {
  const { PERFECT_CLEAR_BACK_TO_BACK_TETRIS, perfectClearScore } = await import("../src/score.ts");
  assert.equal(perfectClearScore(1, 1, false), 800);
  assert.equal(perfectClearScore(4, 1, false), 2_000);
  assert.equal(perfectClearScore(4, 1, true), PERFECT_CLEAR_BACK_TO_BACK_TETRIS);
  // Like every other clear, it is multiplied by the level.
  assert.equal(perfectClearScore(4, 25, true), 3_200 * 25);
  assert.equal(perfectClearScore(0, 30, true), 0);
  // On top of the clear itself, it nearly triples what the tetris is worth.
  const tetris = clearScore(4, 25, true);
  assert.ok(perfectClearScore(4, 25, true) > tetris * 2.5, "the bonus dwarfs the clear");
  assert.equal(tetris + perfectClearScore(4, 25, true), 110_000);
});

test("the evaluation pays the perfect clear only when the board is actually empty", async () => {
  const { computeFeatures, evaluatePlacement, parseBoard, enumeratePlacements } = await import("../src/tetris.ts");
  // Four rows, every column but the well filled: an upright I empties the board.
  const board = parseBoard(["#########.", "#########.", "#########.", "#########."]);
  const ctx = { wellColumn: 9, level: 12, backToBack: true, combo: 0 };
  const before = computeFeatures(board);
  const upright = enumeratePlacements(board, "I").find((p) => p.orientation % 2 === 1 && p.x === 9)!;
  const ev = evaluatePlacement(board, before, upright, undefined, ctx);
  assert.equal(ev.lock.linesCleared, 4);
  assert.equal(ev.after.aggregateHeight, 0, "nothing is left behind");
  assert.equal(ev.points, clearScore(4, 12, true) + 3_200 * 12);
});
