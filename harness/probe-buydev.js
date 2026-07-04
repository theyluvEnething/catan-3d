// probe-buydev.js — start a FRESH game, play the opening via direct-send to high-pip corners,
// then the moment we can afford a dev, click Colonist's real #action-button-buy-dev-card
// (trusted click) and read the outgoing action off window.__catan3d.outActions.
// Force-exits so it never hangs.
import { launch, checkLogin, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(ROOT, "debug", "hud");
const LOGF = path.join(OUT, "probe-buydev.log");
try { fs.writeFileSync(LOGF, ""); } catch {}
// Write to BOTH stdout and a file, so logs survive a fast process.exit (stdout isn't flushed).
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`; console.log(line); try { fs.appendFileSync(LOGF, line + "\n"); } catch {} };
process.on("unhandledRejection", (e) => { log("UNHANDLED_REJECTION", String(e && e.message || e)); });
process.on("uncaughtException", (e) => { log("UNCAUGHT", String(e && e.message || e)); });
const done = (code) => { log("exiting " + code); try { fs.appendFileSync(LOGF, "DONE " + code + "\n"); } catch {} setTimeout(() => process.exit(code), 800); };

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
page.on("pageerror", (e) => log("PAGEERROR", e.message));
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { log("not logged in"); done(2); }
await dismissConsent(page);
// DO NOT click Reconnect (it drops us into a stale/conflicting game and wedges the page).
// Dismiss the reconnect notification if present, then start FRESH from the landing page.
await page.evaluate(() => { const b = document.querySelector(".top-notification-close-button"); if (b) b.click(); }).catch(() => {});
await sleep(1500);
log("starting fresh bot game…");
await startBotGame(page, {});
await sleep(4000);
for (let w = 0; w < 60 && !(await page.$("#game-canvas")); w++) await sleep(1000);
if (!(await page.$("#game-canvas"))) { log("no canvas"); done(1); }
log("in game");

const core = () => page.evaluate(() => {
  const s = window.__catan3d && window.__catan3d.state; if (!s || !s.ready) return null;
  const ps = s.playerState(s.us) || {};
  const raw = (ps.resourceCards && ps.resourceCards.cards) || [];
  const hand = {}; for (const r of raw) hand[r] = (hand[r] || 0) + 1;
  const dev = s.gameState.mechanicDevelopmentCardsState || {};
  const mine = dev.players?.[s.us] || {};
  return { us: s.us, yourTurn: s.currentTurnColor === s.us, turnState: s.turnState, actionState: s.actionState,
    hand, bankDev: (dev.bankDevelopmentCards?.cards || []).length,
    devHand: (mine.developmentCards?.cards || []).length, bought: (mine.developmentCardsBoughtThisTurn || []).length,
    s: Object.values(s.gameState.mapState.tileCornerStates).filter((c) => c.owner === s.us).length,
    r: Object.values(s.gameState.mapState.tileEdgeStates).filter((e) => e.owner === s.us).length };
}).catch(() => null);
const send = (a, p) => page.evaluate(({ a, p }) => window.__catan3d.sendGameAction(a, p), { a, p }).catch((e) => ({ err: e.message }));
const outSince = (t) => page.evaluate((t) => (window.__catan3d.outActionsSince ? window.__catan3d.outActionsSince(t) : []), t).catch(() => []);
const bestSettleIdx = () => page.evaluate(() => {
  const gs = window.__catan3d.state.gameState, ms = gs.mapState;
  const legal = window.__catan3d.legalSettlements({ setup: true }); if (!legal.length) return -1;
  const hexAt = {}; for (const h of Object.values(ms.tileHexStates)) hexAt[h.x + "," + h.y] = h;
  const pip = (n) => (n === 0 ? 0 : 6 - Math.abs(7 - n));
  const ch = (x, y, z) => { const o = [{ x, y }]; if (z === 0) o.push({ x, y: y - 1 }, { x: x + 1, y: y - 1 }); else o.push({ x: x - 1, y: y + 1 }, { x, y: y + 1 }); return o; };
  let best = null, bs = -1;
  for (const c of legal) { let s = 0; for (const h of ch(c.x, c.y, c.z)) { const hx = hexAt[h.x + "," + h.y]; if (hx && hx.type !== 0) s += pip(hx.diceNumber); } if (s > bs) { bs = s; best = c; } }
  if (!best) return -1;
  for (const [i, t] of Object.entries(ms.tileCornerStates)) if (t.x === best.x && t.y === best.y && t.z === best.z) return Number(i);
  return -1;
});
const firstRoadIdx = () => page.evaluate(() => {
  const ms = window.__catan3d.state.gameState.mapState, us = window.__catan3d.state.us;
  const own = Object.values(ms.tileCornerStates).filter((c) => c.owner === us); const from = own.length ? own[own.length - 1] : null;
  const roads = window.__catan3d.legalRoads({ setup: true, fromCorner: from }); if (!roads.length) return -1;
  const e = roads[0]; for (const [i, t] of Object.entries(ms.tileEdgeStates)) if (t.x === e.x && t.y === e.y && t.z === e.z) return Number(i);
  return -1;
});

// play opening
log("playing setup…");
for (let step = 0; step < 40; step++) {
  const c = await core(); if (!c) { await sleep(900); continue; }
  if (c.s >= 2 && c.r >= 2) { log("setup complete"); break; }
  if (!c.yourTurn) { await sleep(700); continue; }
  if (c.turnState === 0 && c.actionState === 1) { const i = await bestSettleIdx(); if (i >= 0) { await send(15, i); log("settlement @", i); await sleep(1400); } else await sleep(600); }
  else if (c.actionState === 3) { const i = await firstRoadIdx(); if (i >= 0) { await send(11, i); log("road @", i); await sleep(1400); } else await sleep(600); }
  else await sleep(700);
}

async function clickBuyDev() {
  for (const sel of ["#action-button-buy-dev-card", "[class*=buyDevelopmentCardButton]"]) {
    const el = await page.$(sel); if (el && await el.boundingBox()) { await el.click({ force: true }).catch(() => {}); return sel; }
  }
  return null;
}

log("main phase: waiting to afford a dev, then clicking #action-button-buy-dev-card");
let found = null;
for (let i = 0; i < 220 && !found; i++) {
  const c = await core(); if (!c) { await sleep(1400); continue; }
  if (c.yourTurn && c.turnState !== 0 && c.actionState === 0) { await page.keyboard.press("Space").catch(() => {}); await sleep(1300); continue; }
  const canBuy = c.yourTurn && c.turnState !== 0 && (c.hand[3] || 0) >= 1 && (c.hand[4] || 0) >= 1 && (c.hand[5] || 0) >= 1;
  if (canBuy) {
    log("affordable! hand=", JSON.stringify(c.hand), "bankDev", c.bankDev);
    const t0 = Date.now();
    const clicked = await clickBuyDev();
    log("  clicked buy-dev:", clicked);
    await sleep(1800);
    const k = await core();
    const outs = await outSince(t0);
    const grew = k && (k.bankDev < c.bankDev || (k.devHand + k.bought) > (c.devHand + c.bought));
    log("  after: bankDev", k ? k.bankDev : "?", "dev", k ? (k.devHand + k.bought) : "?", "| outgoing:", JSON.stringify(outs));
    if (grew && outs.length) { found = { clicked, outFrames: outs, bankDevBefore: c.bankDev, bankDevAfter: k.bankDev }; break; }
    await send(6, true); await sleep(1200); // end turn, wait for next affordable turn
  } else await sleep(1400);
}

if (found) {
  fs.writeFileSync(path.join(OUT, "buy-dev-result.json"), JSON.stringify(found, null, 2));
  log("✅ buy-dev outgoing:", JSON.stringify(found.outFrames));
} else log("❌ not captured");
await page.screenshot({ path: path.join(OUT, "probe-buydev-final.png") }).catch(() => {});
done(found ? 0 : 1);
