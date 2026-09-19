/**
 * Browser layer: opens play.tetris.com in Chrome through Playwright, finds the
 * game's iframe and wires the in-page agent to Node. Two ways to get a browser:
 *  - launch the installed Google Chrome (default, separate profile);
 *  - attach to a Chrome you already run with --remote-debugging-port.
 *
 * Ad blocking (see ad-block.ts) is installed on the page before the first
 * navigation, because the shims have to be in place before the site's own
 * scripts run.
 */
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright-core";
import { AdBlocker } from "./ad-block.ts";
import { installPageAgent, type PageConstants, type PagePlan, type PageSnapshot } from "./page-agent.ts";

export interface BrowserOptions {
  url: string;
  cdpUrl?: string;
  channel: string;
  headless: boolean;
  width: number;
  height: number;
  /** Block ad traffic and answer the site's ad callbacks in code. */
  blockAds: boolean;
  log?: (event: Record<string, unknown>) => void;
}

export interface GameSession {
  browser: Browser;
  page: Page;
  attached: boolean;
  /** Null when ad blocking is turned off. */
  adBlock: AdBlocker | null;
  close(): Promise<void>;
}

export const GAME_FRAME_PATH = "/tetris-game-package/game/";

export async function openGame(opts: BrowserOptions): Promise<GameSession> {
  let browser: Browser;
  let context: BrowserContext;
  const attached = Boolean(opts.cdpUrl);
  if (opts.cdpUrl) {
    browser = await chromium.connectOverCDP(opts.cdpUrl);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else {
    browser = await chromium.launch({
      channel: opts.channel,
      headless: opts.headless,
      args: [`--window-size=${opts.width},${opts.height + 90}`, "--autoplay-policy=no-user-gesture-required"],
    });
    context = await browser.newContext({ viewport: { width: opts.width, height: opts.height } });
  }
  const page = await context.newPage();
  const adBlock = opts.blockAds ? await AdBlocker.install(page, { log: opts.log }) : null;
  await page.goto(opts.url, { waitUntil: "domcontentloaded" });
  return {
    browser,
    page,
    attached,
    adBlock,
    async close() {
      if (attached) {
        await page.close().catch(() => {});
        await browser.close().catch(() => {}); // for CDP this only disconnects
      } else {
        await browser.close().catch(() => {});
      }
    },
  };
}

export function findGameFrame(page: Page): Frame | undefined {
  return page.frames().find((f) => f.url().includes(GAME_FRAME_PATH));
}

export async function waitForGameFrame(page: Page, timeoutMs = 60000): Promise<Frame> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const f = findGameFrame(page);
    if (f) return f;
    await page.waitForTimeout(250);
  }
  throw new Error("the game frame did not appear");
}

/** Handle Node uses to act in the page. */
export interface PageControl {
  frame(): Frame;
  execute(plan: PagePlan): Promise<void>;
  /** Leaves a plan in the page to run the instant the expected piece spawns; null cancels it. */
  arm(plan: PagePlan | null): Promise<void>;
  /** Sends one key, for the last-resort case where no plan could be made at all. */
  press(key: "left" | "right" | "cw" | "ccw" | "soft" | "hard" | "hold"): Promise<void>;
  startGame(levelIndex: number): Promise<{ ok: boolean; reason?: string; scene: string }>;
  sceneName(): Promise<string>;
  adFallbackComplete(): Promise<boolean>;
  isAdActive(): Promise<boolean>;
}

/** Installs the page agent in the game frame once its engine object exists, and returns the control handle. */
export async function connectPageAgent(page: Page, constants: PageConstants, onSnapshot: (s: PageSnapshot) => void, timeoutMs = 120000): Promise<PageControl> {
  await page.exposeFunction("__tetrisPush", (s: PageSnapshot) => onSnapshot(s));
  let frame = await waitForGameFrame(page, timeoutMs);
  const install = async (): Promise<void> => {
    frame = await waitForGameFrame(page, timeoutMs);
    await frame.waitForFunction(() => typeof (window as Window).mBPSApp === "object" && (window as Window).mBPSApp !== null, null, { timeout: timeoutMs });
    const res = await frame.evaluate(installPageAgent, constants);
    if (!res.ok) throw new Error(`could not install the page agent: ${res.reason}`);
  };
  await install();
  page.on("framenavigated", (f) => {
    if (f.url().includes(GAME_FRAME_PATH)) void install().catch(() => {});
  });

  const evalAgent = <T>(fn: (api: NonNullable<Window["__tetrisAgent"]>, arg: unknown) => T, arg?: unknown): Promise<T> =>
    frame.evaluate(([src, a]) => {
      const api = (window as Window).__tetrisAgent;
      if (!api) throw new Error("page agent not installed");
      // eslint-disable-next-line no-new-func
      return (new Function("api", "arg", `return (${src})(api, arg)`) as (api: unknown, arg: unknown) => T)(api, a);
    }, [fn.toString(), arg] as const);

  return {
    frame: () => frame,
    execute: (plan: PagePlan) => evalAgent((api, p) => api.execute(p as PagePlan), plan).catch(() => {}),
    arm: (plan: PagePlan | null) => evalAgent((api, p) => api.arm(p as PagePlan | null), plan).catch(() => {}),
    press: (key) => evalAgent((api, k) => api.press(k as "hard"), key).catch(() => {}),
    startGame: (levelIndex: number) => evalAgent((api, l) => api.startGame(l as number), levelIndex).catch((err: Error) => ({ ok: false, reason: `page call failed: ${err.message}`, scene: "unknown" })),
    sceneName: () => evalAgent((api) => api.sceneName()).catch(() => "unknown"),
    adFallbackComplete: () => evalAgent((api) => api.adFallbackComplete()).catch(() => false),
    // The page's own flag stays true after a restart's video preroll, so look at the ad element itself.
    isAdActive: () =>
      frame
        .evaluate(() => {
          for (const ins of document.querySelectorAll("ins.adsbygoogle")) {
            const el = ins as HTMLElement;
            if (getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 50) return true;
          }
          return false;
        })
        .catch(() => false),
  };
}
