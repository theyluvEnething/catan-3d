// capture-dev-actions.js — nail the BUY-DEV (and PLAY-DEV) action ids by playing via direct-send.
//
//   node harness/capture-dev-actions.js
//
// Plays the opening (2 settlements + 2 roads) through our verified direct-send layer to reach the
// main phase, then each turn rolls (Space) and — the moment we can afford a dev (sheep+wheat+ore)
// — fires candidate action ids one at a time, checking after each whether our dev hand grew.
// The winning id is the buy-dev action. Uses window.__catan3d.outActions to log the real frames.
import { launch, checkLogin, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(ROOT, "debug", "hud");
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.error("not logged in — run login-once.js"); await context.close(); process.exit(2); }
await dismissConsent(page);

// If a prior session left a game open, Colonist shows a "Reconnect" button — clicking it
// rejoins that game (better than starting a fresh one that collides on the same account).
async function clickReconnect() {
  const h = await page.evaluateHandle(() => Array.from(document.querySelectorAll("button,[role=button],.top-notification-button,div"))
    .find((e) => /^reconnect$/i.test((e.innerText || "").trim()) && e.getBoundingClientRect().width > 0) || null);
  const el = h.asElement(); if (el) { await el.click({ force: true }).catch(() => {}); return true; }
  return false;
}
if (await clickReconnect()) { log("clicked Reconnect (rejoining prior game)"); await sleep(6000); }

if (!(await page.$("#game-canvas"))) {
  await startBotGame(page, {});
  await sleep(4000);
}
for (let w = 0; w < 60 && !(await page.$("#game-canvas")); w++) { await sleep(1000); if (w % 8 === 7) await clickReconnect(); }
if (!(await page.$("#game-canvas"))) { log("no canvas — likely stuck on Reconnect/lobby; aborting"); await page.screenshot({ path: path.join(OUT, "dev-capture-stuck.png") }).catch(() => {}); await context.close(); process.exit(1); }
log("in game");

const core = () => page.evaluate(() => {
  const s = window.__catan3d.state; if (!s.ready) return null;
  const ps = s.playerState(s.us) || {};
  const raw = (ps.resourceCards && ps.resourceCards.cards) || [];
  const hand = {}; for (const r of raw) hand[r] = (hand[r] || 0) + 1;
  const dev = s.gameState.mechanicDevelopmentCardsState?.players?.[s.us] || {};
  return { us: s.us, turn: s.currentTurnColor, yourTurn: s.currentTurnColor === s.us,
    completed: s.completedTurns, turnState: s.turnState, actionState: s.actionState,
    hand, devHand: (dev.developmentCards?.cards || []).slice(), devUsed: (dev.developmentCardsUsed || []).slice() };
});
const legalSettles = () => page.evaluate(() => window.__catan3d.legalSettlements({ setup: true }).map((c) => ({ x: c.x, y: c.y, z: c.z })));
const idxOfCorner = (c) => page.evaluate((c) => { const ms = window.__catan3d.state.gameState.mapState.tileCornerStates; for (const [i, t] of Object.entries(ms)) if (t.x === c.x && t.y === c.y && t.z === c.z) return Number(i); return -1; }, c);
const legalRoads = (fromCorner) => page.evaluate((fc) => window.__catan3d.legalRoads({ setup: true, fromCorner: fc }).map((e) => ({ x: e.x, y: e.y, z: e.z })), fromCorner);
const idxOfEdge = (e) => page.evaluate((e) => { const ms = window.__catan3d.state.gameState.mapState.tileEdgeStates; for (const [i, t] of Object.entries(ms)) if (t.x === e.x && t.y === e.y && t.z === e.z) return Number(i); return -1; }, e);
const send = (action, payload) => page.evaluate(({ a, p }) => window.__catan3d.sendGameAction(a, p), { a: action, p: payload });
const outSince = (t) => page.evaluate((t) => window.__catan3d.outActionsSince(t), t);

const myPieces = () => page.evaluate(() => { const ms = window.__catan3d.state.gameState.mapState, us = window.__catan3d.state.us; return { s: Object.values(ms.tileCornerStates).filter((c) => c.owner === us).length, r: Object.values(ms.tileEdgeStates).filter((e) => e.owner === us).length }; });

// Pick the settlement corner touching the most high-pip hexes (6/8/5/9) for max production.
const bestSettle = () => page.evaluate(() => {
  const gs = window.__catan3d.state.gameState, ms = gs.mapState;
  const legal = window.__catan3d.legalSettlements({ setup: true });
  const hexAt = {}; for (const h of Object.values(ms.tileHexStates)) hexAt[h.x + "," + h.y] = h;
  const pip = (n) => (n === 0 ? 0 : 6 - Math.abs(7 - n));
  const cornerHexes = (x, y, z) => { const out = [{ x, y }]; if (z === 0) out.push({ x, y: y - 1 }, { x: x + 1, y: y - 1 }); else out.push({ x: x - 1, y: y + 1 }, { x, y: y + 1 }); return out; };
  let best = null, bestScore = -1;
  for (const c of legal) {
    let sc = 0; for (const h of cornerHexes(c.x, c.y, c.z)) { const hex = hexAt[h.x + "," + h.y]; if (hex && hex.type !== 0) sc += pip(hex.diceNumber); }
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  return best ? { c: best, score: bestScore } : null;
});

// ---- play the opening via direct-send (based on OUR piece counts, not global 'completed') ----
async function playSetup() {
  for (let step = 0; step < 40; step++) {
    const c = await core(); if (!c) { await sleep(800); continue; }
    const p = await myPieces();
    if (p.s >= 2 && p.r >= 2) { log("setup complete (2 settlements + 2 roads)"); return true; }
    if (!c.yourTurn) { await sleep(700); continue; }
    if (c.turnState === 0 && c.actionState === 1) {
      const b = await bestSettle(); if (!b) { await sleep(600); continue; }
      const idx = await idxOfCorner(b.c);
      if (idx >= 0) { const r = await send(15, idx); log(`setup settlement @${idx} (pip ${b.score})`, JSON.stringify(r).slice(0, 50)); await sleep(1400); }
    } else if (c.actionState === 3) {
      const mine = await page.evaluate(() => { const ms = window.__catan3d.state.gameState.mapState.tileCornerStates, us = window.__catan3d.state.us; const own = Object.values(ms).filter((c) => c.owner === us); return own.length ? own[own.length - 1] : null; });
      const roads = await legalRoads(mine); if (!roads.length) { await sleep(600); continue; }
      const idx = await idxOfEdge(roads[0]);
      if (idx >= 0) { const r = await send(11, idx); log(`setup road @${idx}`, JSON.stringify(r).slice(0, 50)); await sleep(1400); }
    } else await sleep(700);
  }
  return false;
}

log("playing setup…");
await playSetup();
log("setup done; entering main-phase grind for a dev buy");

// ---- main phase: roll, and buy a dev the moment affordable ----
const DEV_CANDS = [46, 21, 24, 22, 44, 45, 48, 12, 13];  // candidate buy-dev action ids to probe
let BUY_DEV = null;
for (let turn = 0; turn < 200 && !BUY_DEV; turn++) {
  const c = await core(); if (!c) { await sleep(800); continue; }
  if (!c.yourTurn) { await sleep(700); continue; }
  if (c.turnState !== 0 && c.actionState === 0) { await page.keyboard.press("Space").catch(() => {}); await sleep(1300); }
  const j = await core();
  if (j && j.yourTurn && j.turnState !== 0) {
    const canBuy = (j.hand[3] || 0) >= 1 && (j.hand[4] || 0) >= 1 && (j.hand[5] || 0) >= 1;
    if (canBuy) {
      log("affordable dev; probing candidates. hand=", JSON.stringify(j.hand));
      for (const cand of DEV_CANDS) {
        const before = j.devHand.length;
        const t0 = Date.now();
        const r = await send(cand, true);
        await sleep(1100);
        const k = await core();
        const grew = k && k.devHand.length > before;
        const outs = await outSince(t0);
        log(`  probe action ${cand}: sent=${JSON.stringify(r).slice(0, 40)} devHand ${before}->${k ? k.devHand.length : "?"} ${grew ? "  <<< BUY-DEV FOUND" : ""}`);
        if (grew) { BUY_DEV = cand; fs.writeFileSync(path.join(OUT, "buy-dev-result.json"), JSON.stringify({ BUY_DEV: cand, devHand: k.devHand, outFrames: outs }, null, 2)); break; }
      }
      if (!BUY_DEV) log("  none of the candidates grew the dev hand this turn; will retry next affordable turn");
    }
    // end turn
    await send(6, true); await sleep(900);
  }
  await sleep(500);
}

if (BUY_DEV) log("✅ BUY-DEV action id =", BUY_DEV);
else log("❌ did not find buy-dev (may never have afforded it). See below for all outgoing actions.");

const allOut = await page.evaluate(() => window.__catan3d.outActions.map((a) => ({ action: a.action, payload: a.payload })));
fs.writeFileSync(path.join(OUT, "all-outgoing.json"), JSON.stringify(allOut, null, 2));
log("all outgoing actions saved:", allOut.length, "frames");
// distinct action ids seen
const distinct = [...new Set(allOut.map((a) => a.action))].sort((a, b) => a - b);
log("distinct outgoing action ids:", distinct.join(", "));
await page.screenshot({ path: path.join(OUT, "dev-capture-final.png") }).catch(() => {});
await context.close();
