/**
 * An offline game, played by the code heuristic alone.
 *
 * The agent's shortlist is drawn up by code and Jev picks from it, so how good
 * the shortlist is decides the ceiling of the whole thing. This plays whole
 * marathons against the real rules -- the same scoring table, the same 30
 * levels, the same gravity per level and the same reachability limits -- in a
 * few milliseconds each, which is what makes the strategy tunable at all. A
 * live game takes minutes and answers one question.
 *
 * It is a lower bound, not a prediction: Jev sees the same options plus the
 * words explaining them, and can take the judgment calls the heuristic gets
 * wrong.
 */
import { chooseByCode, planCandidates, postureWeights, type Candidate, type PiecesInPlay, type Posture } from "./planner.ts";
import {
  HARD_DROP_POINTS_PER_ROW,
  LINES_PER_LEVEL,
  MAX_LEVEL,
  clearScore,
  fallMsForLevel,
  keepsBackToBack,
  levelAfterLines,
} from "./score.ts";
import { SPAWN_ROW } from "./reach.ts";
import {
  PIECE_TYPES,
  chooseWellColumn,
  columnHeights,
  emptyBoard,
  lockPiece,
  VISIBLE_HEIGHT,
  WIDTH,
  type Board,
  type EvalContext,
  type PieceType,
  type Weights,
} from "./tetris.ts";

/** How many upcoming pieces the game shows (matching the live game's queue). */
const QUEUE_SHOWN = 3;

/** Small deterministic generator, so a run can be repeated exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** The game's own randomizer: every seven pieces is a shuffled bag of all seven. */
function bagSource(seed: number): () => PieceType {
  const next = rng(seed);
  let bag: PieceType[] = [];
  return () => {
    if (bag.length === 0) {
      bag = [...PIECE_TYPES];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop()!;
  };
}

export interface SimOptions {
  seed: number;
  /** Level the game starts on. */
  startLevel?: number;
  /** Override the heuristic; by default the posture presets are used. */
  weights?: Weights;
  /** Shortlist size, as the agent uses it. */
  candidates?: number;
  /** Give up after this many pieces, so a bad configuration cannot hang. */
  maxPieces?: number;
  /** How far below the best an option may be and still be offered; see SHORTLIST_MARGIN. */
  margin?: number;
  /**
   * Which option gets played. The default is code's own pick. Passing a policy
   * that sometimes takes a lower-ranked option is how the shortlist is tested
   * against a chooser that does not always agree with the ranking -- which is
   * what a model is.
   */
  choose?: (candidates: Candidate[], random: () => number) => Candidate;
}

export interface SimResult {
  score: number;
  lines: number;
  level: number;
  pieces: number;
  /** Clears by size: singles, doubles, triples, tetrises. */
  clears: [number, number, number, number];
  /** Share of cleared lines that came four at a time. */
  tetrisShare: number;
  endedBy: "topout" | "complete" | "stuck";
  /** Height of the stack when it ended. */
  finalHeight: number;
  /** The level the game was on when it ended, for seeing where runs die. */
  diedAtLevel: number;
}

/**
 * Picks the posture the same way the model is asked to: from the board. This
 * keeps the simulation honest about the weights actually used in play.
 */
function posture(board: Board, ctx: EvalContext): Posture {
  const heights = columnHeights(board);
  const maxHeight = Math.max(...heights);
  let holes = 0;
  for (let x = 0; x < WIDTH; x++) for (let y = 0; y < heights[x]; y++) if (!board[y * WIDTH + x]) holes++;
  if (maxHeight >= VISIBLE_HEIGHT - 6) return "survive_now";
  if (holes > 0) return "repair_surface";
  return "build_tetris_well";
}

export function simulateGame(opts: SimOptions): SimResult {
  const startLevel = opts.startLevel ?? 1;
  const nextPiece = bagSource(opts.seed);
  const choiceRandom = rng(opts.seed ^ 0x5bf03635);
  let board: Board = emptyBoard();
  let hold: PieceType | null = null;
  let canHold = true;
  let live = nextPiece();
  const queue: PieceType[] = Array.from({ length: QUEUE_SHOWN }, () => nextPiece());

  let score = 0;
  let lines = 0;
  let backToBack = false;
  let combo = 0;
  let wellColumn = WIDTH - 1;
  const clears: [number, number, number, number] = [0, 0, 0, 0];
  const maxPieces = opts.maxPieces ?? 3000;

  for (let piece = 0; piece < maxPieces; piece++) {
    const level = Math.min(MAX_LEVEL, levelAfterLines(lines, startLevel));
    if (lines >= (MAX_LEVEL - startLevel + 1) * LINES_PER_LEVEL) {
      return finish("complete", level, piece);
    }
    wellColumn = chooseWellColumn(board, wellColumn);
    const ctx: EvalContext = { wellColumn, level, backToBack, combo, fallMs: fallMsForLevel(level) };
    const pieces: PiecesInPlay = { live, hold, canHold, queue: [...queue] };
    const weights = opts.weights ?? postureWeights(posture(board, ctx));
    const candidates = planCandidates({
      board,
      pieces,
      weights,
      count: opts.candidates ?? 6,
      context: ctx,
      fallMs: ctx.fallMs,
      keyDelayMs: 16,
      margin: opts.margin,
    });
    if (candidates.length === 0) return finish("stuck", level, piece);
    const chosen = opts.choose ? opts.choose(candidates, choiceRandom) : chooseByCode(candidates);
    const placement = chosen.evaluation.placement;

    // Apply the hold exactly as the game does before the piece is placed.
    if (placement.viaHold) {
      if (hold === null) {
        hold = live;
        live = queue.shift()!;
        queue.push(nextPiece());
      } else {
        const swap = hold;
        hold = live;
        live = swap;
      }
    }
    // Hard-drop points: two a row, for the rows the drop itself covers. The
    // piece is falling the whole time the plan is being keyed in, so at slow
    // levels the drop covers almost the full height and at 20G it covers
    // nothing, which is why they fade out exactly as the level rises.
    const execMs = (chosen.evaluation.keys ?? 6) * 16;
    const rowsFallenWhileMoving = ctx.fallMs && ctx.fallMs > 0 ? execMs / ctx.fallMs : SPAWN_ROW;
    const dropRows = Math.max(0, Math.round(SPAWN_ROW - placement.y - rowsFallenWhileMoving));
    score += HARD_DROP_POINTS_PER_ROW * dropRows;

    const lock = lockPiece(board, placement);
    if (lock.toppedOut) return finish("topout", level, piece);
    board = lock.board;

    const cleared = lock.linesCleared;
    if (cleared > 0) {
      clears[cleared - 1]++;
      score += clearScore(cleared, level, backToBack, combo);
      combo += 1;
      backToBack = keepsBackToBack(cleared);
      lines += cleared;
    } else {
      combo = 0;
    }
    // A piece that locks with any cell above the visible matrix ends the game.
    if (placement.cells.every((c) => c.y >= VISIBLE_HEIGHT)) return finish("topout", level, piece);
    if (Math.max(...columnHeights(board)) > VISIBLE_HEIGHT) return finish("topout", level, piece);

    live = queue.shift()!;
    queue.push(nextPiece());
    canHold = true;
  }
  return finish("topout", levelAfterLines(lines, startLevel), maxPieces);

  function finish(endedBy: SimResult["endedBy"], level: number, pieces: number): SimResult {
    const fromTetrises = clears[3] * 4;
    const total = clears[0] + clears[1] * 2 + clears[2] * 3 + fromTetrises;
    return {
      score,
      lines,
      level,
      pieces,
      clears,
      tetrisShare: total === 0 ? 0 : fromTetrises / total,
      endedBy,
      finalHeight: Math.max(...columnHeights(board)),
      diedAtLevel: level,
    };
  }
}

export interface SimSummary {
  games: number;
  meanScore: number;
  medianScore: number;
  bestScore: number;
  meanLines: number;
  meanTetrisShare: number;
  completed: number;
  /** Where games end, by level. */
  diedAtLevel: Record<number, number>;
}

/**
 * A chooser that follows the rank distribution measured from live play: the
 * top option most of the time, a lower one often enough to matter.
 */
export function rankedChooser(shares: readonly number[]): (c: Candidate[], r: () => number) => Candidate {
  const total = shares.reduce((a, v) => a + v, 0);
  return (candidates, random) => {
    const ranked = [...candidates].sort((a, b) => b.total - a.total);
    let roll = random() * total;
    for (let i = 0; i < shares.length; i++) {
      roll -= shares[i];
      if (roll <= 0) return ranked[Math.min(i, ranked.length - 1)];
    }
    return ranked[0];
  };
}

export function simulate(games: number, opts: Omit<SimOptions, "seed"> & { seed?: number } = {}): SimSummary {
  const base = opts.seed ?? 1;
  const results: SimResult[] = [];
  for (let i = 0; i < games; i++) results.push(simulateGame({ ...opts, seed: base + i * 7919 }));
  const scores = results.map((r) => r.score).sort((a, b) => a - b);
  const diedAtLevel: Record<number, number> = {};
  for (const r of results) diedAtLevel[r.diedAtLevel] = (diedAtLevel[r.diedAtLevel] ?? 0) + 1;
  return {
    games,
    meanScore: Math.round(scores.reduce((a, v) => a + v, 0) / games),
    medianScore: scores[Math.floor(games / 2)],
    bestScore: scores[scores.length - 1],
    meanLines: Math.round(results.reduce((a, r) => a + r.lines, 0) / games),
    meanTetrisShare: results.reduce((a, r) => a + r.tetrisShare, 0) / games,
    completed: results.filter((r) => r.endedBy === "complete").length,
    diedAtLevel,
  };
}
