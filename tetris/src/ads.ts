/**
 * The ad choreography of play.tetris.com, handled without ever clicking an
 * ad creative:
 *
 *  1. On first load the game frame may show an AdSense interstitial. Its own
 *     "Close ad" control (a `#dismiss-button` inside Google's ad frame, which
 *     Playwright can reach) becomes clickable once its countdown ends; the
 *     agent waits for that and clicks exactly that control.
 *  2. The parent page then lays a transparent click-to-play layer over the
 *     game. One click on that layer (the site's own element) starts a video
 *     preroll, which ends by itself; if the player offers a "Skip" control it
 *     is clicked, otherwise the agent waits.
 *  3. Before every later game the page plays another video preroll the same
 *     way (autoplay, no click needed).
 *
 * As a last resort, after `adTimeoutMs` with an interstitial that never
 * offered a close control, the page's own completion callback is invoked so
 * the session cannot hang forever. That fallback is counted and logged.
 *
 * With ad removal on (ad-block.ts, the default) none of this normally runs:
 * no ad is loaded and no preroll is played. This stays as the safety net for
 * `--no-ad-block` and for the day the site changes its ad handshake.
 */
import type { Frame, Page } from "playwright-core";
import type { PageControl } from "./browser.ts";

export interface AdStatus {
  /** The game frame reports its game-area ad as active. */
  interstitial: boolean;
  /** What the parent's preroll layer is doing. */
  overlay: "none" | "click-to-play" | "video";
  videoSeconds: { at: number; total: number } | null;
  /** Human-readable last action. */
  message: string | null;
  /** True once the page reported a preroll as complete (the menu is usable afterwards). */
  prerollDone: boolean;
  interstitialsClosed: number;
  overlaysClicked: number;
  skipsClicked: number;
  fallbacks: number;
}

export interface AdHandlerOptions {
  adTimeoutMs: number;
  /**
   * True when ad-block.ts is removing the ads. The preroll handshake is then
   * answered inside the page, usually before this listener exists, so there
   * is no "preroll complete" line left to wait for: start out as done.
   */
  adsRemoved?: boolean;
  log?: (event: Record<string, unknown>) => void;
}

const SKIP_SELECTOR = '.videoAdUiSkipButton, [aria-label*="skip" i]';

export class AdHandler {
  readonly status: AdStatus = {
    interstitial: false,
    overlay: "none",
    videoSeconds: null,
    message: null,
    prerollDone: false,
    interstitialsClosed: 0,
    overlaysClicked: 0,
    skipsClicked: 0,
    fallbacks: 0,
  };
  private interstitialSince: number | null = null;
  /** What the parent's preroll layer expects: a click (first load) or nothing (autoplay before later games). */
  private overlayMode: "overlay" | "autoplay" | "unknown" = "unknown";
  private overlaySince: number | null = null;
  private overlayClickedAt: number | null = null;
  private videoSince: number | null = null;
  private lastSkipAttempt = 0;

  private readonly page: Page;
  private readonly control: PageControl;
  private readonly opts: AdHandlerOptions;

  constructor(page: Page, control: PageControl, opts: AdHandlerOptions) {
    this.page = page;
    this.control = control;
    this.opts = opts;
    if (opts.adsRemoved) {
      this.status.prerollDone = true;
      this.status.message = "ads removed in code; nothing to wait for";
    }
    page.on("console", (m) => {
      const t = m.text();
      if (/\[Game\] Preroll complete|\[VastPreroll\] Ad finished|\[TetrisGame\] Preroll complete/.test(t)) {
        this.status.prerollDone = true;
        this.status.message = "preroll finished";
        this.overlayClickedAt = null;
        this.videoSince = null;
        this.opts.log?.({ type: "ad", event: "preroll-complete" });
      } else if (/\[Game\] Requesting VAST preroll/.test(t)) {
        this.status.prerollDone = false;
        this.overlayMode = "autoplay";
        this.overlaySince = null;
        this.status.message = "video preroll requested before the next game";
        this.opts.log?.({ type: "ad", event: "preroll-requested" });
      } else if (/\[TetrisGame\] Game loader complete, showing preroll overlay/.test(t)) {
        this.overlayMode = "overlay";
        this.overlaySince = null;
      }
    });
  }

  /** One pass of the choreography; call it every few hundred milliseconds while not playing. */
  async tick(): Promise<AdStatus> {
    const now = Date.now();
    const interstitial = await this.control.isAdActive();
    this.status.interstitial = interstitial;
    if (interstitial) {
      this.interstitialSince ??= now;
      const dismiss = await this.findDismissButton();
      if (dismiss && !/in \d/.test(dismiss.text)) {
        try {
          await dismiss.frame.locator("#dismiss-button").first().click({ timeout: 2000 });
          this.status.interstitialsClosed++;
          this.status.message = "closed the interstitial with its own Close control";
          this.opts.log?.({ type: "ad", event: "interstitial-closed" });
          this.interstitialSince = null;
        } catch (err) {
          this.status.message = `close control not clickable yet: ${(err as Error).message.slice(0, 60)}`;
        }
      } else if (dismiss) {
        this.status.message = `interstitial: waiting for its countdown (${dismiss.text.slice(0, 30)})`;
      } else {
        this.status.message = "interstitial: waiting for a close control";
      }
      if (this.opts.adTimeoutMs > 0 && this.interstitialSince !== null && now - this.interstitialSince > this.opts.adTimeoutMs) {
        const ok = await this.control.adFallbackComplete();
        this.status.fallbacks++;
        this.status.message = ok ? "interstitial timed out: told the page the ad is over" : "interstitial timed out and the fallback failed";
        this.opts.log?.({ type: "ad", event: "interstitial-timeout-fallback", ok });
        this.interstitialSince = null;
      }
    } else {
      this.interstitialSince = null;
    }

    const overlay = await this.page
      .evaluate(() => {
        const c = document.querySelector(".tetris-container");
        const layer = c ? ([...c.children].find((e) => e.tagName === "DIV") as HTMLElement | undefined) : undefined;
        if (!layer) return null;
        const v = layer.querySelector("video");
        return v ? { src: Boolean(v.currentSrc || v.src), at: v.currentTime, total: Number.isFinite(v.duration) ? v.duration : 0, paused: v.paused } : { src: false, at: 0, total: 0, paused: true };
      })
      .catch(() => null);
    if (!overlay) {
      this.status.overlay = "none";
      this.status.videoSeconds = null;
      this.videoSince = null;
      return this.status;
    }
    if (overlay.src) {
      this.status.overlay = "video";
      this.status.videoSeconds = { at: Math.round(overlay.at), total: Math.round(overlay.total) };
      this.videoSince ??= now;
      if (now - this.lastSkipAttempt > 1500) {
        this.lastSkipAttempt = now;
        const skip = await this.findSkipButton();
        if (skip) {
          try {
            await skip.frame.locator(SKIP_SELECTOR).first().click({ timeout: 1000 });
            this.status.skipsClicked++;
            this.status.message = "clicked the video's Skip control";
            this.opts.log?.({ type: "ad", event: "video-skipped" });
          } catch {
            /* not clickable yet */
          }
        }
      }
      if (this.opts.adTimeoutMs > 0 && now - this.videoSince > this.opts.adTimeoutMs + 60_000) {
        // A video that never ends (player stuck): tell the game frame the preroll is over, as the parent would.
        await this.control
          .frame()
          .evaluate(() => window.postMessage({ type: "prerollComplete" }, "*"))
          .catch(() => {});
        this.status.fallbacks++;
        this.status.message = "video preroll stuck: told the game the preroll is over";
        this.opts.log?.({ type: "ad", event: "video-timeout-fallback" });
        this.videoSince = null;
      }
      return this.status;
    }
    this.status.overlay = "click-to-play";
    this.status.videoSeconds = null;
    this.overlaySince ??= now;
    // In autoplay mode the video starts by itself; click only the first-load layer (or after a grace period when the mode is unknown).
    const needsClick = this.overlayMode === "overlay" || (this.overlayMode === "unknown" && now - this.overlaySince > 3000);
    if (needsClick && !interstitial && (this.overlayClickedAt === null || now - this.overlayClickedAt > 8000)) {
      const box = await this.page.locator(".tetris-container > div").last().boundingBox().catch(() => null);
      if (box) {
        await this.page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
        this.overlayClickedAt = now;
        this.status.overlaysClicked++;
        this.status.message = "clicked the site's click-to-play layer";
        this.opts.log?.({ type: "ad", event: "click-to-play" });
      }
    }
    return this.status;
  }

  /** True when nothing ad-related is in the way. */
  clear(): boolean {
    return !this.status.interstitial && this.status.overlay === "none";
  }

  private async findDismissButton(): Promise<{ frame: Frame; text: string } | null> {
    for (const f of this.page.frames()) {
      if (!/doubleclick|googlesyndication|safeframe/.test(f.url())) continue;
      const text = await f
        .evaluate(() => {
          const e = document.querySelector("#dismiss-button") as HTMLElement | null;
          if (!e) return null;
          const r = e.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return null;
          return (e.textContent || "").trim();
        })
        .catch(() => null);
      if (text !== null) return { frame: f, text };
    }
    return null;
  }

  private async findSkipButton(): Promise<{ frame: Frame } | null> {
    for (const f of this.page.frames()) {
      const found = await f
        .evaluate((sel) => {
          for (const e of document.querySelectorAll(sel)) {
            const r = (e as HTMLElement).getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return true;
          }
          return false;
        }, SKIP_SELECTOR)
        .catch(() => false);
      if (found) return { frame: f };
    }
    return null;
  }
}
