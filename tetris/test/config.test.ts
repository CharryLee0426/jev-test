import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, describeObjective, describeStopConditions, mergeConfig, normalizeKey, parseConfigObject } from "../src/config.ts";

test("keys normalize from kebab-case, camelCase and aliases", () => {
  assert.equal(normalizeKey("target-level"), "targetLevel");
  assert.equal(normalizeKey("targetScore"), "targetScore");
  assert.equal(normalizeKey("play-seconds"), "maxSeconds");
  assert.equal(normalizeKey("level"), "targetLevel");
  assert.equal(normalizeKey("score"), "targetScore");
  assert.equal(normalizeKey("key-delay"), "keyDelay");
});

test("config objects are validated", () => {
  const parsed = parseConfigObject({ "target-level": 5, targetScore: "12000", preplan: false, _comment: "ignored" }, "test");
  assert.deepEqual(parsed, { targetLevel: 5, targetScore: 12000, preplan: false });
  assert.throws(() => parseConfigObject({ "target-level": -1 }, "test"), /non-negative/);
  assert.throws(() => parseConfigObject({ preplan: "yes" }, "test"), /true or false/);
  assert.throws(() => parseConfigObject({ bogus: 1 }, "test"), /unknown setting/);
  assert.throws(() => parseConfigObject([], "test"), /JSON object/);
});

test("later layers override earlier ones and undefined never overrides", () => {
  const cfg = mergeConfig({ maxSeconds: 60, targetLevel: 3 }, { targetLevel: 5, model: undefined }, { candidates: 8 });
  assert.equal(cfg.maxSeconds, 60);
  assert.equal(cfg.targetLevel, 5);
  assert.equal(cfg.candidates, 8);
  assert.equal(cfg.timeout, DEFAULT_CONFIG.timeout);
  assert.equal(cfg.model, undefined);
  assert.equal(mergeConfig({ startLevel: 0 }).startLevel, 1);
});

test("stop conditions and the objective read naturally", () => {
  assert.equal(describeStopConditions(mergeConfig()), "play until Ctrl+C");
  assert.equal(describeStopConditions(mergeConfig({ targetLevel: 5, targetScore: 20000, maxSeconds: 120 })), "stop at the first of: reach level 5, reach score 20000, play 120s");
  assert.equal(describeStopConditions(mergeConfig({ runs: 1 })), "stop at the first of: finish 1 game");
  const now = { level: 2, score: 1500, linesToNextLevel: 4, secondsLeft: 50 };
  assert.match(describeObjective(mergeConfig({ targetLevel: 5 }), now), /reach level 5 \(now level 2, 4 more lines/);
  assert.match(describeObjective(mergeConfig({ targetScore: 9000 }), now), /tetris/);
  assert.match(describeObjective(mergeConfig({ maxSeconds: 90 }), now), /50s left/);
  assert.match(describeObjective(mergeConfig(), now), /alive/);
});
