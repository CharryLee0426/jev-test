/**
 * Browser layer: opens flappybird.io in Chrome through Playwright and wires
 * the in-page agent to Node. Two ways to get a browser:
 *  - launch the installed Google Chrome (default, separate profile);
 *  - attach to a Chrome you already run with --remote-debugging-port.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { GRAVITY_PER_STEP, IDLE_TARGET_Y, PIPE_CLEAR_X, STEPS_PER_SECOND } from "./physics.ts";
import { HOVER_OFFSET } from "./planner.ts";
import { installPageAgent, type PageConstants, type PagePlan, type PageSnapshot } from "./page-agent.ts";
import type { PageControl } from "./agent.ts";

export interface BrowserOptions {
  url: string;
  cdpUrl?: string;
  channel: string;
  headless: boolean;
  width: number;
  height: number;
}

export interface GameSession {
  browser: Browser;
  page: Page;
  attached: boolean;
  close(): Promise<void>;
}

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
  await page.goto(opts.url, { waitUntil: "domcontentloaded" });
  return {
    browser,
    page,
    attached,
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

export const PAGE_CONSTANTS: PageConstants = {
  gravityPerStep: GRAVITY_PER_STEP,
  stepsPerSecond: STEPS_PER_SECOND,
  hoverOffset: HOVER_OFFSET,
  idleTargetY: IDLE_TARGET_Y,
  pipeClearX: PIPE_CLEAR_X,
  lateTolerance: 6,
  pushEverySteps: 2,
};

/** Installs the page agent and returns the handle Node uses to act in the page. */
export async function connectPageAgent(page: Page, onSnapshot: (s: PageSnapshot) => void, timeoutMs = 60000): Promise<PageControl> {
  await page.exposeFunction("__agentPush", (s: PageSnapshot) => onSnapshot(s));
  const install = async (): Promise<void> => {
    await page.waitForFunction(() => typeof (window as Window).__game === "object" && (window as Window).__game !== null, null, { timeout: timeoutMs });
    await page
      .waitForFunction(() => document.querySelector(".loading-overlay")?.getAttribute("data-loaded") === "true", null, { timeout: 30000 })
      .catch(() => {});
    const res = await page.evaluate(installPageAgent, PAGE_CONSTANTS);
    if (!res.ok) throw new Error(`could not install the page agent: ${res.reason}`);
  };
  await install();
  page.on("load", () => void install().catch(() => {}));

  const evalAgent = <T>(fn: (api: NonNullable<Window["__agent"]>, arg: unknown) => T, arg?: unknown): Promise<T> =>
    page.evaluate(([src, a]) => {
      const api = (window as Window).__agent;
      if (!api) throw new Error("page agent not installed");
      // eslint-disable-next-line no-new-func
      return (new Function("api", "arg", `return (${src})(api, arg)`) as (api: unknown, arg: unknown) => T)(api, a);
    }, [fn.toString(), arg] as const);

  const quiet = async (p: Promise<unknown>): Promise<void> => {
    await p.catch(() => {});
  };
  return {
    setPlan: (plan: PagePlan) =>
      evalAgent((api, p) => api.setPlan(p as PagePlan), plan).catch((err: Error) => ({ accepted: false, reason: `page call failed: ${err.message}` })),
    setHoverBias: (bias: number) => quiet(evalAgent((api, b) => api.setHoverBias(b as number), bias)),
    cancelPendingFlaps: () => quiet(evalAgent((api) => api.cancelPendingFlaps())),
    startRun: (ranked: boolean) => quiet(evalAgent((api, r) => api.startRun(r as boolean), ranked)),
    restart: () => quiet(evalAgent((api) => api.restart())),
  };
}
