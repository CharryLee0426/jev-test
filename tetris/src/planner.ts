/**
 * Candidate placements and their plain-language descriptions.
 *
 * Code owns everything that is arithmetic: which placements exist, which of
 * them the piece can still be brought to at this level's gravity, what each
 * one does to the board (simulated exactly), what the game will pay for it,
 * how the following piece fares afterwards, and the words that turn those
 * numbers into facts a System One model can judge. The model's job is the
 * judgment: which placement now.
 *
 * The strategy the words are written for: marathon is 300 lines and then the
 * game ends, so the score is decided by what each line is worth, not by how
 * many are cleared. A back-to-back tetris pays three times what a single pays
 * for the same row. Every description therefore leads with the points and with
 * what the option does to the tetris well.
 */
import { clearScore, fallMsForLevel, isTwentyG, MOVE_RESET_LIMIT } from "./score.ts";
import { reachableFromLive, reachablePlacements } from "./reach.ts";
import {
  DEFAULT_WEIGHTS,
  NO_CONTEXT,
  TETRIS_WEIGHTS,
  VISIBLE_HEIGHT,
  computeFeatures,
  evaluateReachable,
  wellStats,
  type Board,
  type BoardFeatures,
  type EvalContext,
  type Evaluation,
  type PieceType,
  type Weights,
} from "./tetris.ts";

export type Posture = "build_tetris_well" | "cash_the_tetris" | "survive_now" | "repair_surface";

export const POSTURES: readonly Posture[] = ["build_tetris_well", "cash_the_tetris", "survive_now", "repair_surface"];

/**
 * Weight presets the model's posture answer selects for the next planning
 * cycle.
 *
 * They stay close to `TETRIS_WEIGHTS` on purpose. An earlier version let
 * `repair_surface` and `survive_now` drop the well discipline, and because a
 * single buried hole was enough to select `repair_surface`, the agent spent
 * most of the game in a posture that happily filled the well: the share of
 * lines cleared four at a time fell from 75% to 67%, and with it the score.
 * A posture is a change of emphasis, not a change of plan.
 */
export function postureWeights(p: Posture | null): Weights {
  switch (p) {
    case "cash_the_tetris":
      // The rows are ready: take the four, and do not let anything cap the well.
      return { ...TETRIS_WEIGHTS, tetris: 110, wellBlocked: -80, nonTetrisClear: -55 };
    case "repair_surface":
      // Dig the holes out, but the well stays sacred while doing it.
      return { ...TETRIS_WEIGHTS, holes: -26, newHoles: -18, rowTransitions: -4.5, columnTransitions: -11 };
    case "survive_now":
      // The stack itself is the threat. Clears are worth taking now and the
      // well may be spent -- but only reluctantly, because a game spent here
      // scores a third of what a game spent building does.
      return {
        ...TETRIS_WEIGHTS,
        landingHeight: -5.0,
        erodedCells: 3.0,
        lines: 3,
        heightRisk: -4.0,
        nonTetrisClear: -10,
        wellBlocked: -25,
        readyRows: 5,
        bumpiness: -1.6,
      };
    case "build_tetris_well":
    default:
      return TETRIS_WEIGHTS;
  }
}

export interface PiecesInPlay {
  live: PieceType;
  hold: PieceType | null;
  canHold: boolean;
  /** Upcoming pieces, nearest first. */
  queue: PieceType[];
}

export interface Candidate {
  id: string;
  evaluation: Evaluation;
  /** Best heuristic score the following piece can reach on the resulting board, when known. */
  nextBest: Evaluation | null;
  nextPiece: PieceType | null;
  total: number;
  /** Why the candidate was kept (for logs). */
  tags: string[];
  /** Pieces still queued after this placement, for the second lookahead ply. */
  afterQueue?: PieceType[];
}

export interface PlanningInput {
  board: Board;
  pieces: PiecesInPlay;
  weights?: Weights;
  /** How many candidates to keep for the model. */
  count?: number;
  /** The well, the level and the back-to-back chain the placements are judged against. */
  context?: EvalContext;
  /** Cells of the piece as it stands right now; at 20G the walk starts from there rather than from the spawn column. */
  liveCells?: readonly (readonly number[])[] | null;
  /** Key presses still available before the piece locks itself. */
  keyBudget?: number;
  /** Gravity the game reports, in ms per row. It, not the level, decides how much of the board is reachable. */
  fallMs?: number | null;
  /** What a key press costs, which is what the fall time is spent on. */
  keyDelayMs?: number;
  /**
   * How far below the best option a candidate may be and still be offered.
   * Anything worse is not a judgment call, it is a mistake waiting to be made.
   */
  margin?: number;
}

/** Which piece follows a placement, and the hold/queue state after it, under the game's hold rules. */
export function piecesAfter(p: PiecesInPlay, viaHold: boolean): { next: PieceType | null; hold: PieceType | null; queue: PieceType[] } {
  if (!viaHold) return { next: p.queue[0] ?? null, hold: p.hold, queue: p.queue.slice(1) };
  if (p.hold === null) {
    // Holding with an empty hold: the live piece goes to hold and the next piece comes out now.
    return { next: p.queue[1] ?? null, hold: p.live, queue: p.queue.slice(2) };
  }
  return { next: p.queue[0] ?? null, hold: p.live, queue: p.queue.slice(1) };
}

/** The piece that comes out when the player holds now. */
export function heldInPiece(p: PiecesInPlay): PieceType | null {
  if (!p.canHold) return null;
  return p.hold ?? p.queue[0] ?? null;
}

const LOOKAHEAD_POOL = 14;
const LOOKAHEAD_WEIGHT = 0.6;
/**
 * The queue shows three pieces, so the board two placements ahead can be
 * looked at as well. It has to be done for every candidate in the pool, not
 * just the leaders: a total that includes the second ply cannot be compared
 * with one that does not, and mixing them ranks the unexamined options top.
 */
const LOOKAHEAD2_WEIGHT = 0.35;

/**
 * Default spread of the shortlist, in heuristic points.
 *
 * The shortlist is what the model chooses from, so it sets the floor on how
 * badly a turn can go. Measured in play, the model takes something other than
 * the top-ranked option about 40% of the time; that is the point of asking it.
 * But an option far below the best is not a different opinion, it is a lost
 * game -- offering them cost about two thirds of the score in simulation. So
 * code guarantees every option is close to the best and the model judges
 * between them.
 */
export const SHORTLIST_MARGIN = 8;
/**
 * When every other option is far worse, the shortlist is one option long. That
 * is not the model being cut out of the loop: it is code not manufacturing a
 * choice where there is none. Padding the list to a fixed length is what made
 * a wrong pick catastrophic.
 */
const MIN_OPTIONS = 1;

/**
 * Whether an I piece could still be walked into the well on this board. This
 * is the question that decides whether a game survives: once the answer is no,
 * nothing can be cleared, the stack rises, and a rising stack shortens the
 * fall time that the walk depends on. Checked on the board each candidate
 * would leave behind, and priced accordingly.
 */
export function wellIsReachable(board: Board, ctx: EvalContext, fallMs: number | null | undefined, keyDelayMs: number | undefined): boolean {
  if (ctx.wellColumn < 0) return true;
  const reach = reachablePlacements(board, "I", { level: ctx.level, fallMs, keyDelayMs });
  // Only an upright I clears four rows out of a one-column well.
  return reach.some((p) => p.orientation % 2 === 1 && p.x === ctx.wellColumn);
}

/** The placements the live piece (and the piece a hold would bring out) can actually be brought to. */
function reachableEvaluations(input: PlanningInput, ctx: EvalContext, w: Weights, before: BoardFeatures): Evaluation[] {
  const budget = input.keyBudget ?? MOVE_RESET_LIMIT;
  const common = { level: ctx.level, fallMs: input.fallMs, keyDelayMs: input.keyDelayMs, keyBudget: budget };
  // Once gravity is fast the piece is already on the stack, so the placements
  // still open to it depend on where it actually is, not on the spawn column.
  const resting = input.liveCells && isTwentyG(ctx.level);
  const live = resting
    ? reachableFromLive(input.board, input.pieces.live, input.liveCells!, common)
    : reachablePlacements(input.board, input.pieces.live, common);
  const evals = evaluateReachable(input.board, live, w, before, ctx);
  const swapIn = heldInPiece(input.pieces);
  if (swapIn) {
    // A held piece arrives at the spawn column, whatever the live piece was doing,
    // and the hold itself costs one press.
    const held = reachablePlacements(input.board, swapIn, { ...common, viaHold: true, keyBudget: budget - 1 });
    evals.push(...evaluateReachable(input.board, held, w, before, ctx));
  }
  return evals.sort((a, b) => b.score - a.score);
}

/**
 * Works out what the piece can reach, simulates each of those exactly, looks
 * two pieces ahead, then draws up the shortlist: a spread of genuinely
 * different ideas -- the best, the tetris, the one that builds the well, the
 * cleanest, the hold, the lowest -- with everything that is not a real
 * contender dropped at the end.
 */
export function planCandidates(input: PlanningInput): Candidate[] {
  const ctx = input.context ?? NO_CONTEXT;
  const w = input.weights ?? (ctx.wellColumn >= 0 ? TETRIS_WEIGHTS : DEFAULT_WEIGHTS);
  const before = computeFeatures(input.board);
  const evals = reachableEvaluations(input, ctx, w, before);
  if (ctx.wellColumn >= 0 && w.wellUnreachable !== 0) {
    for (const ev of evals) {
      if (ev.lock.linesCleared === 4) continue; // a tetris empties the well by definition
      if (!wellIsReachable(ev.lock.board, ctx, input.fallMs, input.keyDelayMs)) {
        ev.score += w.wellUnreachable;
        ev.wellOutOfReach = true;
      }
    }
    evals.sort((a, b) => b.score - a.score);
  }
  const pool = evals.slice(0, LOOKAHEAD_POOL);
  const candidates: Candidate[] = pool.map((ev) => {
    const after = piecesAfter(input.pieces, ev.placement.viaHold);
    let nextBest: Evaluation | null = null;
    if (after.next && !ev.lock.toppedOut) {
      // The following piece spawns fresh, so it is judged on reachability from
      // the spawn column on the board this placement leaves behind.
      const nextCtx: EvalContext = { ...ctx, backToBack: ev.keepsChain && ev.lock.linesCleared === 4 ? true : ev.lock.linesCleared === 0 ? ctx.backToBack : false };
      const nextPlacements = reachablePlacements(ev.lock.board, after.next, { level: ctx.level, fallMs: input.fallMs, keyDelayMs: input.keyDelayMs });
      nextBest = evaluateReachable(ev.lock.board, nextPlacements, w, computeFeatures(ev.lock.board), nextCtx)[0] ?? null;
    }
    const total = ev.score + (nextBest ? LOOKAHEAD_WEIGHT * nextBest.score : 0);
    return { id: "", evaluation: ev, nextBest, nextPiece: after.next, total, tags: [], afterQueue: after.queue };
  });
  // Second ply: the same treatment for every candidate, so the totals stay
  // comparable.
  for (const c of candidates) {
    const third = c.afterQueue?.[0];
    if (!third || !c.nextBest || c.nextBest.lock.toppedOut) continue;
    const board = c.nextBest.lock.board;
    const best = evaluateReachable(board, reachablePlacements(board, third, { level: ctx.level, fallMs: input.fallMs, keyDelayMs: input.keyDelayMs }), w, computeFeatures(board), ctx)[0];
    if (best) c.total += LOOKAHEAD2_WEIGHT * best.score;
  }
  candidates.sort((a, b) => b.total - a.total);
  const count = Math.max(2, input.count ?? 6);
  const chosen: Candidate[] = [];
  const take = (c: Candidate | undefined, tag: string): void => {
    if (!c) return;
    if (!chosen.includes(c)) {
      if (chosen.length >= count) return;
      chosen.push(c);
    }
    c.tags.push(tag);
  };
  take(candidates[0], "best");
  take(candidates.find((c) => c.evaluation.lock.linesCleared === 4), "tetris");
  take(candidates.find((c) => c.evaluation.well !== null && c.evaluation.well.after.readyRows > c.evaluation.well.before.readyRows && c.evaluation.newHoles === 0), "builds-well");
  take(candidates.find((c) => c.evaluation.newHoles === 0 && !c.evaluation.placement.viaHold), "clean");
  take(candidates.find((c) => c.evaluation.placement.viaHold), "hold");
  take([...candidates].sort((a, b) => a.evaluation.after.maxHeight - b.evaluation.after.maxHeight || b.total - a.total)[0], "lowest");
  for (const c of candidates) {
    if (chosen.length >= count) break;
    if (chosen.includes(c)) continue;
    // Diversity: skip a placement in the same columns and orientation as one already chosen.
    const dup = chosen.some((d) => d.evaluation.placement.viaHold === c.evaluation.placement.viaHold && d.evaluation.placement.orientation === c.evaluation.placement.orientation && d.evaluation.placement.x === c.evaluation.placement.x);
    if (dup) continue;
    take(c, "runner-up");
  }
  chosen.sort((a, b) => b.total - a.total);
  // Drop anything that is not a real contender, keeping a choice to make.
  const margin = input.margin ?? SHORTLIST_MARGIN;
  const cut = chosen[0].total - margin;
  const viable = chosen.filter((c, i) => i < MIN_OPTIONS || c.total >= cut);
  viable.forEach((c, i) => {
    c.id = `option_${i + 1}`;
  });
  return viable;
}

/** Code's own pick, used as the safety net and to veto a certain top-out: the highest total. */
export function chooseByCode(candidates: readonly Candidate[]): Candidate {
  return [...candidates].sort((a, b) => b.total - a.total)[0];
}

// ---------------------------------------------------------------------------
// Plain-language labels. Jev reads words far better than numbers, so every
// quantity that matters is described in words and the number is secondary.
// ---------------------------------------------------------------------------

const PIECE_WORDS: Record<PieceType, string> = {
  I: "I (the straight four-long bar)",
  O: "O (the square)",
  T: "T",
  S: "S",
  Z: "Z",
  J: "J",
  L: "L",
};

export function pieceWord(t: PieceType): string {
  return PIECE_WORDS[t];
}

function columnsText(cells: readonly { x: number }[]): string {
  const xs = cells.map((c) => c.x);
  const a = Math.min(...xs), b = Math.max(...xs);
  return a === b ? `column ${a + 1}` : `columns ${a + 1}-${b + 1}`;
}

function sideText(cells: readonly { x: number }[]): string {
  const mid = cells.reduce((s, c) => s + c.x, 0) / cells.length;
  if (mid < 3) return "on the left";
  if (mid < 6) return "in the middle";
  return "on the right";
}

function orientationText(t: PieceType, o: number): string {
  if (t === "O") return "as a square";
  if (t === "I") return o % 2 === 0 ? "lying flat" : "standing upright";
  if (t === "S" || t === "Z") return o % 2 === 0 ? "lying flat" : "standing upright";
  const dir = ["pointing up", "pointing right", "pointing down", "pointing left"][o % 4];
  if (t === "T") return dir.replace("pointing", "with the tip");
  return `rotated ${["not at all (spawn orientation)", "a quarter turn clockwise", "a half turn", "a quarter turn counter-clockwise"][o % 4]}`;
}

export function describeHeight(h: number): string {
  if (h <= 0) return "empty";
  if (h <= 4) return "very low";
  if (h <= 7) return "low";
  if (h <= 10) return "moderate";
  if (h <= 13) return "high";
  if (h <= 16) return "dangerously high";
  return "critical, about to top out";
}

function linesText(n: number): string {
  switch (n) {
    case 0:
      return "no line clear";
    case 1:
      return "clears 1 line (a single)";
    case 2:
      return "clears 2 lines at once (a double)";
    case 3:
      return "clears 3 lines at once (a triple)";
    default:
      return "clears 4 lines at once (a TETRIS, the only clear that pays full value)";
  }
}

/** What the game will actually pay, and what it does to the back-to-back chain. */
function pointsText(ev: Evaluation, ctx: EvalContext): string {
  const lines = ev.lock.linesCleared;
  if (lines === 0) return ctx.backToBack ? "scores nothing now, and keeps the back-to-back chain alive for the next tetris" : "scores nothing now";
  const chained = ctx.backToBack && lines === 4;
  const plain = clearScore(lines, ctx.level, false, 0);
  const parts = [`scores ${ev.points.toLocaleString("en-US")} points`];
  if (chained) parts.push(`(a tetris at level ${ctx.level}, with the back-to-back bonus of half as much again on top of ${plain.toLocaleString("en-US")})`);
  else if (lines === 4) parts.push(`(a tetris at level ${ctx.level}; the next tetris would score half as much again)`);
  else parts.push(`(only ${Math.round(ev.points / lines).toLocaleString("en-US")} per line, against ${Math.round(clearScore(4, ctx.level, true, 0) / 4).toLocaleString("en-US")} per line for a back-to-back tetris)`);
  if (lines > 0 && lines < 4 && ctx.backToBack) parts.push("and it BREAKS the back-to-back chain");
  return parts.join(" ");
}

/** What the option does to the column being kept open for the I piece. */
function wellText(ev: Evaluation): string {
  const w = ev.well;
  if (!w) return "no tetris well is being kept";
  const col = w.after.column + 1;
  const bits: string[] = [];
  if (w.after.blocked > w.before.blocked) bits.push(`PUTS A BLOCK IN THE WELL in column ${col}, which stops any tetris until it is dug out again`);
  else if (w.after.readyRows > w.before.readyRows) bits.push(`adds ${w.after.readyRows - w.before.readyRows} row${w.after.readyRows - w.before.readyRows === 1 ? "" : "s"} ready for the I piece`);
  else if (w.after.readyRows < w.before.readyRows) bits.push(`spends ${w.before.readyRows - w.after.readyRows} of the ready rows`);
  else bits.push(`leaves the well in column ${col} as it is`);
  bits.push(`${w.after.readyRows} of the 4 rows needed for a tetris are ready afterwards`);
  if (w.after.blocked > 0) bits.push(`${w.after.blocked} cell${w.after.blocked === 1 ? "" : "s"} still block the well`);
  if (ev.placement.type === "I" && ev.lock.linesCleared < 4 && w.before.blocked === 0 && !ev.placement.cells.some((c) => c.x === w.after.column)) {
    bits.push("WASTES THE I PIECE: it is the only piece that scores a tetris, one arrives about every seven pieces, and this spends it somewhere else. Holding it instead costs nothing");
  }
  if (ev.wellOutOfReach) {
    bits.push("PUTS THE WELL OUT OF REACH: after this, an I piece can no longer be walked to the well at all, so nothing can be cleared until the surface is flattened again");
  }
  return bits.join("; ");
}

function holesText(ev: Evaluation): string {
  const created = ev.newHoles;
  const total = ev.after.holes;
  const uncovered = Math.max(0, ev.before.holes - (ev.after.holes - created) );
  if (created === 0 && total === 0) return "creates no holes; the stack stays solid";
  if (created === 0) return `creates no new holes (${total} old hole${total === 1 ? " remains" : "s remain"}${uncovered > 0 ? `, ${uncovered} uncovered by the line clear` : ""})`;
  const cols = ev.after.holeColumns;
  return `creates ${created} new buried hole${created === 1 ? "" : "s"} (${cols.length ? `in ${columnsText(cols.map((x) => ({ x })))}` : "under the piece"}); ${total} hole${total === 1 ? "" : "s"} in total afterwards`;
}

function bumpText(f: BoardFeatures): string {
  const b = f.bumpiness;
  if (b <= 4) return "flat";
  if (b <= 9) return "slightly uneven";
  if (b <= 16) return "bumpy";
  return "very jagged";
}

function riskText(ev: Evaluation, ctx: EvalContext): string {
  if (ev.lock.toppedOut) return "ENDS THE GAME: the piece locks above the visible board";
  const h = ev.after.maxHeight;
  const rise = ev.after.maxHeight - ev.before.maxHeight;
  const fast = fallMsForLevel(ctx.level) <= 20 ? ", and at this level a piece lands almost where it appears, so a tall jagged stack cannot be reached across" : "";
  if (h >= VISIBLE_HEIGHT - 2) return `extremely risky: the stack reaches the top rows, the next piece may not fit${fast}`;
  if (h >= 15) return `risky: stack ${describeHeight(h)} (${h} of ${VISIBLE_HEIGHT} rows)${rise > 0 ? ", and this raises it" : ""}${fast}`;
  if (h >= 11) return `caution: stack ${describeHeight(h)} (${h} of ${VISIBLE_HEIGHT} rows)${fast}`;
  return `safe: stack ${describeHeight(h)} (${h} of ${VISIBLE_HEIGHT} rows)`;
}

function outlookText(c: Candidate): string {
  if (!c.nextPiece) return "unknown (next piece not shown)";
  if (c.evaluation.lock.toppedOut) return "none, the game would be over";
  const n = c.nextBest;
  if (!n) return `the following ${c.nextPiece} has nowhere it can reach`;
  const parts: string[] = [];
  parts.push(n.lock.linesCleared === 4 ? "sets up a tetris for the following piece" : n.lock.linesCleared > 0 ? `lets the following ${c.nextPiece} clear ${n.lock.linesCleared} line${n.lock.linesCleared === 1 ? "" : "s"}` : `leaves the following ${c.nextPiece} no clear`);
  parts.push(n.newHoles === 0 ? "without creating a hole" : `but its best spot creates ${n.newHoles} hole${n.newHoles === 1 ? "" : "s"}`);
  return parts.join(" ");
}

export type CandidateDescription = {
  action: string;
  where: string;
  points: string;
  lines: string;
  tetris_well: string;
  holes: string;
  stack_after: string;
  next_piece_outlook: string;
  risk: string;
};

export function describeCandidate(c: Candidate, pieces: PiecesInPlay, ctx: EvalContext = NO_CONTEXT): CandidateDescription {
  const ev = c.evaluation;
  const p = ev.placement;
  const action = p.viaHold
    ? `hold the ${pieces.live} and place the ${p.type} that comes out instead`
    : `place the ${pieces.live}`;
  const landing = Math.min(...p.cells.map((q) => q.y)) + 1;
  return {
    action,
    where: `${orientationText(p.type, p.orientation)}, ${columnsText(p.cells)} ${sideText(p.cells)}, landing on row ${landing} from the bottom`,
    points: pointsText(ev, ctx),
    lines: linesText(ev.lock.linesCleared),
    tetris_well: wellText(ev),
    holes: holesText(ev),
    stack_after: `${describeHeight(ev.after.maxHeight)} (${ev.after.maxHeight} of ${VISIBLE_HEIGHT} rows), surface ${bumpText(ev.after)}`,
    next_piece_outlook: outlookText(c),
    risk: riskText(ev, ctx),
  };
}

export type Situation = {
  board: { stack_height: string; surface: string; holes: string; tetris_well: string; column_heights_left_to_right: string };
  pieces: { live: string; hold: string; next: string };
  scoring: { back_to_back: string; level_pays: string };
  pace: string;
};

export function describeSituation(board: Board, pieces: PiecesInPlay, pace: { level: number; fallMsPerRow: number | null }, ctx: EvalContext = NO_CONTEXT): Situation {
  const f = computeFeatures(board);
  const avg = f.aggregateHeight / f.heights.length;
  const fall = pace.fallMsPerRow;
  const ms = fall ?? fallMsForLevel(pace.level);
  const paceWords = ms <= 0
    ? "gravity is instant: the piece is already resting on the stack when it appears, and can only be turned and walked sideways along the surface before it locks. It cannot be moved across a taller column, so the surface must stay flat"
    : ms <= 20
      ? "gravity is nearly instant: a piece crosses the whole board in a fraction of a second, so it lands close to where it appears and can only be walked along the surface after that. The surface must stay flat or most of the board cannot be reached"
      : ms >= 700 ? "pieces fall slowly, plenty of time"
      : ms >= 300 ? "pieces fall at a moderate pace"
      : ms >= 120 ? "pieces fall fast"
      : "pieces fall very fast, decisions must be immediate";
  const well = ctx.wellColumn >= 0 ? wellStats(board, ctx.wellColumn) : null;
  return {
    board: {
      stack_height: `${describeHeight(f.maxHeight)}: highest column ${f.maxHeight} of ${VISIBLE_HEIGHT} rows, average ${avg.toFixed(1)} rows`,
      surface: bumpText(f),
      holes: f.holes === 0 ? "none" : `${f.holes} buried empty cell${f.holes === 1 ? "" : "s"} in ${columnsText(f.holeColumns.map((x) => ({ x })))}`,
      tetris_well: well === null
        ? "none being kept"
        : `column ${well.column + 1} is being kept empty for the I piece; ${well.readyRows} of the 4 rows needed are ready${well.blocked > 0 ? `, but ${well.blocked} cell${well.blocked === 1 ? " is" : "s are"} blocking it and must be dug out` : ""}`,
      column_heights_left_to_right: f.heights.join(","),
    },
    pieces: {
      live: pieceWord(pieces.live),
      hold: pieces.hold === null ? (pieces.canHold ? "empty (holding would swap the live piece for the next one)" : "empty, and holding is not allowed for this piece") : `${pieceWord(pieces.hold)}${pieces.canHold ? "" : " (already used for this piece: holding is not allowed now)"}`,
      next: pieces.queue.length ? pieces.queue.map((t) => pieceWord(t)).join(", then ") : "not shown",
    },
    scoring: {
      back_to_back: ctx.backToBack
        ? "the back-to-back chain is ALIVE: the next tetris scores half as much again. Any clear of one, two or three lines breaks it."
        : "the back-to-back chain is broken; the next tetris scores normally and starts a new chain",
      level_pays: `at level ${pace.level} a tetris pays ${clearScore(4, pace.level, ctx.backToBack, 0).toLocaleString("en-US")} and a single pays ${clearScore(1, pace.level, false, 0).toLocaleString("en-US")}`,
    },
    pace: `level ${pace.level}: ${paceWords}`,
  };
}
