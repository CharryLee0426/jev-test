/**
 * Candidate placements and their plain-language descriptions.
 *
 * Code owns everything that is arithmetic: which placements exist, what each
 * one does to the board (simulated exactly), how the following piece fares
 * afterwards, and the words that turn those numbers into facts a System One
 * model can judge. The model's job is the judgment: which placement now.
 */
import {
  DEFAULT_WEIGHTS,
  VISIBLE_HEIGHT,
  computeFeatures,
  evaluateAll,
  type Board,
  type BoardFeatures,
  type Evaluation,
  type PieceType,
  type Weights,
} from "./tetris.ts";

export type Posture = "build_for_tetris" | "clear_lines_now" | "repair_surface";

export const POSTURES: readonly Posture[] = ["build_for_tetris", "clear_lines_now", "repair_surface"];

/** Weight presets the model's posture answer selects for the next planning cycle. */
export function postureWeights(p: Posture | null): Weights {
  switch (p) {
    case "build_for_tetris":
      return { ...DEFAULT_WEIGHTS, wellSum: -2.0, tetris: 30, lines: 0.2 };
    case "clear_lines_now":
      return { ...DEFAULT_WEIGHTS, lines: 6, erodedCells: 5, tetris: 6, landingHeight: -3.5 };
    case "repair_surface":
      return { ...DEFAULT_WEIGHTS, holes: -11, newHoles: -8, rowTransitions: -4, columnTransitions: -11 };
    default:
      return DEFAULT_WEIGHTS;
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
}

export interface PlanningInput {
  board: Board;
  pieces: PiecesInPlay;
  weights?: Weights;
  /** How many candidates to keep for the model. */
  count?: number;
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

/** Enumerates, evaluates with a one-piece lookahead, and keeps a diverse shortlist. */
export function planCandidates(input: PlanningInput): Candidate[] {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const before = computeFeatures(input.board);
  const evals: Evaluation[] = evaluateAll(input.board, input.pieces.live, w, false, before);
  const swapIn = heldInPiece(input.pieces);
  if (swapIn) evals.push(...evaluateAll(input.board, swapIn, w, true, before));
  evals.sort((a, b) => b.score - a.score);
  const pool = evals.slice(0, LOOKAHEAD_POOL);
  const candidates: Candidate[] = pool.map((ev) => {
    const after = piecesAfter(input.pieces, ev.placement.viaHold);
    let nextBest: Evaluation | null = null;
    if (after.next && !ev.lock.toppedOut) {
      const nextEvals = evaluateAll(ev.lock.board, after.next, w);
      nextBest = nextEvals[0] ?? null;
    }
    const total = ev.score + (nextBest ? LOOKAHEAD_WEIGHT * nextBest.score : 0);
    return { id: "", evaluation: ev, nextBest, nextPiece: after.next, total, tags: [] };
  });
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
  take(candidates.find((c) => c.evaluation.lock.linesCleared > 0 && c.evaluation.newHoles === 0), "clears");
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
  chosen.forEach((c, i) => {
    c.id = `option_${i + 1}`;
  });
  return chosen;
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
      return "clears 4 lines at once (a TETRIS, the best possible clear)";
  }
}

function holesText(ev: Evaluation): string {
  const created = ev.newHoles;
  const total = ev.after.holes;
  const uncovered = Math.max(0, ev.before.holes - (ev.after.holes - created) );
  if (created === 0 && total === 0) return "creates no holes; the stack stays solid";
  if (created === 0) return `creates no new holes (${total} old hole${total === 1 ? " remains" : "s remain"}${uncovered > 0 ? `, ${uncovered} uncovered by the line clear` : ""})`;
  const cols = ev.after.holeColumns.filter((c) => !ev.before.holeColumns.includes(c) || true);
  return `creates ${created} new buried hole${created === 1 ? "" : "s"} (${cols.length ? `in ${columnsText(cols.map((x) => ({ x })))}` : "under the piece"}); ${total} hole${total === 1 ? "" : "s"} in total afterwards`;
}

function bumpText(f: BoardFeatures): string {
  const b = f.bumpiness;
  if (b <= 4) return "flat";
  if (b <= 9) return "slightly uneven";
  if (b <= 16) return "bumpy";
  return "very jagged";
}

function wellText(before: BoardFeatures, after: BoardFeatures): string {
  const deepBefore = before.wells.filter((w) => w.depth >= 3);
  const deepAfter = after.wells.filter((w) => w.depth >= 3);
  if (deepAfter.length === 0 && deepBefore.length === 0) return "no deep well on the board";
  if (deepAfter.length === 0) return `fills the ${deepBefore.length === 1 ? `well in column ${deepBefore[0].column + 1}` : "wells"}`;
  const w = deepAfter.sort((a, b) => b.depth - a.depth)[0];
  const kept = deepBefore.some((v) => v.column === w.column);
  return `${kept ? "keeps" : "opens"} a ${w.depth}-deep well in column ${w.column + 1}${w.depth >= 4 ? " where an I piece would score a tetris" : " for an I piece"}`;
}

function riskText(ev: Evaluation): string {
  if (ev.lock.toppedOut) return "ENDS THE GAME: the piece locks above the visible board";
  const h = ev.after.maxHeight;
  const rise = ev.after.maxHeight - ev.before.maxHeight;
  if (h >= VISIBLE_HEIGHT - 2) return "extremely risky: the stack reaches the top rows, the next piece may not fit";
  if (h >= 15) return `risky: stack ${describeHeight(h)} (${h} of ${VISIBLE_HEIGHT} rows)${rise > 0 ? ", and this raises it" : ""}`;
  if (h >= 11) return `caution: stack ${describeHeight(h)} (${h} of ${VISIBLE_HEIGHT} rows)`;
  return `safe: stack ${describeHeight(h)} (${h} of ${VISIBLE_HEIGHT} rows)`;
}

function outlookText(c: Candidate): string {
  if (!c.nextPiece) return "unknown (next piece not shown)";
  if (c.evaluation.lock.toppedOut) return "none, the game would be over";
  const n = c.nextBest;
  if (!n) return `the following ${c.nextPiece} has no place to go`;
  const parts: string[] = [];
  parts.push(n.lock.linesCleared > 0 ? `can then clear ${n.lock.linesCleared} line${n.lock.linesCleared === 1 ? "" : "s"}` : "cannot clear a line right away");
  parts.push(n.newHoles === 0 ? "without creating a hole" : `but its best spot creates ${n.newHoles} hole${n.newHoles === 1 ? "" : "s"}`);
  return `the following ${c.nextPiece} ${parts.join(" ")}`;
}

export type CandidateDescription = {
  action: string;
  where: string;
  lines: string;
  holes: string;
  stack_after: string;
  well: string;
  next_piece_outlook: string;
  risk: string;
};

export function describeCandidate(c: Candidate, pieces: PiecesInPlay): CandidateDescription {
  const ev = c.evaluation;
  const p = ev.placement;
  const action = p.viaHold
    ? `hold the ${pieces.live} and place the ${p.type} that comes out instead`
    : `place the ${pieces.live}`;
  const landing = Math.min(...p.cells.map((q) => q.y)) + 1;
  return {
    action,
    where: `${orientationText(p.type, p.orientation)}, ${columnsText(p.cells)} ${sideText(p.cells)}, landing on row ${landing} from the bottom`,
    lines: linesText(ev.lock.linesCleared),
    holes: holesText(ev),
    stack_after: `${describeHeight(ev.after.maxHeight)} (${ev.after.maxHeight} of ${VISIBLE_HEIGHT} rows), surface ${bumpText(ev.after)}`,
    well: wellText(ev.before, ev.after),
    next_piece_outlook: outlookText(c),
    risk: riskText(ev),
  };
}

export type Situation = {
  board: { stack_height: string; surface: string; holes: string; wells: string; column_heights_left_to_right: string };
  pieces: { live: string; hold: string; next: string };
  pace: string;
};

export function describeSituation(board: Board, pieces: PiecesInPlay, pace: { level: number; fallMsPerRow: number | null }): Situation {
  const f = computeFeatures(board);
  const avg = f.aggregateHeight / f.heights.length;
  const deep = f.wells.filter((w) => w.depth >= 3).sort((a, b) => b.depth - a.depth);
  const fall = pace.fallMsPerRow;
  const paceWords = fall === null ? "unknown fall speed" : fall >= 700 ? "pieces fall slowly, plenty of time" : fall >= 300 ? "pieces fall at a moderate pace" : fall >= 120 ? "pieces fall fast" : "pieces fall very fast, decisions must be immediate";
  return {
    board: {
      stack_height: `${describeHeight(f.maxHeight)}: highest column ${f.maxHeight} of ${VISIBLE_HEIGHT} rows, average ${avg.toFixed(1)} rows`,
      surface: bumpText(f),
      holes: f.holes === 0 ? "none" : `${f.holes} buried empty cell${f.holes === 1 ? "" : "s"} in ${columnsText(f.holeColumns.map((x) => ({ x })))}`,
      wells: deep.length === 0 ? "no deep well" : deep.map((w) => `a ${w.depth}-deep well in column ${w.column + 1}`).join(", "),
      column_heights_left_to_right: f.heights.join(","),
    },
    pieces: {
      live: pieceWord(pieces.live),
      hold: pieces.hold === null ? (pieces.canHold ? "empty (holding would swap the live piece for the next one)" : "empty, and holding is not allowed for this piece") : `${pieceWord(pieces.hold)}${pieces.canHold ? "" : " (already used for this piece: holding is not allowed now)"}`,
      next: pieces.queue.length ? pieces.queue.map((t) => pieceWord(t)).join(", then ") : "not shown",
    },
    pace: `level ${pace.level}: ${paceWords}`,
  };
}
