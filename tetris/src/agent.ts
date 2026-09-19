/**
 * The agent loop: receives snapshots from the game frame, plans candidate
 * placements for every new piece, asks the brain which one to take, checks
 * that the answer still applies to the piece on screen, and hands the page a
 * plan to execute with key presses.
 *
 * Latency handling: while a piece is being placed, the next piece is already
 * known from the queue, so the agent simulates the board after the chosen
 * placement and asks about the next piece right away ("pre-planning"). When
 * that piece spawns and the board matches the prediction, the answer is
 * applied immediately; otherwise a fresh request goes out. If no answer is
 * back before the piece has fallen most of the way, the code safety net
 * places it (when enabled) and the late answer is counted as stale.
 */
import type { AdHandler } from "./ads.ts";
import type { Brain, Decision, DecisionRequest } from "./brain.ts";
import { describeApiError } from "./brain-jev.ts";
import type { PageControl } from "./browser.ts";
import { describeObjective, type AgentConfig } from "./config.ts";
import type { PagePlan, PageSnapshot } from "./page-agent.ts";
import { chooseByCode, describeSituation, piecesAfter, planCandidates, postureWeights, type Candidate, type PiecesInPlay, type Posture } from "./planner.ts";
import { MAX_LEVEL, MOVE_RESET_LIMIT, bestRemainingScore, fallMsForLevel, isTwentyG, lockMsForLevel } from "./score.ts";
import { reachableFromLive } from "./reach.ts";
import {
  DEFAULT_WEIGHTS,
  HEIGHT,
  PIECE_TYPES,
  WIDTH,
  chooseWellColumn,
  columnHeights,
  computeFeatures,
  emptyBoard,
  evaluatePlacement,
  normalizedKey,
  wellStats,
  type Board,
  NO_CONTEXT,
  type EvalContext,
  type PieceType,
} from "./tetris.ts";

export type StopReason = "target-level" | "target-score" | "time-limit" | "runs" | "fatal" | "manual";
export type Phase = "connecting" | "ads" | "starting" | "play" | "gameover" | "restarting";

export interface AgentOptions {
  brain: Brain;
  config: AgentConfig;
  /** Confidence below which the posture answer is ignored. */
  postureConfidenceFloor: number;
  log?: (event: Record<string, unknown>) => void;
}

export interface AgentStats {
  requests: number;
  answers: number;
  applied: number;
  preplanHits: number;
  preplanMisses: number;
  stale: number;
  vetoed: number;
  late: number;
  errors: number;
  rateLimited: number;
  placedByJev: number;
  placedByCode: number;
  execFailed: number;
  /** Placements that locked off target under instant gravity; the piece was still placed. */
  offTarget: number;
  /** Pieces the planner could offer nothing for. Always a bug; the piece is hard-dropped so the game cannot stall. */
  noCandidates: number;
  /** Times the agent was found not placing pieces at all and had to be restarted. Always a bug. */
  stalls: number;
  /** Clears made, by how many lines each one took. What the strategy is finally judged on. */
  clears: [number, number, number, number];
  inputTokens: number;
  pieces: number;
}

export interface RunSummary {
  run: number;
  score: number;
  /** Level as shown in the game (1-based). */
  level: number;
  lines: number;
  pieces: number;
  durationMs: number;
  placedByJev: number;
  placedByCode: number;
  jevAnswers: number;
  /** `complete` means level 30 was finished and the game ended of its own accord: the whole marathon. */
  endedBy: "topout" | "stop" | "complete";
}

export interface AgentStatus {
  phase: Phase;
  run: number;
  score: number;
  level: number;
  linesToNext: number;
  lines: number;
  pieces: number;
  goal: { targetLevel: number; targetScore: number; secondsLeft: number | null; runsLeft: number | null };
  stopReason: StopReason | null;
  latencyP50: number;
  latencyP90: number;
  requestsPerSecond: number;
  lastDecision: Decision | null;
  lastChoice: string | null;
  posture: Posture | null;
  /** Column being kept open for the I piece, 1-based for display. */
  wellColumn: number;
  /** Rows already full except the well: how close the next tetris is. */
  readyRows: number;
  backToBack: boolean;
  /** Points still needed for the target, and the most that can still be scored. */
  toTarget: number;
  ceiling: number;
  adMessage: string | null;
  stats: AgentStats;
  runs: RunSummary[];
  brain: string;
  message: string | null;
}

interface PendingRequest {
  /** State key the request was built for. */
  key: string;
  candidates: Candidate[];
  request: DecisionRequest;
  sentAt: number;
  decision: Decision | null;
  /** Set when the request was answered or failed. */
  settled: boolean;
  /** True for a request about a piece that has not spawned yet. */
  preplan: boolean;
  /** For a pre-plan: the piece type predicted to spawn, so the plan can be armed in the page. */
  expectType?: PieceType;
  /** For a pre-plan: the board the request was built on, for the page to check the prediction came true. */
  boardSig?: string;
}

/** A plan left waiting in the page for a piece that has not spawned yet. */
interface ArmedPlan {
  planId: number;
  candidate: Candidate;
  /**
   * What makes the plan valid, and exactly what the page checks before firing
   * it: the board it was computed on and the piece it was computed for. Node
   * has to test the same two things, or the page could fire a plan Node has
   * written off and the piece would be played twice.
   */
  boardSig: string;
  expectType: PieceType;
  source: "jev" | "code";
}

interface ActivePlan {
  planId: number;
  pieceId: number;
  candidate: Candidate;
  source: "jev" | "code";
  /** The plan starts with a hold, which swaps the live piece for another one mid-plan. */
  hold: boolean;
  /** The hold swap has been seen once. A plan only ever swaps once, and treating every later spawn as that swap wedges the agent. */
  holdSwapSeen: boolean;
  done: boolean;
}

const LINES_PER_LEVEL = 10;
/**
 * How long the agent may go without placing a piece before it is treated as
 * stuck. Generous: even at level 1 a piece is placed about every 700 ms, and
 * the ad and menu phases are excluded.
 */
const STALL_MS = 4000;
/**
 * Time to get the first key into the page and onto a frame. Only the first one
 * has to beat the lock: it restarts the timer, and so does every press after it.
 */
const FIRST_KEY_MS = 60;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

export function boardFromSnapshot(s: PageSnapshot): Board {
  const b = emptyBoard();
  const w = s.width || WIDTH;
  const h = Math.min(s.height || HEIGHT, HEIGHT);
  for (let y = 0; y < h; y++) for (let x = 0; x < Math.min(w, WIDTH); x++) if (s.board[y * w + x] === "#") b[y * WIDTH + x] = 8;
  return b;
}

function toPieceType(name: string | null | undefined): PieceType | null {
  return name && (PIECE_TYPES as readonly string[]).includes(name) ? (name as PieceType) : null;
}

export function piecesFromSnapshot(s: PageSnapshot): PiecesInPlay | null {
  const live = toPieceType(s.live?.type);
  if (!live) return null;
  return {
    live,
    hold: toPieceType(s.hold),
    canHold: s.canHold,
    queue: s.queue.map(toPieceType).filter((t): t is PieceType => t !== null),
  };
}

/** The board in the same characters the page pushes, so the page can check a prediction came true. */
export function boardSignature(board: Board): string {
  let out = "";
  for (let i = 0; i < board.length; i++) out += board[i] ? "#" : ".";
  return out;
}

/** Identifies a decision situation: the board plus the pieces the candidates depend on. */
export function stateKey(board: Board, pieces: PiecesInPlay): string {
  let b = "";
  for (let i = 0; i < board.length; i++) b += board[i] ? "#" : ".";
  return `${b}|${pieces.live}|${pieces.hold ?? "-"}|${pieces.canHold ? 1 : 0}|${pieces.queue[0] ?? "-"}`;
}

/** Lines cleared in this game: levels gained since the start plus the progress inside the current level. */
/**
 * When the live piece is already resting on the stack -- which is every piece
 * from level 20 -- the placements it can still reach are the ones it can be
 * turned into and walked to along the surface. Returns the best of them, or
 * null when nothing is reachable.
 */
export function slidingCandidate(
  board: Board,
  type: PieceType,
  liveCells: number[][],
  weights = DEFAULT_WEIGHTS,
  ctx: EvalContext = NO_CONTEXT,
  keyBudget = MOVE_RESET_LIMIT,
): Candidate | null {
  const minY = Math.min(...liveCells.map((c) => c[1]));
  const heights = columnHeights(board);
  if (minY > Math.max(...heights) + 1) return null;
  const before = computeFeatures(board);
  const options = reachableFromLive(board, type, liveCells, { level: ctx.level, keyBudget }).map((p) => {
    const ev = evaluatePlacement(board, before, p, weights, ctx);
    ev.keys = p.keys;
    return ev;
  });
  if (options.length === 0) return null;
  options.sort((a, b) => b.score - a.score);
  const ev = options[0];
  return { id: "slide", evaluation: ev, nextBest: null, nextPiece: null, total: ev.score, tags: ["slide"] };
}

export function totalLines(level: number, linesToNext: number, startLevel = 0): number {
  return Math.max(0, (level - startLevel) * LINES_PER_LEVEL + (LINES_PER_LEVEL - linesToNext));
}

export class Agent {
  readonly opts: AgentOptions;
  readonly cfg: AgentConfig;
  readonly page: PageControl;
  readonly ads: AdHandler;
  readonly stats: AgentStats = {
    requests: 0, answers: 0, applied: 0, preplanHits: 0, preplanMisses: 0, stale: 0, vetoed: 0, late: 0, errors: 0, rateLimited: 0,
    placedByJev: 0, placedByCode: 0, execFailed: 0, offTarget: 0, noCandidates: 0, stalls: 0, clears: [0, 0, 0, 0], inputTokens: 0, pieces: 0,
  };
  readonly runs: RunSummary[] = [];
  stopReason: StopReason | null = null;
  fatal: Error | null = null;

  private phase: Phase = "connecting";
  private latest: PageSnapshot | null = null;
  private connectedAt = performance.now();
  private run = 0;
  private runStartedAt = 0;
  private runPieces = 0;
  private runPlacedByJev = 0;
  private runPlacedByCode = 0;
  private runJevAnswers = 0;
  private lastLiveId: number | null = null;
  private activePlan: ActivePlan | null = null;
  private planSeq = 0;
  private live: PendingRequest | null = null;
  private preplan: PendingRequest | null = null;
  private waitingKey: string | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private fallbackDoneFor: number | null = null;
  private failedFor: number | null = null;
  private rtts: number[] = [];
  private requestTimes: number[] = [];
  private lastDecision: Decision | null = null;
  private lastChoice: string | null = null;
  private posture: Posture | null = null;
  /** The column kept empty for the I piece. Sticky across pieces so the stack is built against one place. */
  private wellColumn = WIDTH - 1;
  private armed: ArmedPlan | null = null;
  private slowUntil = 0;
  private stopped = false;
  private message: string | null = null;
  private finished: (() => void) | null = null;
  private deadline: number | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private flowTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private startLevelIndex = 0;
  private gameOverAt = 0;
  private gameOverHandled = false;
  private lastPlacementAt = 0;
  /**
   * Results for plans Node has not adopted yet. An armed plan runs on the
   * spawn frame, so its result can reach Node in the same snapshot that first
   * shows the piece -- before `onNewPiece` has made it the active plan. Dropping
   * it left the agent holding a plan that never finished, which for a hold plan
   * stopped it placing pieces at all: the score froze and the stack rose two
   * rows a piece until the game ended, looking exactly like a top-out.
   */
  private readonly earlyExecs = new Map<number, PageSnapshot["events"][number]>();

  constructor(page: PageControl, ads: AdHandler, opts: AgentOptions) {
    this.page = page;
    this.ads = ads;
    this.opts = opts;
    this.cfg = opts.config;
  }

  /** Resolves when a stop condition is met (or never, when unlimited). */
  start(): Promise<void> {
    this.phase = "ads";
    this.connectedAt = performance.now();
    if (this.cfg.maxSeconds > 0) {
      this.deadline = performance.now() + this.cfg.maxSeconds * 1000;
      this.sessionTimer = setTimeout(() => {
        this.message = `time limit of ${this.cfg.maxSeconds}s reached`;
        this.stop("time-limit");
      }, this.cfg.maxSeconds * 1000);
    }
    this.flowTimer = setInterval(() => void this.flowTick().catch((err: unknown) => {
      this.message = err instanceof Error ? err.message : String(err);
    }), 400);
    return new Promise((resolve) => {
      this.finished = resolve;
    });
  }

  stop(reason: StopReason = "manual"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    if (this.flowTimer) clearInterval(this.flowTimer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.phase === "play" && this.latest) this.finishRun(this.latest, "stop");
    this.finished?.();
  }

  status(): AgentStatus {
    const sorted = [...this.rtts].sort((a, b) => a - b);
    const now = performance.now();
    this.requestTimes = this.requestTimes.filter((t) => now - t < 5000);
    const s = this.latest;
    return {
      phase: this.phase,
      run: this.run,
      score: s?.score ?? 0,
      level: (s?.level ?? 0) + 1,
      linesToNext: s?.linesToNext ?? 0,
      lines: s ? totalLines(s.level, s.linesToNext, this.startLevelIndex) : 0,
      pieces: this.stats.pieces,
      goal: {
        targetLevel: this.cfg.targetLevel,
        targetScore: this.cfg.targetScore,
        secondsLeft: this.deadline === null ? null : Math.max(0, Math.ceil((this.deadline - now) / 1000)),
        runsLeft: this.cfg.runs > 0 ? Math.max(0, this.cfg.runs - this.run) : null,
      },
      stopReason: this.stopReason,
      latencyP50: percentile(sorted, 0.5),
      latencyP90: percentile(sorted, 0.9),
      requestsPerSecond: this.requestTimes.length / 5,
      lastDecision: this.lastDecision,
      lastChoice: this.lastChoice,
      posture: this.posture,
      wellColumn: this.wellColumn + 1,
      readyRows: s && s.board ? wellStats(boardFromSnapshot(s), this.wellColumn).readyRows : 0,
      backToBack: s?.backToBack ?? false,
      toTarget: this.cfg.targetScore > 0 ? Math.max(0, this.cfg.targetScore - (s?.score ?? 0)) : 0,
      ceiling: s ? bestRemainingScore(s.level + 1, s.linesToNext, s.backToBack) : 0,
      adMessage: this.phase === "play" ? null : this.ads.status.message,
      stats: this.stats,
      runs: this.runs,
      brain: this.opts.brain.name,
      message: this.message,
    };
  }

  // ---------------------------------------------------------------------
  // Flow: ads, menu, starting games, restarting after a game over.
  // ---------------------------------------------------------------------

  private async flowTick(): Promise<void> {
    if (this.stopped) return;
    if (this.phase === "play") {
      this.watchdog();
      return;
    }
    await this.ads.tick();
    const s = this.latest;
    const now = performance.now();
    switch (this.phase) {
      case "ads": {
        if (!s) return;
        const ready = this.ads.clear() && s.scene === "mainMenu" && (this.ads.status.prerollDone || now - this.connectedAt > 45_000);
        if (ready) await this.startGame();
        return;
      }
      case "starting":
      case "restarting": {
        if (s && s.scene === "game" && !s.ended) {
          this.beginRun();
          return;
        }
        if (now - this.startedAt > 12_000 && this.ads.clear() && s && (s.scene === "mainMenu" || s.scene === "gameOver" || s.scene === "newHighScore")) {
          this.message = `game did not start from ${s.scene}; trying again`;
          await this.startGame();
        }
        return;
      }
      case "gameover": {
        if (now - this.gameOverAt >= this.cfg.restartDelay && s && (s.scene === "gameOver" || s.scene === "newHighScore" || s.scene === "mainMenu")) await this.startGame();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Notices when the agent has stopped placing pieces while a game is still
   * running, and unsticks it.
   *
   * This has happened twice for different reasons, and both times it was
   * invisible: pieces fall and lock untouched, the score stops moving, the
   * stack rises two rows a piece, and the game ends looking exactly like an
   * ordinary top-out. Both causes are fixed, but a stall is silent by nature,
   * so it is worth catching as a class rather than one bug at a time.
   */
  private watchdog(): void {
    const snap = this.latest;
    if (!snap || snap.scene !== "game" || snap.ended || !snap.live) return;
    const since = performance.now() - this.lastPlacementAt;
    if (since < STALL_MS) return;
    this.stats.stalls++;
    this.message = `no piece placed for ${Math.round(since / 1000)}s; restarting the decision loop`;
    this.opts.log?.({ type: "stall", run: this.run, sinceMs: Math.round(since), pieceId: snap.live.id, level: snap.level + 1, activePlan: this.activePlan?.planId ?? null, armed: this.armed?.planId ?? null });
    this.lastPlacementAt = performance.now();
    this.activePlan = null;
    this.armed = null;
    this.preplan = null;
    this.waitingKey = null;
    this.live = null;
    void this.page.arm(null);
    // Treat the piece on screen as new, so the normal path plans for it.
    this.lastLiveId = null;
    this.onNewPiece(snap);
  }

  private async startGame(): Promise<void> {
    const wasGameOver = this.phase === "gameover";
    this.phase = wasGameOver ? "restarting" : "starting";
    this.startedAt = performance.now();
    const res = await this.page.startGame(Math.max(0, this.cfg.startLevel - 1));
    this.opts.log?.({ type: "start", ...res });
    if (!res.ok) {
      this.message = `start: ${res.reason ?? "failed"}`;
      if (wasGameOver) {
        this.phase = "gameover";
        this.gameOverAt = performance.now();
      } else {
        this.phase = "ads";
      }
    }
  }

  private beginRun(): void {
    this.run += 1;
    this.phase = "play";
    this.runStartedAt = performance.now();
    this.lastPlacementAt = performance.now();
    this.startLevelIndex = Math.max(0, this.cfg.startLevel - 1);
    this.runPieces = 0;
    this.runPlacedByJev = 0;
    this.runPlacedByCode = 0;
    this.runJevAnswers = 0;
    this.lastLiveId = null;
    this.activePlan = null;
    this.live = null;
    this.preplan = null;
    this.waitingKey = null;
    this.posture = null;
    this.wellColumn = WIDTH - 1;
    this.armed = null;
    this.earlyExecs.clear();
    this.gameOverHandled = false;
    this.message = null;
    this.opts.log?.({ type: "run-start", run: this.run });
  }

  /** Pieces placed in earlier games, so the first spawn of a game can be recognized. */
  private runsPiecesBefore(): number {
    return this.runs.reduce((n, r) => n + r.pieces, 0);
  }

  private finishRun(s: PageSnapshot, endedBy: RunSummary["endedBy"]): void {
    if (this.gameOverHandled) return;
    this.gameOverHandled = true;
    const lines = totalLines(s.level, s.linesToNext, this.startLevelIndex);
    // Finishing level 30 ends the game by the rules, not by topping out, and
    // the two are worth telling apart: one is the whole marathon played.
    if (endedBy === "topout" && lines >= (MAX_LEVEL - this.startLevelIndex) * LINES_PER_LEVEL) endedBy = "complete";
    const summary: RunSummary = {
      run: this.run,
      score: s.score,
      level: s.level + 1,
      lines,
      pieces: this.runPieces,
      durationMs: Math.round(performance.now() - this.runStartedAt),
      placedByJev: this.runPlacedByJev,
      placedByCode: this.runPlacedByCode,
      jevAnswers: this.runJevAnswers,
      endedBy,
    };
    this.runs.push(summary);
    this.opts.log?.({ type: "run", ...summary });
  }

  // ---------------------------------------------------------------------
  // Snapshots from the page.
  // ---------------------------------------------------------------------

  onSnapshot(snap: PageSnapshot): void {
    if (this.stopped) return;
    const prev = this.latest;
    this.latest = snap;
    // Scene and state changes are how a game starts, pauses and ends, so they
    // are logged: a game that stops for a reason other than a top-out shows up
    // here and nowhere else.
    if (!prev || prev.scene !== snap.scene || prev.state !== snap.state || prev.ended !== snap.ended) {
      this.opts.log?.({
        type: "scene",
        run: this.run,
        phase: this.phase,
        scene: snap.scene,
        from: prev ? `${prev.scene}/${prev.state ?? "-"}` : "-",
        state: snap.state,
        ended: snap.ended,
        active: snap.active,
        score: snap.score,
        level: snap.level + 1,
        linesToNext: snap.linesToNext,
        adActive: snap.adActive,
        maxHeight: Math.max(...columnHeights(boardFromSnapshot(snap))),
        live: snap.live ? { type: snap.live.type, y: snap.live.y, cells: snap.live.cells } : null,
      });
    }
    for (const e of snap.events) this.onPageEvent(e, snap);
    if (this.phase !== "play") return;
    if (snap.scene === "gameOver" || (snap.scene === "game" && snap.ended)) {
      this.finishRun(snap, "topout");
      this.phase = "gameover";
      this.gameOverAt = performance.now();
      this.message = `game over at score ${snap.score}`;
      if (this.cfg.runs > 0 && this.run >= this.cfg.runs) {
        this.message = `finished ${this.run} game(s)`;
        this.stop("runs");
      }
      return;
    }
    if (snap.scene !== "game") return;
    if (this.cfg.targetLevel > 0 && snap.level + 1 >= this.cfg.targetLevel) {
      this.message = `reached level ${snap.level + 1} in game ${this.run}`;
      this.opts.log?.({ type: "target", kind: "level", run: this.run, level: snap.level + 1, score: snap.score });
      this.stop("target-level");
      return;
    }
    if (this.cfg.targetScore > 0 && snap.score >= this.cfg.targetScore) {
      this.message = `reached score ${snap.score} in game ${this.run}`;
      this.opts.log?.({ type: "target", kind: "score", run: this.run, level: snap.level + 1, score: snap.score });
      this.stop("target-score");
      return;
    }
    if (snap.state === "pieceActive" && snap.live && snap.live.id !== this.lastLiveId) {
      const plan = this.activePlan;
      if (plan && plan.hold && !plan.done && !plan.holdSwapSeen && plan.pieceId === this.lastLiveId) {
        plan.holdSwapSeen = true;
        // Our own hold swapped the live piece: same turn, not a new spawn.
        this.lastLiveId = snap.live.id;
        plan.pieceId = snap.live.id;
        return;
      }
      this.lastLiveId = snap.live.id;
      this.onNewPiece(snap);
    }
  }

  private onPageEvent(e: PageSnapshot["events"][number], snap: PageSnapshot): void {
    if (e.type !== "exec") return;
    const plan = this.activePlan;
    if (!plan || plan.planId !== e.planId) {
      this.earlyExecs.set(e.planId, e);
      // Only the last few matter; anything older has been overtaken.
      if (this.earlyExecs.size > 8) this.earlyExecs.delete(this.earlyExecs.keys().next().value!);
      return;
    }
    this.applyExec(e, plan, snap);
  }

  /** Books in the result of a plan the page has finished. */
  private applyExec(e: Extract<PageSnapshot["events"][number], { type: "exec" }>, plan: ActivePlan, snap: PageSnapshot): void {
    plan.done = true;
    this.opts.log?.({ type: "exec", run: this.run, planId: e.planId, pieceId: plan.pieceId, ok: e.ok, stage: e.stage, reason: e.reason, elapsedMs: e.elapsedMs, keys: e.keys, source: plan.source, armed: e.armed });
    if (e.stage === "dropped-off-target") {
      // The piece locked somewhere the plan did not choose, so the board is no
      // longer the one the next request was built on. Drop both predictions.
      this.stats.offTarget++;
      this.preplan = null;
      this.armed = null;
      void this.page.arm(null);
    }
    if (e.ok) {
      this.lastPlacementAt = performance.now();
      this.stats.pieces++;
      this.runPieces++;
      // On-target drops landed exactly where the simulation said, so the clear
      // it predicted is the clear that happened.
      const lines = plan.candidate.evaluation.lock.linesCleared;
      if (e.stage === "dropped" && lines >= 1 && lines <= 4) this.stats.clears[lines - 1]++;
      if (plan.source === "jev") {
        this.stats.placedByJev++;
        this.runPlacedByJev++;
      } else {
        this.stats.placedByCode++;
        this.runPlacedByCode++;
      }
      return;
    }
    this.stats.execFailed++;
    this.message = `execution failed (${e.stage}): ${e.reason ?? ""}`;
    this.activePlan = null;
    // The piece is usually still live: place it by code once so the game does not stall.
    if (snap.live && snap.state === "pieceActive" && snap.live.id === plan.pieceId && this.failedFor !== plan.pieceId && this.cfg.fallback) {
      this.failedFor = plan.pieceId;
      const pieces = piecesFromSnapshot(snap);
      if (pieces) {
        const board = boardFromSnapshot(snap);
        const ctx = this.evalContext(snap, board);
        const budget = this.keyBudget();
        // A piece already resting on the stack can only be turned where it is
        // and walked along the surface, so plan from where it actually stands.
        const slide = slidingCandidate(board, pieces.live, snap.live.cells, postureWeights(this.posture), ctx, budget);
        if (slide) {
          this.execute(slide, snap, "code", null);
          return;
        }
        const candidates = planCandidates({ board, pieces, weights: postureWeights(this.posture), count: this.cfg.candidates, context: ctx, liveCells: snap.live.cells, keyBudget: budget, fallMs: snap.fallMs, keyDelayMs: this.cfg.keyDelay });
        if (candidates.length) this.execute(chooseByCode(candidates), snap, "code", null);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Deciding.
  // ---------------------------------------------------------------------

  /**
   * What every placement is judged against: the column being kept open, the
   * level (which sets both the payout and whether gravity leaves any freedom)
   * and the chain state, which the game reports itself.
   */
  private evalContext(snap: PageSnapshot, board: Board | null): EvalContext {
    if (board) this.wellColumn = chooseWellColumn(board, this.wellColumn);
    return { wellColumn: this.wellColumn, level: snap.level + 1, backToBack: snap.backToBack, combo: snap.combo, fallMs: snap.fallMs };
  }

  /**
   * Presses a plan may spend. The lock timer restarts on every move but only
   * fifteen times, at every level, so this is always the limit -- it simply
   * stops binding once there is time to place the piece in the air.
   */
  private keyBudget(): number {
    return MOVE_RESET_LIMIT;
  }

  /**
   * What the page is allowed to spend. Below 20G the piece is still falling
   * and the executor may need a retry, so it is left uncapped; at 20G every
   * press counts against the lock.
   */
  private pageKeyLimit(level: number): number {
    return isTwentyG(level) ? MOVE_RESET_LIMIT : 0;
  }

  /** The candidate a decision selects, with a certain top-out swapped for a survivable option. */
  private resolveChoice(pending: PendingRequest, decision: Decision): { chosen: Candidate; vetoed: boolean } {
    let chosen = pending.candidates.find((c) => c.id === decision.chosen) ?? chooseByCode(pending.candidates);
    const anySurvives = pending.candidates.some((c) => !c.evaluation.lock.toppedOut);
    if (chosen.evaluation.lock.toppedOut && anySurvives) return { chosen: chooseByCode(pending.candidates), vetoed: true };
    return { chosen, vetoed: false };
  }

  /**
   * Leaves the plan in the page so it runs on the spawn frame. From level 20 a
   * piece locks 150 ms after it appears, and a round trip to Node plus a model
   * call does not fit in that, so the decision has to be there already.
   */
  private armPlan(candidate: Candidate, pending: PendingRequest, source: "jev" | "code"): void {
    if (!pending.expectType) return;
    const p = candidate.evaluation.placement;
    const plan: PagePlan = {
      id: ++this.planSeq,
      pieceId: -1,
      expectType: pending.expectType,
      maxKeys: MOVE_RESET_LIMIT,
      expectBoard: pending.boardSig,
      hold: p.viaHold,
      orientation: p.orientation,
      shapeKey: normalizedKey(p.cells),
      targetMinX: p.x,
      targetCells: p.cells.map((c) => `${c.x},${c.y}`).sort().join(";"),
    };
    this.armed = { planId: plan.id, candidate, boardSig: pending.boardSig ?? "", expectType: pending.expectType, source };
    this.opts.log?.({ type: "armed", run: this.run, planId: plan.id, expectType: pending.expectType, chosen: candidate.id });
    void this.page.arm(plan);
  }

  private onNewPiece(snap: PageSnapshot): void {
    if (this.runPieces === 0 && this.stats.pieces === 0 + this.runsPiecesBefore()) this.startLevelIndex = snap.level;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    this.waitingKey = null;
    this.activePlan = null;
    const pieces = piecesFromSnapshot(snap);
    if (!pieces) return;
    const board = boardFromSnapshot(snap);
    const key = stateKey(board, pieces);
    const ctx = this.evalContext(snap, board);

    // A plan armed in the page fires on the spawn frame, before Node hears
    // about it. If the board came out as predicted, adopt it and move on to
    // the next piece; if it did not, cancel it and plan again.
    const armed = this.armed;
    this.armed = null;
    if (armed) {
      // The same test the page makes. The queue beyond the live piece is not
      // part of it: it shaped which option was picked, but it cannot make the
      // placement itself wrong, and demanding it matched threw away a fifth of
      // the armed plans for nothing.
      if (armed.boardSig === boardSignature(board) && armed.expectType === pieces.live) {
        this.preplan = null;
        this.stats.preplanHits++;
        this.activePlan = { planId: armed.planId, pieceId: snap.live!.id, candidate: armed.candidate, source: armed.source, hold: armed.candidate.evaluation.placement.viaHold, holdSwapSeen: false, done: false };
        // The page may already have finished it before this snapshot arrived.
        const early = this.earlyExecs.get(armed.planId);
        if (early && early.type === "exec") {
          this.earlyExecs.delete(armed.planId);
          this.applyExec(early, this.activePlan, snap);
        }
        if (this.cfg.preplan && !armed.candidate.evaluation.lock.toppedOut) this.preplanNext(armed.candidate, snap, null);
        return;
      }
      this.stats.preplanMisses++;
      // Log which of the two tests failed, and by how much: a wrong piece and a
      // wrong board have completely different causes.
      const sig = boardSignature(board);
      let differingCells = 0;
      for (let i = 0; i < sig.length && i < armed.boardSig.length; i++) if (sig[i] !== armed.boardSig[i]) differingCells++;
      this.opts.log?.({
        type: "armed-miss",
        run: this.run,
        pieceId: snap.live!.id,
        level: snap.level + 1,
        expectedType: armed.expectType,
        actualType: pieces.live,
        typeMatched: armed.expectType === pieces.live,
        boardMatched: armed.boardSig === sig,
        differingCells,
      });
      void this.page.arm(null);
    }

    const pre = this.preplan;
    this.preplan = null;
    if (pre && pre.key === key) {
      if (pre.decision) {
        this.stats.preplanHits++;
        this.applyDecision(pre, pre.decision, snap);
        return;
      }
      if (!pre.settled) {
        // Still in flight: wait for it, with a deadline.
        this.stats.preplanHits++;
        this.live = pre;
        this.waitingKey = key;
        this.armDeadline(snap, pre);
        return;
      }
    } else if (pre) {
      this.stats.preplanMisses++;
      this.opts.log?.({ type: "preplan-miss", run: this.run, pieceId: snap.live!.id });
    }
    const candidates = planCandidates({
      board,
      pieces,
      weights: postureWeights(this.posture),
      count: this.cfg.candidates,
      context: ctx,
      liveCells: snap.live!.cells,
      keyBudget: this.keyBudget(),
      fallMs: snap.fallMs,
      keyDelayMs: this.cfg.keyDelay,
    });
    if (candidates.length === 0) {
      // Nothing to play means the piece is never touched: it falls and locks
      // where it spawned, and it will keep happening for every piece after it.
      // Drop it deliberately instead, and say so.
      this.stats.noCandidates++;
      this.message = "no reachable placement was found; dropping the piece where it stands";
      this.opts.log?.({ type: "no-candidates", run: this.run, pieceId: snap.live!.id, level: snap.level + 1, fallMs: snap.fallMs, heights: columnHeights(board) });
      void this.page.press("hard");
      return;
    }
    const request = this.buildRequest(String(snap.live!.id), board, pieces, candidates, snap, ctx);
    const pending: PendingRequest = { key, candidates, request, sentAt: performance.now(), decision: null, settled: false, preplan: false };
    this.live = pending;
    this.waitingKey = key;
    this.armDeadline(snap, pending);
    void this.dispatch(pending);
  }

  private buildRequest(pieceKey: string, board: Board, pieces: PiecesInPlay, candidates: Candidate[], snap: PageSnapshot, ctx: EvalContext): DecisionRequest {
    const secondsLeft = this.deadline === null ? null : Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000));
    return {
      pieceKey,
      situation: describeSituation(board, pieces, { level: snap.level + 1, fallMsPerRow: snap.fallMs }, ctx),
      objective: describeObjective(this.cfg, { level: snap.level + 1, score: snap.score, linesToNextLevel: snap.linesToNext, secondsLeft, backToBack: snap.backToBack }),
      candidates,
      pieces,
      context: ctx,
    };
  }

  /** How long the piece can wait for an answer before the code safety net places it. */
  private armDeadline(snap: PageSnapshot, pending: PendingRequest): void {
    if (!this.cfg.fallback) return;
    const board = boardFromSnapshot(snap);
    const heights = columnHeights(board);
    const minCellY = Math.min(...snap.live!.cells.map((c) => c[1]));
    const freeRows = Math.max(0, minCellY - Math.max(...heights));
    const level = snap.level + 1;
    const already = performance.now() - pending.sentAt;
    let wait: number;
    if (isTwentyG(level)) {
      // The piece is already resting and locks in as little as 150 ms -- but
      // only if it is left alone. Every press restarts the lock timer (fifteen
      // times), so the answer only has to arrive in time for the FIRST key, not
      // for the whole plan. Waiting for the whole plan gave the model 59 ms at
      // level 25 and handed most of the last third of the game to the safety
      // net; this gives it nearly the full lock window.
      wait = Math.max(20, lockMsForLevel(level) - FIRST_KEY_MS - already);
    } else {
      const fallMs = snap.fallMs && snap.fallMs > 0 ? snap.fallMs : 1000;
      const budget = freeRows * fallMs + lockMsForLevel(level);
      wait = Math.max(50, Math.min(this.cfg.timeout + 200, budget * 0.6) - already);
    }
    const pieceId = snap.live!.id;
    this.deadlineTimer = setTimeout(() => {
      if (this.stopped || this.phase !== "play") return;
      const cur = this.latest;
      if (!cur || !cur.live || cur.live.id !== pieceId || this.activePlan) return;
      if (this.fallbackDoneFor === pieceId) return;
      this.fallbackDoneFor = pieceId;
      this.stats.late++;
      this.message = "answer late: code placed the piece";
      this.opts.log?.({ type: "late", run: this.run, pieceId, waitedMs: Math.round(performance.now() - pending.sentAt) });
      const level = cur.level + 1;
      if (isTwentyG(level) && cur.live) {
        // The piece has moved since the candidates were drawn up; re-plan from
        // where it stands rather than aiming at a column it can no longer reach.
        const pieces = piecesFromSnapshot(cur);
        const board = boardFromSnapshot(cur);
        if (pieces) {
          const ctx = this.evalContext(cur, board);
          // Use the full planner, not the one-ply slide. This is the path that
          // places a piece when no answer arrived in time, and a greedy choice
          // here is what puts the first holes in an otherwise clean board.
          const fresh = planCandidates({
            board,
            pieces,
            weights: postureWeights(this.posture),
            count: this.cfg.candidates,
            context: ctx,
            liveCells: cur.live.cells,
            keyBudget: this.keyBudget(),
            fallMs: cur.fallMs,
            keyDelayMs: this.cfg.keyDelay,
          });
          if (fresh.length > 0) {
            this.execute(chooseByCode(fresh), cur, "code", null);
            return;
          }
          const slide = slidingCandidate(board, pieces.live, cur.live.cells, postureWeights(this.posture), ctx, MOVE_RESET_LIMIT);
          if (slide) {
            this.execute(slide, cur, "code", null);
            return;
          }
        }
      }
      this.execute(chooseByCode(pending.candidates), cur, "code", null);
    }, wait);
  }

  private async dispatch(pending: PendingRequest): Promise<void> {
    this.stats.requests++;
    this.requestTimes.push(performance.now());
    if (performance.now() < this.slowUntil) {
      pending.settled = true;
      return;
    }
    const t0 = performance.now();
    let decision: Decision | null = null;
    try {
      decision = await this.opts.brain.decide(pending.request);
      this.stats.answers++;
      this.runJevAnswers++;
      if (decision.usage) this.stats.inputTokens += decision.usage.input_tokens;
    } catch (err) {
      this.stats.errors++;
      const info = describeApiError(err);
      if (info.kind === "rate_limit") {
        this.stats.rateLimited++;
        this.slowUntil = performance.now() + 1000;
      }
      this.message = `${info.kind}: ${info.message}`;
      this.opts.log?.({ type: "error", pieceKey: pending.request.pieceKey, ...info });
      if (info.kind === "auth") {
        this.fatal = err instanceof Error ? err : new Error(info.message);
        this.stop("fatal");
      }
    } finally {
      const rtt = performance.now() - t0;
      this.rtts.push(rtt);
      if (this.rtts.length > 30) this.rtts.shift();
      pending.settled = true;
      pending.decision = decision;
    }
    if (!decision || this.stopped || this.phase !== "play") return;
    if (pending.preplan) {
      // Already spawned and waiting for exactly this answer?
      if (this.waitingKey === pending.key && this.latest && this.latest.live && !this.activePlan) {
        this.applyDecision(pending, decision, this.latest);
        return;
      }
      // Not spawned yet. Leave the plan in the page so it runs on the spawn
      // frame instead of a round trip later: by level 14 a piece is resting
      // 55 ms after it appears, and from level 20 it locks 150 ms after that.
      // (`activePlan` is deliberately not checked here -- the previous piece is
      // still being placed, which is the whole point of pre-planning, and
      // testing it meant this never fired at all.)
      if (this.preplan === pending && this.waitingKey !== pending.key && this.latest) {
        const { chosen } = this.resolveChoice(pending, decision);
        if (decision.posture && decision.posture.confidence >= this.opts.postureConfidenceFloor) this.posture = decision.posture.choice;
        this.lastDecision = decision;
        this.lastChoice = decision.chosen;
        this.armPlan(chosen, pending, "jev");
      }
      return;
    }
    if (this.live !== pending) {
      this.stats.stale++;
      this.opts.log?.({ type: "decision", result: "stale", reason: "a newer piece is live", pieceKey: pending.request.pieceKey, chosen: decision.chosen });
      return;
    }
    const snap = this.latest;
    if (!snap || !snap.live || String(snap.live.id) !== pending.request.pieceKey || this.activePlan) {
      this.stats.stale++;
      this.opts.log?.({ type: "decision", result: "stale", reason: this.activePlan ? "piece already placed" : "piece changed", pieceKey: pending.request.pieceKey, chosen: decision.chosen });
      return;
    }
    this.applyDecision(pending, decision, snap);
  }

  private applyDecision(pending: PendingRequest, decision: Decision, snap: PageSnapshot): void {
    if (this.stopped || this.phase !== "play" || !snap.live) return;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    this.waitingKey = null;
    this.live = null;
    this.lastDecision = decision;
    const { chosen, vetoed } = this.resolveChoice(pending, decision);
    if (vetoed) this.stats.vetoed++;
    if (decision.posture && decision.posture.confidence >= this.opts.postureConfidenceFloor) this.posture = decision.posture.choice;
    this.stats.applied++;
    this.lastChoice = decision.chosen;
    this.opts.log?.({
      type: "decision",
      result: "applied",
      run: this.run,
      pieceId: snap.live.id,
      preplanned: pending.preplan,
      rttMs: Math.round(decision.latencyMs),
      chosen: decision.chosen,
      executed: chosen.id,
      vetoed,
      confidence: decision.confidence,
      probabilities: decision.probabilities,
      posture: decision.posture,
      situation: pending.request.situation,
      candidates: pending.candidates.map((c) => ({ id: c.id, type: c.evaluation.placement.type, viaHold: c.evaluation.placement.viaHold, o: c.evaluation.placement.orientation, x: c.evaluation.placement.x, y: c.evaluation.placement.y, lines: c.evaluation.lock.linesCleared, newHoles: c.evaluation.newHoles, maxHeight: c.evaluation.after.maxHeight, score: Math.round(c.evaluation.score * 10) / 10, total: Math.round(c.total * 10) / 10, tags: c.tags })),
    });
    this.execute(chosen, snap, "jev", pending);
  }

  private execute(candidate: Candidate, snap: PageSnapshot, source: "jev" | "code", pending: PendingRequest | null): void {
    const p = candidate.evaluation.placement;
    const plan: PagePlan = {
      id: ++this.planSeq,
      pieceId: snap.live!.id,
      maxKeys: this.pageKeyLimit(snap.level + 1),
      hold: p.viaHold,
      orientation: p.orientation,
      shapeKey: normalizedKey(p.cells),
      targetMinX: p.x,
      targetCells: p.cells.map((c) => `${c.x},${c.y}`).sort().join(";"),
    };
    this.activePlan = { planId: plan.id, pieceId: plan.pieceId, candidate, source, hold: p.viaHold, holdSwapSeen: false, done: false };
    void this.page.execute(plan);
    if (this.cfg.preplan && !candidate.evaluation.lock.toppedOut) this.preplanNext(candidate, snap, pending);
  }

  /** Ask about the next piece now, on the board as it will be after this placement. */
  private preplanNext(candidate: Candidate, snap: PageSnapshot, pending: PendingRequest | null): void {
    const pieces = piecesFromSnapshot(snap);
    if (!pieces) return;
    const after = piecesAfter(pieces, candidate.evaluation.placement.viaHold);
    if (!after.next) return;
    const nextPieces: PiecesInPlay = { live: after.next, hold: after.hold, canHold: true, queue: after.queue };
    const board = candidate.evaluation.lock.board;
    const cleared = candidate.evaluation.lock.linesCleared;
    // The level, the chain and the combo all move with the placement being
    // executed, so the next piece has to be judged on the state it will land in.
    const linesToNext = ((snap.linesToNext - cleared) % LINES_PER_LEVEL + LINES_PER_LEVEL) % LINES_PER_LEVEL || LINES_PER_LEVEL;
    const leveledUp = cleared >= snap.linesToNext;
    const nextLevel = leveledUp ? Math.min(MAX_LEVEL - 1, snap.level + 1) : snap.level;
    const predicted: PageSnapshot = {
      ...snap,
      linesToNext,
      level: nextLevel,
      // A level up speeds gravity, which changes what the next piece can reach.
      fallMs: fallMsForLevel(nextLevel + 1),
      score: snap.score + candidate.evaluation.points,
      backToBack: cleared === 0 ? snap.backToBack : cleared === 4,
      combo: cleared > 0 ? snap.combo + 1 : 0,
    };
    const ctx = this.evalContext(predicted, null);
    const candidates = planCandidates({
      board,
      pieces: nextPieces,
      weights: postureWeights(this.posture),
      count: this.cfg.candidates,
      context: ctx,
      keyBudget: this.keyBudget(),
      fallMs: predicted.fallMs,
      keyDelayMs: this.cfg.keyDelay,
    });
    if (candidates.length === 0) return;
    const key = stateKey(board, nextPieces);
    const request = this.buildRequest(`pre:${key.slice(-40)}`, board, nextPieces, candidates, predicted, ctx);
    void pending;
    const pre: PendingRequest = { key, candidates, request, sentAt: performance.now(), decision: null, settled: false, preplan: true, expectType: after.next, boardSig: boardSignature(board) };
    this.preplan = pre;
    void this.dispatch(pre);
  }
}
