import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  cloneState,
  flap,
  step,
  type SimState,
  GRAVITY_PER_STEP,
  FLAP_VY_V3,
  PIPE_DX_PER_STEP,
  OPENING_HALF_GAPS,
  HALF_GAP,
  PIPE_START_X,
} from "../src/physics.ts";

interface LogEntry {
  step: number;
  state: "play" | "gameover";
  y: number;
  vy: number;
  flapped: boolean;
  pipes: { x: number; gapY: number; halfGap: number; passed: boolean }[];
  score: number;
  spawnCount: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const recording = JSON.parse(readFileSync(join(here, "fixtures", "recorded-run.json"), "utf8")) as {
  log: LogEntry[];
  final: { deathCause: string; playStep: number };
};

test("constants match the values derived from the game bundle", () => {
  assert.equal(GRAVITY_PER_STEP, 43690);
  assert.equal(FLAP_VY_V3, 1468006);
  assert.equal(PIPE_DX_PER_STEP, 5242);
  assert.equal(PIPE_START_X, 1258291);
  assert.deepEqual(OPENING_HALF_GAPS, [325058, 309330, 293601, 277872, 262144]);
  assert.equal(HALF_GAP, 246415);
});

test("replays a recorded live run step for step", () => {
  const log = recording.log;
  const first = log[0];
  const s: SimState = {
    phase: "getready",
    birdY: first.y,
    birdVy: 0,
    pipes: [],
    score: 0,
    playStep: 0,
    spawnCount: 0,
    simVersion: 4,
    deathCause: null,
  };
  assert.equal(first.flapped, true);
  flap(s); // the run starts with the getready -> play flap, which sets birdVy
  assert.equal(s.birdVy, first.vy);

  let compared = 0;
  for (let i = 0; i + 1 < log.length; i++) {
    const cur = log[i];
    const next = log[i + 1];
    if (cur.state === "gameover") break; // the recording keeps logging after death; we only forecast live play
    const spawned = next.pipes.length > cur.pipes.length ? next.pipes[next.pipes.length - 1] : null;
    step(s, () => (spawned ? spawned.gapY : null));
    // The recording logged each entry right after applying that step's flap, so apply it before comparing.
    if (next.flapped) flap(s);
    assert.equal(s.birdY, next.y, `birdY mismatch after step ${cur.step}`);
    assert.equal(s.birdVy, next.vy, `birdVy mismatch after step ${cur.step}`);
    assert.equal(s.playStep, next.step, `playStep mismatch after step ${cur.step}`);
    assert.equal(s.phase, next.state, `phase mismatch after step ${cur.step}`);
    assert.equal(s.score, next.score, `score mismatch after step ${cur.step}`);
    assert.deepEqual(
      s.pipes.map((p) => ({ x: p.x, gapY: p.gapY, halfGap: p.halfGap, passed: p.passed })),
      next.pipes,
      `pipes mismatch after step ${cur.step}`,
    );
    compared++;
  }
  assert.ok(compared > 300, `compared only ${compared} steps`);
  assert.equal(s.phase, "gameover");
  assert.equal(s.deathCause, recording.final.deathCause);
  assert.equal(s.playStep, recording.final.playStep);
});

test("cloneState produces an independent copy", () => {
  const s: SimState = {
    phase: "play", birdY: 1, birdVy: 2, pipes: [{ x: 3, gapY: 4, halfGap: 5, passed: false }],
    score: 0, playStep: 0, spawnCount: 1, simVersion: 4, deathCause: null,
  };
  const c = cloneState(s);
  c.pipes[0].x = 99;
  c.birdY = 42;
  assert.equal(s.pipes[0].x, 3);
  assert.equal(s.birdY, 1);
});
