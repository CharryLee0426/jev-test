import { test } from "node:test";
import assert from "node:assert/strict";
import { fx, type SimState } from "../src/physics.ts";
import {
  MANEUVERS,
  chooseByCode,
  describeClearance,
  describeForecast,
  describeMotion,
  describeOffset,
  describeSituation,
  forecastManeuvers,
  hoverLine,
  hoverWantsFlap,
  simulatePlan,
} from "../src/planner.ts";
import { dangerOf } from "../src/agent.ts";
import { buildJevRequest } from "../src/brain-jev.ts";

function state(over: Partial<SimState> = {}): SimState {
  return {
    phase: "play",
    birdY: fx(0.2),
    birdVy: 0,
    pipes: [
      { x: fx(0.6), gapY: fx(0.2), halfGap: fx(0.235), passed: false },
      { x: fx(1.6), gapY: fx(0.5), halfGap: fx(0.235), passed: false },
    ],
    score: 3,
    playStep: 1000,
    spawnCount: 5,
    simVersion: 4,
    deathCause: null,
    ...over,
  };
}

test("every maneuver gets a forecast with consistent fields", () => {
  const forecasts = forecastManeuvers({ state: state(), earliestStep: 1030, committedFlaps: [] });
  assert.equal(forecasts.length, MANEUVERS.length);
  for (const f of forecasts) {
    if (f.id === "hold_off") {
      assert.equal(f.flapStep, null);
      assert.equal(f.windowEnd, 1060);
    } else {
      assert.ok(f.flapStep !== null && f.flapStep >= 1030);
      assert.equal(f.windowEnd, f.flapStep! + 1);
    }
    if (f.outcome === "clears") {
      assert.ok(f.minClearance !== null && f.minClearance >= 0, `${f.id} clears but clearance ${f.minClearance}`);
      assert.ok(f.arrivalOffset !== null, "following gap is known so arrival offset must be reported");
    }
  }
  const survivors = forecasts.filter((f) => f.outcome === "clears");
  assert.ok(survivors.length >= 3, "a centered bird 0.6 units from a standard gap should have several safe options");
});

test("forecasts look through the following pipe and flag a setup that crashes there", () => {
  // The bird is between the pipes of a high gap; the following gap is much lower and close behind.
  const s = state({
    birdY: fx(0.6),
    birdVy: fx(0.3),
    pipes: [
      { x: fx(0.05), gapY: fx(0.7), halfGap: fx(0.235), passed: true },
      { x: fx(1.05), gapY: fx(-0.1), halfGap: fx(0.235), passed: false },
    ],
  });
  const forecasts = forecastManeuvers({ state: s, earliestStep: 1004, committedFlaps: [] });
  const survivors = forecasts.filter((f) => f.survives);
  assert.ok(survivors.length > 0, "a bird just under the center of a gap has a safe option");
  for (const f of forecasts) {
    if (f.outcome === "clears") assert.ok(f.followingOutcome !== null, `${f.id}: following pipe is known, so its outcome must be reported`);
  }
  assert.match(describeForecast(survivors[0]).result, /and then the following gap/);
  const pick = chooseByCode(forecasts);
  assert.equal(pick.survives, true);
  assert.equal(pick.followingOutcome, "clears");
});

test("simulatePlan reports a pending flap as fatal when the next gap is far below", () => {
  const s = state({
    birdY: fx(0.9),
    birdVy: fx(0.2),
    pipes: [
      { x: fx(-0.25), gapY: fx(0.7), halfGap: fx(0.235), passed: true },
      { x: fx(1.0), gapY: fx(-0.2), halfGap: fx(0.235), passed: false },
    ],
  });
  // Three more flaps late in the approach leave no time to descend 1.5 units; dropping them does.
  const withFlap = simulatePlan(s, [1050, 1090, 1130], 1131);
  const without = simulatePlan(s, [], 1000);
  assert.equal(withFlap.survives, false);
  assert.equal(without.survives, true);
});

test("a bird about to drop into the bottom pipe must flap now", () => {
  const s = state({
    birdY: fx(0.2 - 0.235 + 0.068 + 0.05),
    birdVy: fx(-1.0),
    pipes: [{ x: fx(0.1), gapY: fx(0.2), halfGap: fx(0.235), passed: false }],
  });
  const forecasts = forecastManeuvers({ state: s, earliestStep: 1002, committedFlaps: [] });
  const byId = Object.fromEntries(forecasts.map((f) => [f.id, f]));
  assert.equal(byId.hold_off.outcome, "hits_bottom_pipe");
  assert.equal(byId.flap_now.outcome, "clears");
  const pick = chooseByCode(forecasts);
  assert.equal(pick.outcome, "clears");
  assert.equal(dangerOf(forecasts) === "critical" || dangerOf(forecasts) === "tight", true);
});

test("committed flaps change the baseline", () => {
  const s = state({ birdY: fx(0.0), birdVy: fx(-1.0), pipes: [{ x: fx(0.3), gapY: fx(0.2), halfGap: fx(0.235), passed: false }] });
  const without = forecastManeuvers({ state: s, earliestStep: 1020, committedFlaps: [] });
  const withFlap = forecastManeuvers({ state: s, earliestStep: 1020, committedFlaps: [1002] });
  const a = without.find((f) => f.id === "hold_off")!;
  const b = withFlap.find((f) => f.id === "hold_off")!;
  assert.notEqual(a.positionAfterManeuver, b.positionAfterManeuver);
  assert.ok(b.positionAfterManeuver > a.positionAfterManeuver);
});

test("no pipe in range yields idle forecasts rather than crashes", () => {
  const forecasts = forecastManeuvers({ state: state({ pipes: [] }), earliestStep: 1030, committedFlaps: [] });
  assert.ok(forecasts.every((f) => f.outcome === "no_pipe_in_range"));
  assert.equal(dangerOf(forecasts), "none");
  const pick = chooseByCode(forecasts);
  assert.ok(pick);
});

test("a forecast that clears never reports a negative clearance (randomized)", () => {
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let cleared = 0;
  for (let i = 0; i < 300; i++) {
    const gapY = fx(-0.2 + rnd() * 1.0);
    const s = state({
      birdY: gapY + fx((rnd() - 0.5) * 0.5),
      birdVy: fx((rnd() - 0.6) * 3),
      pipes: [
        { x: fx(0.05 + rnd() * 0.7), gapY, halfGap: fx(0.235), passed: false },
        { x: fx(1.05 + rnd() * 0.7), gapY: fx(-0.2 + rnd() * 1.0), halfGap: fx(0.235), passed: false },
      ],
    });
    for (const f of forecastManeuvers({ state: s, earliestStep: 1000 + Math.floor(rnd() * 30), committedFlaps: [] })) {
      if (f.outcome === "clears") {
        cleared++;
        assert.ok(f.minClearance !== null && f.minClearance >= 0, `${f.id} clears with clearance ${f.minClearance} (case ${i})`);
        assert.equal(f.deathStep === null || f.followingOutcome !== null, true);
      } else if (f.outcome !== "no_pipe_in_range") {
        assert.ok(f.deathStep !== null, `${f.id} crashed without a death step (case ${i})`);
        assert.equal(f.survives, false);
      }
    }
  }
  assert.ok(cleared > 100, `only ${cleared} clearing forecasts in the sample`);
});

test("hover policy flaps only when falling below the line", () => {
  const line = hoverLine({ x: fx(0.5), gapY: fx(0.3), halfGap: fx(0.235), passed: false });
  assert.equal(hoverWantsFlap(line + fx(0.1), fx(-1), line), false);
  assert.equal(hoverWantsFlap(line, fx(-1), line), true);
  assert.equal(hoverWantsFlap(line - fx(0.1), fx(1), line), false);
  assert.equal(hoverLine(undefined, fx(0.05)) - hoverLine(undefined), fx(0.05));
});

test("labels read naturally", () => {
  assert.equal(describeOffset(0.01), "level with the gap center");
  assert.equal(describeOffset(-0.2), "well below the gap center");
  assert.equal(describeMotion(-1.4), "falling fast");
  assert.equal(describeClearance(0.05), "tight");
  assert.equal(describeClearance(-0.1), "none (collision)");
  const sit = describeSituation(state());
  assert.match(sit.bird.height_vs_upcoming_gap, /level with the gap center/);
  assert.match(sit.following_gap, /higher than the upcoming gap/);
});

test("the Jev request carries one description per maneuver and both questions", () => {
  const s = state();
  const forecasts = forecastManeuvers({ state: s, earliestStep: 1030, committedFlaps: [] });
  const req = buildJevRequest({ builtAtStep: 1000, earliestStep: 1030, situation: describeSituation(s), forecasts, state: s });
  assert.deepEqual(Object.keys(req.questions), ["maneuver", "line_through_gap"]);
  assert.deepEqual(Object.keys(req.questions.maneuver.criteria).sort(), MANEUVERS.map((m) => m.id).sort());
  const desc = describeForecast(forecasts[0]);
  assert.equal(typeof desc.result, "string");
  assert.equal(req.questions.maneuver.criteria.flap_now.timing, "flap immediately");
  assert.equal(req.questions.maneuver.criteria.flap_now.worst_clearance_at_upcoming_gap.length > 0, true);
  const json = JSON.stringify(req);
  assert.ok(json.length < 5000, `request is ${json.length} chars; keep the state small`);
});
