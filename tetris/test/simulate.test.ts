import { test } from "node:test";
import assert from "node:assert/strict";
import { rankedChooser, simulateGame } from "../src/simulate.ts";
import { MAX_LEVEL, TOTAL_LINES, clearScore } from "../src/score.ts";

test("a simulated marathon obeys the game's own rules", { timeout: 60_000 }, () => {
  const r = simulateGame({ seed: 1 });
  // The clear that finishes level 30 still counts all its lines, so the total
  // can overshoot by up to three, exactly as it does in the real game.
  assert.ok(r.lines <= TOTAL_LINES + 3, `cleared ${r.lines} lines, more than the game can give`);
  assert.ok(r.level >= 1 && r.level <= MAX_LEVEL);
  assert.ok(r.pieces > 0);
  const linesFromClears = r.clears[0] + r.clears[1] * 2 + r.clears[2] * 3 + r.clears[3] * 4;
  assert.equal(linesFromClears, r.lines, "every cleared line is accounted for by a clear");
  // The score cannot exceed what the clears could have been worth at the top level.
  assert.ok(r.score <= clearScore(4, MAX_LEVEL, true) * (r.lines / 4) + 40_000);
  assert.ok(["complete", "topout", "stuck"].includes(r.endedBy));
  if (r.endedBy === "complete") assert.ok(r.lines >= TOTAL_LINES, `finished with only ${r.lines} lines`);
});

test("the same seed plays the same game", { timeout: 60_000 }, () => {
  const a = simulateGame({ seed: 7 });
  const b = simulateGame({ seed: 7 });
  assert.deepEqual(a, b, "the simulation has to be repeatable to be worth tuning against");
  assert.notDeepEqual(simulateGame({ seed: 8 }).score, a.score, "and different seeds play differently");
});

test("the strategy holds up over a whole marathon, not just a few pieces", { timeout: 120_000 }, () => {
  // The guard on the work as a whole: the code heuristic alone should reach
  // the end of the game with most of its lines cleared four at a time. If this
  // drops, something in the chain from reachability to the weights has broken.
  const results = [1, 2, 3].map((i) => simulateGame({ seed: 1 + i * 7919 }));
  for (const r of results) {
    assert.equal(r.endedBy, "complete", `game ended at level ${r.diedAtLevel} instead of finishing`);
    assert.ok(r.tetrisShare > 0.55, `only ${(100 * r.tetrisShare).toFixed(0)}% of lines came four at a time`);
    assert.ok(r.score > 800_000, `scored ${r.score}`);
  }
});

test("a chooser that sometimes takes a lower-ranked option still finishes", { timeout: 120_000 }, () => {
  // The rank spread measured from live play. The shortlist is sized so that a
  // pick other than the top one is a different opinion, not a lost game.
  const jevLike = rankedChooser([696, 228, 98, 59, 34, 38]);
  const r = simulateGame({ seed: 1, choose: jevLike });
  assert.equal(r.endedBy, "complete");
  assert.ok(r.score > 700_000, `scored ${r.score} with a non-ideal chooser`);
});
