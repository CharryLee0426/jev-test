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
import {
  DEFAULT_WEIGHTS,
  HEIGHT,
  PIECE_TYPES,
  WIDTH,
  columnHeights,
  computeFeatures,
  dropY,
  emptyBoard,
  evaluatePlacement,
  fits,
  normalizedKey,
  shapeCells,
  shapeHeight,
  shapeWidth,
  type Board,
  type Evaluation,
  type PieceType,
  type Placement,
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
  endedBy: "topout" | "stop";
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
}

interface ActivePlan {
  planId: number;
  pieceId: number;
  candidate: Candidate;
  source: "jev" | "code";
  /** The plan starts with a hold, which swaps the live piece for another one mid-plan. */
  hold: boolean;
  done: boolean;
}

const LINES_PER_LEVEL = 10;

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

/** Identifies a decision situation: the board plus the pieces the candidates depend on. */
export function stateKey(board: Board, pieces: PiecesInPlay): string {
  let b = "";
  for (let i = 0; i < board.length; i++) b += board[i] ? "#" : ".";
  return `${b}|${pieces.live}|${pieces.hold ?? "-"}|${pieces.canHold ? 1 : 0}|${pieces.queue[0] ?? "-"}`;
}

/** Lines cleared in this game: levels gained since the start plus the progress inside the current level. */
/**
 * When the live piece is already resting on the stack, the placements it can still reach are the
 * ones in its current orientation that it can slide to at its current height. Returns the best of
 * them as a candidate, or null when the piece is still falling freely (the normal planner applies).
 */
export function slidingCandidate(board: Board, type: PieceType, liveCells: number[][], weights = DEFAULT_WEIGHTS): Candidate | null {
  const cells = liveCells.map(([x, y]) => ({ x, y }));
  const minX = Math.min(...cells.map((c) => c.x));
  const minY = Math.min(...cells.map((c) => c.y));
  const heights = columnHeights(board);
  if (minY > Math.max(...heights) + 1) return null;
  const key = normalizedKey(cells);
  let orientation = -1;
  for (let o = 0; o < 4; o++) if (normalizedKey(shapeCells(type, o)) === key) { orientation = o; break; }
  if (orientation < 0) return null;
  const rel = cells.map((c) => ({ x: c.x - minX, y: c.y - minY }));
  const before = computeFeatures(board);
  const options: Evaluation[] = [];
  for (const dir of [-1, 1]) {
    for (let x = minX; x >= 0 && x + shapeWidth(type, orientation) <= WIDTH; x += dir) {
      if (x !== minX && !fits(board, rel, x, minY)) break;
      const landing = dropY(board, type, orientation, x, minY + shapeHeight(type, orientation) - 1);
      if (landing === null) break;
      const placement: Placement = { type, orientation, x, y: landing, cells: shapeCells(type, orientation).map((c) => ({ x: x + c.x, y: landing + c.y })), viaHold: false };
      options.push(evaluatePlacement(board, before, placement, weights));
      if (dir === -1 && x === minX) continue;
    }
  }
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
    placedByJev: 0, placedByCode: 0, execFailed: 0, inputTokens: 0, pieces: 0,
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
    if (this.stopped || this.phase === "play") return;
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
    const summary: RunSummary = {
      run: this.run,
      score: s.score,
      level: s.level + 1,
      lines: totalLines(s.level, s.linesToNext, this.startLevelIndex),
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
    this.latest = snap;
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
      if (plan && plan.hold && !plan.done && plan.pieceId === this.lastLiveId) {
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
    if (!plan || plan.planId !== e.planId) return;
    plan.done = true;
    this.opts.log?.({ type: "exec", run: this.run, planId: e.planId, pieceId: plan.pieceId, ok: e.ok, stage: e.stage, reason: e.reason, elapsedMs: e.elapsedMs, keys: e.keys, source: plan.source });
    if (e.ok) {
      this.stats.pieces++;
      this.runPieces++;
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
        // A piece already resting on the stack (fast levels) can only slide along the surface in its current orientation.
        const slide = slidingCandidate(board, pieces.live, snap.live.cells, postureWeights(this.posture));
        if (slide) {
          this.execute(slide, snap, "code", null);
          return;
        }
        const candidates = planCandidates({ board, pieces, weights: postureWeights(this.posture), count: this.cfg.candidates });
        if (candidates.length) this.execute(chooseByCode(candidates), snap, "code", null);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Deciding.
  // ---------------------------------------------------------------------

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
    const candidates = planCandidates({ board, pieces, weights: postureWeights(this.posture), count: this.cfg.candidates });
    if (candidates.length === 0) return;
    const request = this.buildRequest(String(snap.live!.id), board, pieces, candidates, snap);
    const pending: PendingRequest = { key, candidates, request, sentAt: performance.now(), decision: null, settled: false, preplan: false };
    this.live = pending;
    this.waitingKey = key;
    this.armDeadline(snap, pending);
    void this.dispatch(pending);
  }

  private buildRequest(pieceKey: string, board: Board, pieces: PiecesInPlay, candidates: Candidate[], snap: PageSnapshot): DecisionRequest {
    const secondsLeft = this.deadline === null ? null : Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000));
    return {
      pieceKey,
      situation: describeSituation(board, pieces, { level: snap.level + 1, fallMsPerRow: snap.fallMs }),
      objective: describeObjective(this.cfg, { level: snap.level + 1, score: snap.score, linesToNextLevel: snap.linesToNext, secondsLeft }),
      candidates,
      pieces,
    };
  }

  /** How long the piece can wait for an answer before the code safety net places it. */
  private armDeadline(snap: PageSnapshot, pending: PendingRequest): void {
    if (!this.cfg.fallback) return;
    const board = boardFromSnapshot(snap);
    const heights = columnHeights(board);
    const minCellY = Math.min(...snap.live!.cells.map((c) => c[1]));
    const freeRows = Math.max(0, minCellY - Math.max(...heights));
    const fallMs = snap.fallMs && snap.fallMs > 0 ? snap.fallMs : 1000;
    const budget = freeRows * fallMs + 300;
    const already = performance.now() - pending.sentAt;
    const wait = Math.max(50, Math.min(this.cfg.timeout + 200, budget * 0.6) - already);
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
      if (this.waitingKey === pending.key && this.latest && this.latest.live && !this.activePlan) this.applyDecision(pending, decision, this.latest);
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
    let chosen = pending.candidates.find((c) => c.id === decision.chosen) ?? chooseByCode(pending.candidates);
    const anySurvives = pending.candidates.some((c) => !c.evaluation.lock.toppedOut);
    let vetoed = false;
    if (chosen.evaluation.lock.toppedOut && anySurvives) {
      chosen = chooseByCode(pending.candidates);
      this.stats.vetoed++;
      vetoed = true;
    }
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
      hold: p.viaHold,
      orientation: p.orientation,
      shapeKey: normalizedKey(p.cells),
      targetMinX: p.x,
      targetCells: p.cells.map((c) => `${c.x},${c.y}`).sort().join(";"),
    };
    this.activePlan = { planId: plan.id, pieceId: plan.pieceId, candidate, source, hold: p.viaHold, done: false };
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
    const candidates = planCandidates({ board, pieces: nextPieces, weights: postureWeights(this.posture), count: this.cfg.candidates });
    if (candidates.length === 0) return;
    const key = stateKey(board, nextPieces);
    const linesToNext = ((snap.linesToNext - candidate.evaluation.lock.linesCleared) % LINES_PER_LEVEL + LINES_PER_LEVEL) % LINES_PER_LEVEL || LINES_PER_LEVEL;
    const predicted: PageSnapshot = { ...snap, linesToNext, score: snap.score + 2 * (snap.live!.y - candidate.evaluation.placement.y) };
    const request = this.buildRequest(`pre:${key.slice(-40)}`, board, nextPieces, candidates, predicted);
    void pending;
    const pre: PendingRequest = { key, candidates, request, sentAt: performance.now(), decision: null, settled: false, preplan: true };
    this.preplan = pre;
    void this.dispatch(pre);
  }
}
