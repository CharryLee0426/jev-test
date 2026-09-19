import { test } from "node:test";
import assert from "node:assert/strict";
import { AD_HOSTS, matchAdRule } from "../src/ad-block.ts";

test("the ad stack play.tetris.com loads is blocked", () => {
  const blocked = [
    "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-0636857377230346",
    "https://securepubads.g.doubleclick.net/tag/js/gpt.js",
    "https://imasdk.googleapis.com/js/sdkloader/ima3.js",
    "https://pubads.g.doubleclick.net/gampad/ads?iu=/98948493,15125915/tetris_instream_1&output=vast",
    "https://s0.2mdn.net/sadbundle/705014368724838412/300x250-Display/index.html",
    "https://c6bb1b18cb8fd1abd7e7231647fd83dc.safeframe.googlesyndication.com/safeframe/1-0-45/html/container.html",
    "https://ep2.adtrafficquality.google/sodar/sodar2.js",
    "https://fundingchoicesmessages.google.com/i/15125915?ers=3",
    "https://www.googletagservices.com/dcm/dcmads.js",
    "https://www.googletagmanager.com/gtm.js?id=GTM-KC583W34",
    "https://cdn.taboola.com/libtrc/adklip-tetris/loader.js",
    "https://g.bidbrain.app/rtimp?a=imp&d=play.tetris.com",
    "https://exchange.kueezrtb.com/prebid/multi/699c71fd3ee8ee119c9481f5",
    "https://ib.adnxs.com/setuid?entity=584",
    "https://scripts.clarity.ms/0.8.70/clarity.js",
  ];
  for (const url of blocked) assert.notEqual(matchAdRule(url), null, `should block ${url}`);
});

test("cookie syncs are blocked whatever host fires them", () => {
  // The exchanges bounce these off hosts that are not ad networks themselves.
  assert.notEqual(matchAdRule("https://www.temu.com/api/adx/cm/pixel?google_push=AeofssIbFXIA"), null);
  assert.notEqual(matchAdRule("https://example.com/cookie-sync?partner=1"), null);
  assert.notEqual(matchAdRule("https://example.com/usersync/redir"), null);
});

test("the game, its assets and ordinary third parties are never blocked", () => {
  const allowed = [
    "https://play.tetris.com/",
    "https://play.tetris.com/tetris-game-package/game/target-desktop/game.html",
    "https://play.tetris.com/tetris-game-package/game/js/main.js?cbidg=62B1EB587D30B208",
    "https://play.tetris.com/_next/static/chunks/webpack-c4f77501246ede4f.js",
    "https://play.tetris.com/cdn-cgi/scripts/7d0fa10a/cloudflare-static/rocket-loader.min.js",
    "https://www.tetris.com/anything",
    "https://fonts.googleapis.com/css?family=Open%20Sans",
    "https://fonts.gstatic.com/s/opensans/v44/memvYaGs126MiZpBA.woff2",
    "https://use.typekit.net/cxb6bkm.css",
    "https://www.datocms-assets.com/145957/1746150304-tetris_logo.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "blob:https://play.tetris.com/6f0b",
  ];
  for (const url of allowed) assert.equal(matchAdRule(url), null, `should allow ${url}`);
});

test("a rule names why a request was blocked, and subdomains count", () => {
  assert.equal(matchAdRule("https://doubleclick.net/x"), "host:doubleclick.net");
  assert.equal(matchAdRule("https://googleads4.g.doubleclick.net/pcs/view"), "host:doubleclick.net");
  assert.match(matchAdRule("https://unknown-vendor.example/prebid/auction") ?? "", /^url:/);
  assert.equal(matchAdRule("not a url"), null);
  // "tetris.com" must not be shadowed by a host rule: the game is served from it.
  assert.ok(!AD_HOSTS.some((h) => h === "tetris.com" || h.endsWith(".tetris.com")));
});
