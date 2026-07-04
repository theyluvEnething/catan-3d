// probe-buydev.js — capture the REAL buy-dev action by clicking Colonist's own "Buy development
// card" button (a trusted Playwright click) while we log outgoing frames. Reads the action id
// straight off the wire — no guessing. Force-exits so it never hangs.
import { launch, checkLogin, ROOT } from "./launch.js";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(ROOT, "debug", "hud");
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const done = (code) => { log("exiting", code); setTimeout(() => process.exit(code), 500); };

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { log("not logged in"); done(2); }
await page.goto("https://colonist.io/", { waitUntil: "domcontentloaded" }).catch(() => {});
await sleep(3000);
const reconnect = async () => { const h = await page.evaluateHandle(() => Array.from(document.querySelectorAll("button,.top-notification-button,div")).find((e) => /^reconnect$/i.test((e.innerText || "").trim()) && e.getBoundingClientRect().width > 0) || null); const el = h.asElement(); if (el) { await el.click({ force: true }).catch(() => {}); return true; } return false; };
if (await reconnect()) { log("reconnected"); await sleep(6000); }
if (!(await page.$("#game-canvas"))) { log("no game canvas"); done(1); }

const core = () => page.evaluate(() => {
  const s = window.__catan3d && window.__catan3d.state; if (!s || !s.ready) return null;
  const ps = s.playerState(s.us) || {};
  const raw = (ps.resourceCards && ps.resourceCards.cards) || [];
  const hand = {}; for (const r of raw) hand[r] = (hand[r] || 0) + 1;
  const dev = s.gameState.mechanicDevelopmentCardsState || {};
  const mine = dev.players?.[s.us] || {};
  return { us: s.us, yourTurn: s.currentTurnColor === s.us, turnState: s.turnState, actionState: s.actionState,
    hand, bankDev: (dev.bankDevelopmentCards?.cards || []).length,
    devHand: (mine.developmentCards?.cards || []).length, bought: (mine.developmentCardsBoughtThisTurn || []).length };
}).catch(() => null);
const outSince = (t) => page.evaluate((t) => (window.__catan3d.outActionsSince ? window.__catan3d.outActionsSince(t) : []), t).catch(() => []);

// Find + click Colonist's own buy-dev control. Try known ids, then any element whose text/id
// mentions development. Colonist's buy-dev is usually in the build menu or a dedicated button.
async function clickBuyDev() {
  // VERIFIED id from the live DOM dump: #action-button-buy-dev-card. Also try the class.
  for (const sel of ["#action-button-buy-dev-card", ".buyDevelopmentCardButton-ZZiU63kF", "[class*=buyDevelopmentCardButton]"]) {
    const el = await page.$(sel);
    if (el && await el.boundingBox()) { await el.click({ force: true }).catch(() => {}); return sel; }
  }
  return null;
}

log("in game; waiting for affordable main-phase turn, then clicking Colonist's buy-dev button…");
let found = null;
for (let i = 0; i < 150 && !found; i++) {
  const c = await core();
  if (!c) { await sleep(1500); continue; }
  if (c.yourTurn && c.turnState !== 0 && c.actionState === 0) { await page.keyboard.press("Space").catch(() => {}); await sleep(1300); continue; }
  const canBuy = c.yourTurn && c.turnState !== 0 && (c.hand[3] || 0) >= 1 && (c.hand[4] || 0) >= 1 && (c.hand[5] || 0) >= 1;
  if (canBuy) {
    log("affordable! hand=", JSON.stringify(c.hand), "bankDev", c.bankDev, "— clicking buy-dev");
    const t0 = Date.now();
    const clicked = await clickBuyDev();
    log("  buy-dev click:", clicked);
    await sleep(1800);
    const k = await core();
    const outs = await outSince(t0);
    const grew = k && (k.bankDev < c.bankDev || (k.devHand + k.bought) > (c.devHand + c.bought));
    log("  after: bankDev", k ? k.bankDev : "?", "devHand", k ? k.devHand : "?", "bought", k ? k.bought : "?", "| outgoing:", JSON.stringify(outs));
    if (grew && outs.length) {
      // the buy-dev action is the outgoing frame(s) that coincided with the dev-state change
      found = { clicked, outFrames: outs, bankDevBefore: c.bankDev, bankDevAfter: k.bankDev };
      break;
    }
    // if click didn't work, end turn and wait for next affordable turn
    await page.evaluate(() => window.__catan3d.sendGameAction(6, true)).catch(() => {});
    await sleep(1200);
  } else await sleep(1500);
}

if (found) {
  fs.writeFileSync(path.join(OUT, "buy-dev-result.json"), JSON.stringify(found, null, 2));
  const acts = found.outFrames.map((f) => f.action);
  log("✅ buy-dev outgoing action(s):", JSON.stringify(acts), " frames:", JSON.stringify(found.outFrames));
} else {
  log("❌ could not capture buy-dev (button not found or never affordable).");
}
await page.screenshot({ path: path.join(OUT, "probe-buydev-final.png") }).catch(() => {});
done(found ? 0 : 1);
