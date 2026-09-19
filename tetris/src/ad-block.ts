/**
 * Ad removal for play.tetris.com, in code only: no browser extension, no
 * filter-list subscription, nothing the user has to install. Three layers,
 * all installed before the first byte of the page is parsed:
 *
 *  1. Network. Every request the page makes is matched against the ad hosts
 *     and URL shapes below and aborted, so no ad script, creative, bid
 *     request or cookie sync ever loads. `matchAdRule` is a pure function so
 *     the list can be unit-tested; play.tetris.com's own origin is never
 *     blocked.
 *  2. Shims. Blocking alone would leave the game waiting: it only shows its
 *     menu once the ad SDKs report back. So the shims answer for them, using
 *     the page's own callbacks:
 *       - `window.adsbygoogle`, in the game frame, is a queue whose push
 *         answers `adConfig({onReady})` and `adBreak({adBreakDone})` at once
 *         with "no ad delivered". The game's H5 interstitial is over before
 *         it starts (the site's own fallback would take 6 s of waiting).
 *       - the preroll handshake is answered in the parent: the game frame
 *         posts `gameLoaderComplete` (first load) or `playVastPreroll`
 *         (later games) and waits for `prerollComplete` / `vastPrerollComplete`
 *         to come back. The shim replies immediately and stops the message
 *         from reaching the site's video-ad component, so the click-to-play
 *         layer and the 15-30 s video never appear at all.
 *       - `window.googletag` is an inert stub, so page and game code that
 *         calls into GPT (`parent.googletag.pubads().refresh()`) finds the
 *         shape it expects instead of throwing.
 *  3. DOM. A stylesheet plus a MutationObserver keep ad containers (AdSense
 *     ins tags, GPT slots, ad iframes, the in-game ad div, Taboola) hidden,
 *     so nothing flashes up and no empty boxes are left behind.
 *
 * `AdHandler` in ads.ts stays in place as the safety net: if the site ever
 * changes its handshake, the old choreography still waits ads out and closes
 * them with their own controls.
 */
import type { Frame, Page } from "playwright-core";

/**
 * Hosts that exist to serve, broker, measure or target ads. A request is
 * blocked when its hostname is one of these or a subdomain of one. The list
 * is what play.tetris.com actually reaches for (recorded from a full page
 * load and a game start), plus the usual exchanges those pages rotate through.
 */
export const AD_HOSTS: readonly string[] = [
  // Google's ad stack: AdSense, GPT, the H5 interstitial, the IMA video SDK,
  // creative hosting, ad-traffic measurement and the anti-ad-blocker wall.
  "doubleclick.net",
  "googlesyndication.com",
  "googletagservices.com",
  "googleadservices.com",
  "adservice.google.com",
  "adtrafficquality.google",
  "fundingchoicesmessages.google.com",
  "imasdk.googleapis.com",
  "2mdn.net",
  // Tag managers and analytics: not ads themselves, but they load and target them.
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "analytics.yahoo.com",
  "clarity.ms",
  "scorecardresearch.com",
  "quantserve.com",
  // Header bidding and exchanges this site sells through.
  "bidbrain.app",
  "taboola.com",
  "postrelease.com",
  "kueezrtb.com",
  "richaudience.com",
  "marphezis.com",
  "seedtag.com",
  "adklip.com",
  "id5-sync.com",
  "eu-1-id5-sync.com",
  "adnxs.com",
  "criteo.com",
  "criteo.net",
  "casalemedia.com",
  "contextweb.com",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "smartadserver.com",
  "360yield.com",
  "3lift.com",
  "adsrvr.org",
  "bidswitch.net",
  "bidr.io",
  "media.net",
  "mathtag.com",
  "agkn.com",
  "lijit.com",
  "simpli.fi",
  "creativecdn.com",
  "turn.com",
  "blismedia.com",
  "appier.net",
  "advolve.io",
  "inmobi.com",
  "pacvue.com",
  "pix.pub",
  "tsdtocl.com",
  "amazon-adsystem.com",
  "ads.linkedin.com",
  // Verification, viewability and brand safety.
  "doubleverify.com",
  "adsafeprotected.com",
  "moatads.com",
  // Video ad serving.
  "spotxchange.com",
  "springserve.com",
  "innovid.com",
  "fwmrm.net",
  "teads.tv",
  // Other networks that turn up in the same auctions.
  "outbrain.com",
  "sharethrough.com",
  "yieldmo.com",
  "adform.net",
  "gumgum.com",
  "indexww.com",
  "33across.com",
  "sonobi.com",
];

/**
 * URL shapes that give an ad away whatever the host serves it from: Google's
 * ad endpoints, the SDK filenames, header-bidding endpoints and the cookie
 * syncs the exchanges fire at each other.
 */
export const AD_URL_PATTERNS: readonly RegExp[] = [
  /\/pagead\//,
  /\/gampad\//,
  /adsbygoogle\.js/,
  /sdkloader\/ima3\.js/,
  /\/prebid/,
  /[?&]google_push=/,
  /\/cookie[-_]sync/,
  /\/usersync/,
];

/** Origins the game itself is served from; never blocked, whatever they contain. */
export const FIRST_PARTY_HOSTS: readonly string[] = ["tetris.com"];

const inDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/**
 * The rule that blocks this URL, or null to let it through. Returning the
 * rule (not just a boolean) is what makes `--check-ads` readable and the
 * list testable.
 */
export function matchAdRule(url: string): string | null {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    host = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (FIRST_PARTY_HOSTS.some((d) => inDomain(host, d))) return null;
  const adHost = AD_HOSTS.find((d) => inDomain(host, d));
  if (adHost) return `host:${adHost}`;
  const pattern = AD_URL_PATTERNS.find((re) => re.test(url));
  return pattern ? `url:${pattern.source}` : null;
}

/** Counters the in-page shims keep, read back for the summary. */
export interface PageAdBlockStats {
  /** Game-area (AdSense H5) ad requests answered with "no ad delivered". */
  interstitialsAnswered: number;
  /** Preroll handshakes answered on the spot, so no video and no click-to-play layer. */
  prerollsAnswered: number;
  /** Ad containers hidden by the stylesheet and the observer. */
  elementsHidden: number;
}

export interface AdBlockReport {
  blockedRequests: number;
  /** Blocked request counts per host, busiest first. */
  hosts: Array<{ host: string; count: number; rule: string }>;
  page: PageAdBlockStats;
}

declare global {
  interface Window {
    __jevAdBlock?: PageAdBlockStats;
    adsbygoogle?: unknown;
    googletag?: unknown;
  }
}

/**
 * Runs in every frame before the site's own scripts. Keep it self-contained:
 * Playwright serializes this function's source, so it must not reference
 * module scope.
 */
export function installAdShims(): void {
  if (window.__jevAdBlock) return;
  const stats: PageAdBlockStats = { interstitialsAnswered: 0, prerollsAnswered: 0, elementsHidden: 0 };
  window.__jevAdBlock = stats;
  const soon = (fn: () => void): void => void setTimeout(fn, 0);

  // --- 1. AdSense H5 ads (the game frame's interstitial) -------------------
  // The game does `adsbygoogle.push(o)` for two things: adConfig({onReady})
  // once at startup, and adBreak({type, adBreakDone}) per ad. Answering both
  // straight away walks the game through its own no-ad path.
  const queue = {
    length: 0,
    loaded: true,
    push(o: unknown): number {
      const cfg = o as { onReady?: () => void; adBreakDone?: (info: Record<string, unknown>) => void; type?: string; name?: string } | null;
      if (cfg && typeof cfg === "object") {
        if (typeof cfg.onReady === "function") {
          const onReady = cfg.onReady;
          soon(() => {
            try {
              onReady();
            } catch {
              /* the page's own handler threw; nothing to do */
            }
          });
        }
        if (typeof cfg.adBreakDone === "function") {
          const done = cfg.adBreakDone;
          stats.interstitialsAnswered++;
          soon(() => {
            try {
              done({ breakType: cfg.type ?? "preroll", breakName: cfg.name ?? "", breakFormat: "interstitial", breakStatus: "noAdPreloaded" });
            } catch {
              /* same */
            }
          });
        }
      }
      return ++queue.length;
    },
  };
  try {
    Object.defineProperty(window, "adsbygoogle", { value: queue, writable: true, configurable: true });
  } catch {
    window.adsbygoogle = queue;
  }

  // --- 2. The preroll handshake (parent page) ------------------------------
  // The game frame asks the parent for a video ad and waits for the reply.
  // Reply at once and keep the message from reaching the site's video
  // component, so neither the click-to-play layer nor the video is created.
  // This listener is registered before the site's, so stopping the event here
  // stops it for good.
  window.addEventListener(
    "message",
    (event: MessageEvent) => {
      const type = (event.data as { type?: string } | null)?.type;
      if (type !== "gameLoaderComplete" && type !== "playVastPreroll") return;
      const reply = type === "gameLoaderComplete" ? "prerollComplete" : "vastPrerollComplete";
      const source = event.source as Window | null;
      if (!source) return;
      event.stopImmediatePropagation();
      stats.prerollsAnswered++;
      soon(() => {
        try {
          source.postMessage({ type: reply }, "*");
        } catch {
          /* the frame went away */
        }
      });
    },
    true,
  );

  // --- 3. GPT (the page's ad slots) ---------------------------------------
  // Inert: the command queue is never drained, so no slot is ever defined,
  // but every call the page and the game make still finds a function.
  const noop = (): void => {};
  const chain = <T>(self: T) => (): T => self;
  const slot: Record<string, unknown> = {};
  for (const m of ["addService", "defineSizeMapping", "setTargeting", "clearTargeting", "setConfig", "updateTargetingFromMap", "setCollapseEmptyDiv"]) slot[m] = chain(slot);
  slot.getSlotElementId = (): string => "";
  slot.getAdUnitPath = (): string => "";
  const pubads: Record<string, unknown> = {};
  for (const m of ["enableSingleRequest", "disableInitialLoad", "collapseEmptyDivs", "refresh", "addEventListener", "removeEventListener", "setCentering", "setPrivacySettings", "setConfig", "clear", "setRequestNonPersonalizedAds", "setForceSafeFrame", "setPublisherProvidedId"]) pubads[m] = noop;
  pubads.setTargeting = chain(pubads);
  pubads.getSlots = (): unknown[] => [];
  const existing = window.googletag as { cmd?: unknown[] } | undefined;
  const googletag: Record<string, unknown> = {
    cmd: Array.isArray(existing?.cmd) ? existing.cmd : [],
    apiReady: false,
    pubadsReady: false,
    pubads: () => pubads,
    defineSlot: () => slot,
    defineOutOfPageSlot: () => slot,
    sizeMapping: () => {
      const builder: Record<string, unknown> = { build: (): unknown[] => [] };
      builder.addSize = chain(builder);
      return builder;
    },
    enableServices: noop,
    display: noop,
    destroySlots: () => true,
    setConfig: noop,
    companionAds: () => ({ setRefreshUnfilledSlots: noop }),
  };
  try {
    Object.defineProperty(window, "googletag", { value: googletag, writable: true, configurable: true });
  } catch {
    window.googletag = googletag;
  }

  // --- 4. Whatever still reaches the DOM ----------------------------------
  const SELECTOR = [
    "ins.adsbygoogle",
    'div[id^="div-gpt-ad"]',
    'div[id^="google_ads_"]',
    'div[id*="gpt_unit_"]',
    "#gameAxDivContainer",
    'iframe[id^="google_ads_iframe"]',
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]',
    'iframe[src*="2mdn.net"]',
    'iframe[src*="adtrafficquality.google"]',
    'iframe[src*="taboola"]',
    '[id^="taboola-"]',
    ".trc_rbox_container",
  ].join(",");
  const style = document.createElement("style");
  style.id = "__jev-ad-block";
  style.textContent = `${SELECTOR}{display:none!important;visibility:hidden!important;height:0!important;min-height:0!important}`;
  const attach = (): void => {
    (document.head ?? document.documentElement).appendChild(style);
  };
  if (document.documentElement) attach();
  else {
    document.addEventListener("readystatechange", attach, { once: true });
    document.addEventListener("DOMContentLoaded", attach, { once: true });
  }

  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        try {
          if (el.matches(SELECTOR)) stats.elementsHidden++;
          else stats.elementsHidden += el.querySelectorAll(SELECTOR).length;
        } catch {
          /* a node type that cannot be matched */
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
}

/**
 * Blocks the ad traffic of one page and installs the shims in every frame it
 * opens. Install it before the first navigation.
 */
export class AdBlocker {
  private blocked = 0;
  private readonly hosts = new Map<string, { count: number; rule: string }>();
  private readonly log?: (event: Record<string, unknown>) => void;

  private constructor(log?: (event: Record<string, unknown>) => void) {
    this.log = log;
  }

  static async install(page: Page, opts: { log?: (event: Record<string, unknown>) => void } = {}): Promise<AdBlocker> {
    const blocker = new AdBlocker(opts.log);
    await page.addInitScript(installAdShims);
    await page.route(
      (url) => matchAdRule(url.href) !== null,
      async (route) => {
        const url = route.request().url();
        const rule = matchAdRule(url) ?? "unknown";
        blocker.count(url, rule);
        await route.abort("blockedbyclient").catch(() => {});
      },
    );
    return blocker;
  }

  private count(url: string, rule: string): void {
    this.blocked++;
    let host = "unknown";
    try {
      host = new URL(url).hostname;
    } catch {
      /* keep "unknown" */
    }
    const seen = this.hosts.get(host);
    if (seen) seen.count++;
    else {
      this.hosts.set(host, { count: 1, rule });
      this.log?.({ type: "ad-block", event: "first-block", host, rule });
    }
  }

  /** What was blocked, plus the counters the shims kept in every frame. */
  async report(page: Page): Promise<AdBlockReport> {
    const page_ = await readPageStats(page.frames());
    return {
      blockedRequests: this.blocked,
      hosts: [...this.hosts]
        .map(([host, v]) => ({ host, count: v.count, rule: v.rule }))
        .sort((a, b) => b.count - a.count),
      page: page_,
    };
  }

  /** One line for the session summary. */
  describe(report: AdBlockReport): string {
    const top = report.hosts
      .slice(0, 3)
      .map((h) => `${h.host} ${h.count}`)
      .join(", ");
    return (
      `Ads: ${report.blockedRequests} request${report.blockedRequests === 1 ? "" : "s"} blocked from ${report.hosts.length} host${report.hosts.length === 1 ? "" : "s"}` +
      `${top ? ` (${top})` : ""}, ${report.page.interstitialsAnswered} game-area ad${report.page.interstitialsAnswered === 1 ? "" : "s"} and ` +
      `${report.page.prerollsAnswered} preroll${report.page.prerollsAnswered === 1 ? "" : "s"} answered on the spot, ${report.page.elementsHidden} ad element${report.page.elementsHidden === 1 ? "" : "s"} hidden.`
    );
  }
}

async function readPageStats(frames: readonly Frame[]): Promise<PageAdBlockStats> {
  const total: PageAdBlockStats = { interstitialsAnswered: 0, prerollsAnswered: 0, elementsHidden: 0 };
  for (const frame of frames) {
    const s = await frame.evaluate(() => window.__jevAdBlock ?? null).catch(() => null);
    if (!s) continue;
    total.interstitialsAnswered += s.interstitialsAnswered;
    total.prerollsAnswered += s.prerollsAnswered;
    total.elementsHidden += s.elementsHidden;
  }
  return total;
}

/** Ad elements still visible anywhere in the page; `--check-ads` reports these. */
export async function visibleAdElements(page: Page): Promise<Array<{ frame: string; what: string }>> {
  const found: Array<{ frame: string; what: string }> = [];
  for (const frame of page.frames()) {
    const hits = await frame
      .evaluate(() => {
        const sel = 'ins.adsbygoogle,div[id^="div-gpt-ad"],iframe[id^="google_ads_iframe"],iframe[src*="doubleclick.net"],iframe[src*="googlesyndication.com"],video';
        const out: string[] = [];
        for (const el of document.querySelectorAll(sel)) {
          const e = el as HTMLElement;
          const r = e.getBoundingClientRect();
          if (r.width < 20 || r.height < 20 || getComputedStyle(e).visibility === "hidden" || getComputedStyle(e).display === "none") continue;
          if (e.tagName === "VIDEO" && !(e as HTMLVideoElement).currentSrc) continue;
          out.push(`${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        return out;
      })
      .catch(() => [] as string[]);
    for (const what of hits) found.push({ frame: frame.url().slice(0, 60), what });
  }
  return found;
}
