/**
 * The script injected into the game frame of play.tetris.com. It runs inside
 * the page and is the agent's hands and eyes:
 *
 *  - eyes: every animation frame it reads the game engine (the `mBPSApp`
 *    object the game publishes on its window) and pushes a compact snapshot to
 *    Node through `__tetrisPush` whenever something changed, plus a heartbeat;
 *  - hands: executes a placement plan with synthetic key events on the game
 *    canvas (the same keys a player presses), verifying the piece's shape and
 *    column after every key and the game's own ghost piece before the drop.
 *
 * The page sees no API key and makes no network calls of its own.
 */

export interface PageConstants {
  /** Heartbeat: push a snapshot at least this often while a game is running. */
  pushIntervalMs: number;
  /** Delay between key presses while executing a plan; 0 = one animation frame. */
  keyDelayMs: number;
}

export interface PagePiece {
  id: number;
  type: string;
  x: number;
  y: number;
  facing: number;
  cells: number[][];
}

export type PageEvent =
  | { type: "exec"; planId: number; ok: boolean; stage: string; reason?: string; elapsedMs: number; keys: number; pieceId?: number; armed?: boolean }
  | { type: "start"; ok: boolean; reason?: string };

export interface PageSnapshot {
  t: number;
  scene: string;
  /** Player state name (readyToStart, pieceActive, gameEnded, ...) while a game exists. */
  state: string | null;
  adActive: boolean;
  live: PagePiece | null;
  ghostCells: number[][] | null;
  hold: string | null;
  canHold: boolean;
  queue: string[];
  score: number;
  /** True while a back-to-back chain is alive, so the next tetris scores 1.5x. The engine's own flag. */
  backToBack: boolean;
  /** Clears chained so far, for the combo bonus. The engine's own counter. */
  combo: number;
  /** 0-based level index; the game shows index + 1. */
  level: number;
  linesToNext: number;
  elapsedMs: number;
  ended: boolean;
  active: boolean;
  /** Milliseconds per row of gravity right now, when the engine exposes it. */
  fallMs: number | null;
  /** WIDTH*HEIGHT chars from the bottom row up, '.' empty or '#' filled. Locked minos only. */
  board: string;
  width: number;
  height: number;
  events: PageEvent[];
}

export interface PagePlan {
  id: number;
  /** The live piece the plan is for; refused if another piece is live. -1 arms the plan for the next piece of `expectType`. */
  pieceId: number;
  /** For an armed plan: the piece type it was computed for. The plan runs the frame a piece of this type becomes live. */
  expectType?: string;
  /** Presses the plan may spend before the piece locks itself; 0 or absent means no limit. */
  maxKeys?: number;
  /**
   * For an armed plan: the matrix it was computed for, in the same form as
   * `PageSnapshot.board`. The plan only fires if the board really came out
   * that way, so a placement that went off target can never be followed by a
   * plan built on a board that never happened.
   */
  expectBoard?: string;
  hold: boolean;
  /** Orientation of the target shape (0..3 clockwise turns from spawn). */
  orientation: number;
  /** normalizedKey of the target shape. */
  shapeKey: string;
  targetMinX: number;
  /** Absolute target cells as "x,y;x,y;..." sorted, compared with the game's ghost piece before dropping. */
  targetCells: string;
}

/** Installed on `window.__tetrisAgent` inside the game frame. */
export interface PageAgentApi {
  snapshot(): PageSnapshot;
  execute(plan: PagePlan): void;
  press(key: "left" | "right" | "cw" | "ccw" | "soft" | "hard" | "hold"): void;
  startGame(levelIndex: number): { ok: boolean; reason?: string; scene: string };
  /**
   * Holds a plan for a piece that has not spawned yet and runs it the frame one
   * of `expectType` becomes live. From level 20 a piece locks 150 ms after it
   * appears, which is less than a round trip to Node, so the plan has to be
   * waiting in the page before the spawn rather than sent after it.
   */
  arm(plan: PagePlan | null): void;
  sceneName(): string;
  /** Tells the page its game-area ad is over. Only the ad-timeout fallback uses it. */
  adFallbackComplete(): boolean;
}

declare global {
  interface Window {
    mBPSApp?: any;
    __tetrisAgent?: PageAgentApi;
    __tetrisPush?: (snapshot: PageSnapshot) => void;
    isGameAreaAdActive?: () => boolean;
    onGameAreaAdComplete?: () => void;
    /** The game's own "show the ad before the next game" entry point ('preroll' on first load, 'next' afterwards). */
    showGameAreaAd?: (type?: string) => void;
  }
}

/**
 * Runs in the browser. Keep it self-contained: Playwright serializes this
 * function's source, so it must not reference module scope.
 */
export function installPageAgent(constants: PageConstants): { ok: boolean; reason?: string } {
  const app = window.mBPSApp;
  if (!app || typeof app.getSceneMgr !== "function") return { ok: false, reason: "mBPSApp is not available" };
  if (window.__tetrisAgent) return { ok: true, reason: "already installed" };

  const KEYS: Record<string, [number, string]> = {
    left: [37, "ArrowLeft"],
    right: [39, "ArrowRight"],
    cw: [38, "ArrowUp"],
    ccw: [90, "KeyZ"],
    soft: [40, "ArrowDown"],
    hard: [32, "Space"],
    hold: [67, "KeyC"],
  };
  const isHashed = (n: string): boolean => /^x\d+x$/.test(n);
  const sm = app.getSceneMgr();
  const sceneName = (): string => {
    try {
      const s = sm.getCurrentScene();
      return s ? String(s.getSceneName()) : "none";
    } catch {
      return "none";
    }
  };
  const currentPlayer = (): any => {
    try {
      const s = sm.getCurrentScene();
      if (!s || typeof s.getGameMgr !== "function") return null;
      const gm = s.getGameMgr();
      const game = gm && gm.getGame ? gm.getGame() : null;
      return game ? game.getPlayerAtIndex(0) : null;
    } catch {
      return null;
    }
  };
  /** The game scene's player also exists while the pause/game-over scenes sit on top of it. */
  const anyPlayer = (): any => {
    const p = currentPlayer();
    if (p) return p;
    try {
      const s = sm.getManagedScene("game");
      const gm = s && s.getGameMgr ? s.getGameMgr() : null;
      const game = gm && gm.getGame ? gm.getGame() : null;
      return game ? game.getPlayerAtIndex(0) : null;
    } catch {
      return null;
    }
  };
  const components = (pl: any): { score: any; levels: any; control: any } => {
    const out: { score: any; levels: any; control: any } = { score: null, levels: null, control: null };
    const n = pl.getNumComponents();
    for (let i = 0; i < n; i++) {
      const c = pl.getComponentAtIndex(i);
      if (typeof c.getScore === "function") out.score = c;
      else if (typeof c.getCurrentLevelIndex === "function") out.levels = c;
      else if (typeof c.getInputMgr === "function") out.control = c;
    }
    return out;
  };
  /** The piece controller (fall speed, hold permission) sits behind hashed fields; find it once per player. */
  let controllerFor: { player: any; controller: any } | null = null;
  const controller = (pl: any): any => {
    if (controllerFor && controllerFor.player === pl) return controllerFor.controller;
    let found: any = null;
    try {
      const comps = components(pl);
      const seen = new Set<any>();
      const queue: [any, number][] = [[comps.control, 0]];
      while (queue.length && !found) {
        const [o, d] = queue.shift()!;
        if (!o || typeof o !== "object" || seen.has(o)) continue;
        seen.add(o);
        if (typeof o.getCurrentFallSpeedMSEC === "function" && typeof o.canHoldLivePiece === "function") {
          found = o;
          break;
        }
        if (d >= 6) continue;
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (v && typeof v === "object" && !(v instanceof Node)) {
            if (Array.isArray(v)) for (const e of v) queue.push([e, d + 1]);
            else queue.push([v, d + 1]);
          }
        }
      }
    } catch {
      found = null;
    }
    controllerFor = { player: pl, controller: found };
    return found;
  };
  const cellsOf = (piece: any): number[][] | null => {
    if (!piece) return null;
    const out: number[][] = [];
    const n = piece.getNumMinos();
    for (let i = 0; i < n; i++) {
      const m = piece.getMinoAtIndex(i);
      out.push([m.getX(), m.getY()]);
    }
    return out;
  };
  const normalizedKey = (cells: number[][]): string => {
    const minX = Math.min(...cells.map((c) => c[0]));
    const minY = Math.min(...cells.map((c) => c[1]));
    return cells.map((c) => `${c[0] - minX},${c[1] - minY}`).sort().join(";");
  };
  const cellKey = (cells: number[][]): string => cells.map((c) => `${c[0]},${c[1]}`).sort().join(";");
  const stateName = (pl: any): string | null => {
    try {
      return String(pl.constructor.getStateName(pl.getCurrentState()));
    } catch {
      return null;
    }
  };

  let events: PageEvent[] = [];
  let holdUsedFor: number | null = null;

  const snapshot = (): PageSnapshot => {
    const scene = sceneName();
    const pl = anyPlayer();
    const base: PageSnapshot = {
      t: performance.now(),
      scene,
      state: null,
      adActive: typeof window.isGameAreaAdActive === "function" ? Boolean(window.isGameAreaAdActive()) : false,
      live: null,
      ghostCells: null,
      hold: null,
      canHold: false,
      queue: [],
      score: 0,
      backToBack: false,
      combo: 0,
      level: 0,
      linesToNext: 0,
      elapsedMs: 0,
      ended: false,
      active: false,
      fallMs: null,
      board: "",
      width: 10,
      height: 24,
      events,
    };
    events = [];
    if (!pl) return base;
    try {
      const comps = components(pl);
      const live = pl.getLivePiece();
      const ghost = pl.getGhostPiece();
      const q = pl.getPieceQueue();
      const queue: string[] = [];
      for (let i = 0; i < q.getNumPieces(); i++) queue.push(String(q.getPieceAtIndex(i).getPieceTypeName()));
      const w = pl.getMatrixWidth();
      const h = pl.getMatrixHeight();
      const m = pl.getMatrix();
      let board = "";
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) board += m.getMinoAt(x, y) ? "#" : ".";
      const ctrl = controller(pl);
      const liveId = live ? Number(live.getRandomizedObjectId()) : null;
      base.state = stateName(pl);
      base.live = live ? { id: liveId!, type: String(live.getPieceTypeName()), x: live.getX(), y: live.getY(), facing: live.getFacing(), cells: cellsOf(live)! } : null;
      base.ghostCells = cellsOf(ghost);
      base.hold = pl.getHoldPiece() ? String(pl.getHoldPiece().getPieceTypeName()) : null;
      base.canHold = ctrl ? Boolean(ctrl.canHoldLivePiece()) : liveId !== null && holdUsedFor !== liveId;
      base.queue = queue;
      base.score = comps.score ? Number(comps.score.getScore()) : 0;
      // The score component keeps both of these itself, so they never have to be inferred.
      base.backToBack = comps.score ? Boolean(comps.score.mIsBackToBackChainActive) : false;
      base.combo = comps.score ? Math.max(0, Number(comps.score.mCurrentComboCount) || 0) : 0;
      base.level = comps.levels ? Number(comps.levels.getCurrentLevelIndex()) : 0;
      base.linesToNext = comps.levels ? Number(comps.levels.getLevelRemainingActionGoal()) : 0;
      base.elapsedMs = Math.round(pl.getElapsedActiveGameTimeMSEC());
      base.ended = Boolean(pl.isGameEnded());
      base.active = Boolean(pl.isGameActive());
      base.fallMs = ctrl ? Number(ctrl.getCurrentFallSpeedMSEC()) : null;
      base.board = board;
      base.width = w;
      base.height = h;
    } catch {
      /* a scene transition mid-read: the next frame retries */
    }
    return base;
  };

  const pushEvent = (e: PageEvent): void => {
    events.push(e);
    push(true);
  };
  let lastPushAt = 0;
  let lastSig = "";
  const push = (force: boolean): void => {
    if (typeof window.__tetrisPush !== "function") return;
    const s = snapshot();
    const sig = [s.scene, s.state, s.live ? `${s.live.id}:${s.live.x}:${s.live.y}:${s.live.facing}` : "-", s.hold, s.score, s.level, s.ended, s.adActive].join("|");
    const now = performance.now();
    if (!force && sig === lastSig && s.events.length === 0 && now - lastPushAt < constants.pushIntervalMs) {
      // Nothing changed and the heartbeat is not due: put the events back (there are none) and skip.
      return;
    }
    lastSig = sig;
    lastPushAt = now;
    try {
      window.__tetrisPush(s);
    } catch {
      /* Node side gone; ignore */
    }
  };
  const loop = (): void => {
    tryArmed();
    push(false);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  const canvas = (): HTMLElement => (document.getElementById("GameCanvas") as HTMLElement) ?? document.body;
  const press = (key: keyof typeof KEYS): void => {
    const [keyCode, code] = KEYS[key];
    const target = canvas();
    target.dispatchEvent(new KeyboardEvent("keydown", { keyCode, code, key: code, bubbles: true } as KeyboardEventInit));
    target.dispatchEvent(new KeyboardEvent("keyup", { keyCode, code, key: code, bubbles: true } as KeyboardEventInit));
  };
  const wait = (): Promise<void> =>
    new Promise((resolve) => {
      if (constants.keyDelayMs <= 0) requestAnimationFrame(() => resolve());
      else setTimeout(resolve, constants.keyDelayMs);
    });
  const until = async (cond: () => boolean, timeoutMs: number): Promise<boolean> => {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      if (cond()) return true;
      await wait();
    }
    return cond();
  };

  const execute = async (plan: PagePlan, armedFire = false): Promise<void> => {
    const started = performance.now();
    let keys = 0;
    const done = (ok: boolean, stage: string, reason?: string): void => {
      pushEvent({ type: "exec", planId: plan.id, ok, stage, reason, elapsedMs: Math.round(performance.now() - started), keys, pieceId: plan.pieceId, armed: armedFire });
    };
    const pl = anyPlayer();
    if (!pl) return done(false, "start", "no player");
    // From level 20 gravity is instant and the piece locks itself after a
    // handful of presses, so the plan is allowed a fixed budget and has to
    // spend it on the drop rather than on another verification round.
    const budget = plan.maxKeys && plan.maxKeys > 0 ? plan.maxKeys : Infinity;
    const outOfKeys = (): boolean => keys >= budget;
    const instantGravity = (): boolean => {
      const c = controller(pl);
      return Boolean(c) && Number(c.getCurrentFallSpeedMSEC()) <= 0;
    };
    const liveNow = (): any => {
      try {
        return pl.getLivePiece();
      } catch {
        return null;
      }
    };
    let live = liveNow();
    if (!live || Number(live.getRandomizedObjectId()) !== plan.pieceId) return done(false, "start", "piece changed before execution");
    let currentId = plan.pieceId;
    if (plan.hold) {
      const typeBefore = String(live.getPieceTypeName());
      press("hold");
      keys++;
      const swapped = await until(() => {
        const l = liveNow();
        return Boolean(l) && (Number(l.getRandomizedObjectId()) !== plan.pieceId || String(l.getPieceTypeName()) !== typeBefore);
      }, 400);
      if (!swapped) return done(false, "hold", "hold did not swap the piece");
      holdUsedFor = plan.pieceId;
      live = liveNow();
      currentId = Number(live.getRandomizedObjectId());
      holdUsedFor = currentId;
    }
    const shapeKey = (): string => {
      const l = liveNow();
      return l ? normalizedKey(cellsOf(l)!) : "";
    };
    const stillLive = (): boolean => {
      const l = liveNow();
      return Boolean(l) && Number(l.getRandomizedObjectId()) === currentId;
    };
    if (shapeKey() !== plan.shapeKey) {
      const turns: ("cw" | "ccw")[] = plan.orientation === 3 ? ["ccw"] : plan.orientation === 2 ? ["cw", "cw"] : ["cw"];
      for (const t of turns) {
        if (outOfKeys()) break;
        press(t);
        keys++;
        await wait();
      }
      for (let extra = 0; shapeKey() !== plan.shapeKey && extra < 3 && !outOfKeys(); extra++) {
        press("cw");
        keys++;
        await wait();
      }
      if (!stillLive()) return done(false, "rotate", "piece locked while rotating");
      if (shapeKey() !== plan.shapeKey) return done(false, "rotate", "shape never matched the target orientation");
    }
    const minX = (): number => {
      const l = liveNow();
      return l ? Math.min(...cellsOf(l)!.map((c) => c[0])) : -1;
    };
    for (let guard = 0; guard < 12 && !outOfKeys(); guard++) {
      if (!stillLive()) return done(false, "move", "piece locked while moving");
      const at = minX();
      const dx = plan.targetMinX - at;
      if (dx === 0) break;
      press(dx < 0 ? "left" : "right");
      keys++;
      await wait();
      if (minX() === at) {
        // A step that did not land is a wall. Under instant gravity that is the
        // walk model being a column out; stop rather than spend the budget.
        if (instantGravity()) break;
        await wait();
        if (minX() === at) return done(false, "move", `blocked at column ${at + 1} (wanted column ${plan.targetMinX + 1})`);
      }
    }
    if (!stillLive()) return done(false, "verify", "piece locked before the drop");
    const ghost = pl.getGhostPiece();
    const ghostCells = cellsOf(ghost);
    const gk = ghostCells ? cellKey(ghostCells) : "";
    if (gk !== plan.targetCells) {
      // Under instant gravity the piece is already resting: not dropping only
      // means it locks in the same cells a moment later. Drop it so the game
      // keeps moving, and say so, because Node's board prediction is now void.
      if (instantGravity()) {
        press("hard");
        keys++;
        return done(true, "dropped-off-target", `ghost ${gk} does not match the target ${plan.targetCells}`);
      }
      return done(false, "verify", `ghost ${gk} does not match the target ${plan.targetCells}`);
    }
    press("hard");
    keys++;
    done(true, "dropped");
  };

  // A plan can be left waiting for a piece that has not spawned yet; the frame
  // loop fires it the moment one of the expected type becomes live.
  let armed: PagePlan | null = null;
  let armedFiredFor: number | null = null;
  const tryArmed = (): void => {
    if (!armed) return;
    const pl = anyPlayer();
    if (!pl) return;
    let live: any = null;
    try {
      live = pl.getLivePiece();
    } catch {
      return;
    }
    if (!live) return;
    const id = Number(live.getRandomizedObjectId());
    if (id === armedFiredFor) return;
    if (armed.expectType && String(live.getPieceTypeName()) !== armed.expectType) return;
    if (armed.expectBoard) {
      let board = "";
      try {
        const w = pl.getMatrixWidth();
        const h = pl.getMatrixHeight();
        const m = pl.getMatrix();
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) board += m.getMinoAt(x, y) ? "#" : ".";
      } catch {
        return;
      }
      if (board !== armed.expectBoard) {
        // The board is not the one the plan was built on: throw the plan away
        // rather than place a piece by a prediction that did not come true.
        // Say so, because Node may already be treating this plan as the one in
        // flight, and a plan that never reports back stops it placing pieces.
        const discarded = armed;
        armed = null;
        pushEvent({ type: "exec", planId: discarded.id, ok: false, stage: "armed-discarded", reason: "the board was not the one the plan was built on", elapsedMs: 0, keys: 0, pieceId: id, armed: true });
        return;
      }
    }
    const plan = { ...armed, pieceId: id };
    armed = null;
    armedFiredFor = id;
    void execute(plan, true);
  };

  const api: PageAgentApi = {
    snapshot,
    execute(plan) {
      armed = null;
      void execute(plan);
    },
    arm(plan) {
      armed = plan;
    },
    press,
    startGame(levelIndex) {
      const scene = sceneName();
      try {
        const s = sm.getCurrentScene();
        if (scene === "mainMenu") {
          if (typeof s.setStartingLevelIndex === "function") s.setStartingLevelIndex(levelIndex);
          s.performPlay(false);
          return { ok: true, scene };
        }
        if (scene === "gameOver" && typeof s.performPlay === "function") {
          s.performPlay(false);
          return { ok: true, scene };
        }
        if (scene === "newHighScore") {
          // A qualifying score shows a name-entry screen first; its own Done action keeps the default initials and leaves.
          if (typeof s.performDone === "function") s.performDone();
          else if (typeof s.performSaveAndExit === "function") s.performSaveAndExit();
          else return { ok: false, reason: "high-score screen without a done action", scene };
          return { ok: false, reason: "left the high-score screen; start again", scene };
        }
        if (typeof s.performPlay === "function") {
          s.performPlay(false);
          return { ok: true, scene };
        }
        return { ok: false, reason: `cannot start from scene ${scene}`, scene };
      } catch (err) {
        return { ok: false, reason: (err as Error).message, scene };
      }
    },
    sceneName,
    adFallbackComplete() {
      if (typeof window.onGameAreaAdComplete !== "function") return false;
      window.onGameAreaAdComplete();
      return true;
    },
  };
  window.__tetrisAgent = api;
  push(true);
  return { ok: true };
}
