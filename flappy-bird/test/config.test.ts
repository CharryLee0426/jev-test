import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, describeStopConditions, mergeConfig, normalizeKey, parseConfigObject } from "../src/config.ts";

test("keys normalize from kebab-case, camelCase and aliases", () => {
  assert.equal(normalizeKey("target-score"), "targetScore");
  assert.equal(normalizeKey("targetScore"), "targetScore");
  assert.equal(normalizeKey("max-seconds"), "maxSeconds");
  assert.equal(normalizeKey("play-seconds"), "maxSeconds");
  assert.equal(normalizeKey("score"), "targetScore");
  assert.equal(normalizeKey("in-flight"), "inFlight");
});

test("config objects are validated", () => {
  const parsed = parseConfigObject({ "max-seconds": 45, targetScore: "12", ranked: true, _comment: "ignored" }, "test");
  assert.deepEqual(parsed, { maxSeconds: 45, targetScore: 12, ranked: true });
  assert.throws(() => parseConfigObject({ "target-score": -1 }, "test"), /non-negative/);
  assert.throws(() => parseConfigObject({ ranked: "yes" }, "test"), /true or false/);
  assert.throws(() => parseConfigObject({ brain: "code" }, "test"), /unknown setting/); // the code brain is gone
  assert.throws(() => parseConfigObject({ bogus: 1 }, "test"), /unknown setting/);
  assert.throws(() => parseConfigObject([], "test"), /JSON object/);
});

test("later layers override earlier ones and undefined never overrides", () => {
  const cfg = mergeConfig({ maxSeconds: 60, targetScore: 20 }, { targetScore: 5, model: undefined }, { interval: 150 });
  assert.equal(cfg.maxSeconds, 60);
  assert.equal(cfg.targetScore, 5);
  assert.equal(cfg.interval, 150);
  assert.equal(cfg.inFlight, DEFAULT_CONFIG.inFlight);
  assert.equal(cfg.model, undefined);
});

test("stop conditions read naturally", () => {
  assert.equal(describeStopConditions(mergeConfig()), "play until Ctrl+C");
  assert.equal(describeStopConditions(mergeConfig({ targetScore: 20, maxSeconds: 60 })), "stop at the first of: reach score 20, play 60s");
  assert.equal(describeStopConditions(mergeConfig({ runs: 1 })), "stop at the first of: finish 1 run");
});
