// diag-turn.js — minimal: start a game, then log core() every 3s for 3 minutes so we SEE
// whether/when it becomes our turn and what phase we're in. Surfaces all errors.
import { launch, checkLogin, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import path from "node:path";

process.on("unhandledRejection", (e) => console.error("UNHANDLED", e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
const { loggedIn } = await checkLogin(page);
console.log("loggedIn:", loggedIn);
if (!loggedIn) { await context.close(); process.exit(2); }
await dismissConsent(page);

// dismiss reconnect, else start fresh
const clickReconnect = async () => { const h = await page.evaluateHandle(() => Array.from(document.querySelectorAll("button,.top-notification-button,div")).find((e) => /^reconnect$/i.test((e.innerText || "").trim()) && e.getBoundingClientRect().width > 0) || null); const el = h.asElement(); if (el) { await el.click({ force: true }).catch(() => {}); return true; } return false; };
if (await clickReconnect()) { console.log("reconnected"); await sleep(6000); }
if (!(await page.$("#game-canvas"))) { console.log("starting fresh game"); await startBotGame(page, {}); }
await sleep(3000);
console.log("canvas present:", !!(await page.$("#game-canvas")));

for (let i = 0; i < 60; i++) {
  const c = await page.evaluate(() => {
    const s = window.__catan3d && window.__catan3d.state;
    if (!s) return { err: "no __catan3d.state" };
    if (!s.ready) return { ready: false };
    const ps = s.playerState(s.us) || {};
    const raw = (ps.resourceCards && ps.resourceCards.cards) || [];
    const hand = {}; for (const r of raw) hand[r] = (hand[r] || 0) + 1;
    return { ready: true, us: s.us, turn: s.currentTurnColor, yourTurn: s.currentTurnColor === s.us, turnState: s.turnState, actionState: s.actionState, completed: s.completedTurns, handSize: raw.length, hand };
  }).catch((e) => ({ err: String(e.message) }));
  console.log(`[${i * 3}s]`, JSON.stringify(c));
  // If it's our turn in setup, place a settlement so the game progresses.
  if (c.ready && c.yourTurn && c.turnState === 0 && c.actionState === 1) {
    const r = await page.evaluate(() => {
      const legal = window.__catan3d.legalSettlements({ setup: true });
      if (!legal.length) return "no-legal";
      const c = legal[0]; const ms = window.__catan3d.state.gameState.mapState.tileCornerStates;
      let idx = -1; for (const [i, t] of Object.entries(ms)) if (t.x === c.x && t.y === c.y && t.z === c.z) { idx = Number(i); break; }
      return window.__catan3d.buildSettlement(idx);
    }).catch((e) => ({ err: e.message }));
    console.log("   placed settlement:", JSON.stringify(r));
  } else if (c.ready && c.yourTurn && c.actionState === 3) {
    const r = await page.evaluate(() => {
      const mine = (() => { const ms = window.__catan3d.state.gameState.mapState.tileCornerStates, us = window.__catan3d.state.us; const own = Object.values(ms).filter((c) => c.owner === us); return own.length ? own[own.length - 1] : null; })();
      const roads = window.__catan3d.legalRoads({ setup: true, fromCorner: mine });
      if (!roads.length) return "no-legal-roads";
      const e = roads[0]; const ms = window.__catan3d.state.gameState.mapState.tileEdgeStates;
      let idx = -1; for (const [i, t] of Object.entries(ms)) if (t.x === e.x && t.y === e.y && t.z === e.z) { idx = Number(i); break; }
      return window.__catan3d.buildRoad(idx);
    }).catch((e) => ({ err: e.message }));
    console.log("   placed road:", JSON.stringify(r));
  } else if (c.ready && c.yourTurn && c.turnState !== 0 && c.actionState === 0) {
    await page.keyboard.press("Space").catch(() => {});
    console.log("   rolled (space)");
  } else if (c.ready && c.yourTurn && c.turnState !== 0) {
    await page.evaluate(() => window.__catan3d.sendGameAction(6, true)).catch(() => {});
    console.log("   ended turn");
  }
  await sleep(3000);
}
await page.screenshot({ path: path.join(ROOT, "debug", "hud", "diag-final.png") }).catch(() => {});
console.log("diag done");
await context.close();
