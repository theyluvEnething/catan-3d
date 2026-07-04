// Fast verification of main-phase primitives with per-call timeouts (no hangs):
//   1. city via action 19 (when affordable)
//   2. bank-trade action (enumerate): give 4 of our most-common resource, get 1 ore — detect
//      by hand change, to guarantee city affordability later.
// Reports which work. Uses direct-send throughout.
import { launchClone } from "./parallel.js";
import { checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import path from "node:path";

const clone = Number(process.argv[2] ?? 74);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const to = (pr, ms, l) => Promise.race([pr, new Promise((_, r) => setTimeout(() => r(new Error("TO " + l)), ms))]);
const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("VP not logged in"); await ctx.close(); process.exit(0); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 90 && !(await page.$("#game-canvas")); w++) { await sleep(1000); if (w === 45) await page.evaluate(() => { const b = document.querySelector("#mm-details-play-button, #mm-mode-card-button"); if (b) b.click(); }).catch(() => {}); }
log("in game");
const ev = (fn, arg, l) => to(page.evaluate(fn, arg), 8000, l || "ev");
const core = () => ev(() => { const s = window.__catan3d.state; const ps = s.playerState(s.us) || {}; const raw = (ps.resourceCards && ps.resourceCards.cards) || []; const h = {}; for (const r of raw) h[r] = (h[r] || 0) + 1; return { completed: s.completedTurns, turn: s.currentTurnColor, us: s.us, turnState: s.turnState, hand: h, handSize: raw.length, cities: window.__catan3d.legalCities().length, robber: s.robberTileIndex }; }, null, "core");
const prompt = () => ev(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase().slice(0, 30) : ""; }, null, "prompt");
let lastCorner = null;
const res = { city19: null, bankTrade: null, notes: [] };

for (let i = 0; i < 500 && (res.city19 === null || res.bankTrade === null); i++) {
  let c, p; try { c = await core(); p = await prompt(); } catch { continue; }
  const m = c.turn === c.us;
  if (c.completed < 8) {
    if (m && /place settlement/.test(p)) { const r = await ev(() => { const L = window.__catan3d.legalSettlements({ setup: true }); if (!L.length) return null; const i = L[0].i; window.__catan3d.buildSettlement(i); return window.__catan3d.state.gameState.mapState.tileCornerStates[i]; }); lastCorner = r; await sleep(1100); }
    else if (m && /place road/.test(p)) { await ev((fc) => { const L = window.__catan3d.legalRoads({ setup: true, fromCorner: fc }); if (L.length) window.__catan3d.buildRoad(L[0].i); }, lastCorner); await sleep(1100); }
    else await sleep(600);
    continue;
  }
  if (/move.*robber|place.*robber/.test(p) && m) { await ev(() => { const L = window.__catan3d.legalRobberHexes(); if (L.length) window.__catan3d.sendGameAction(3, L[0].i); }); await sleep(900); if (res.notes.indexOf("robber3ok") < 0 && (await core()).robber !== c.robber) res.notes.push("robber3ok"); continue; }
  if (/select player to rob|steal/.test(p) && m) { await page.keyboard.press("Escape").catch(() => {}); await sleep(400); continue; }
  if (m && c.turnState === 1) { await to(page.keyboard.press("Space"), 6000, "roll").catch(() => {}); await sleep(1200); continue; }
  if (m && c.turnState === 2) {
    // BANK TRADE enumeration: if we have >=4 of some resource and lack ore, try giving 4 for ore.
    if (res.bankTrade === null) {
      const give = Object.entries(c.hand).find(([r, n]) => n >= 4);
      if (give) {
        const g = Number(give[0]); const want = 5; // ore
        for (const act of [50, 51, 52, 53, 48, 49, 54, 30, 31, 44, 45]) {
          const before = (await core()).hand;
          // payload guess: {give:g, get:want} or [g,want]; try object then array
          await ev(({ act, g, want }) => window.__catan3d.sendGameAction(act, { give: g, receive: want }), { act, g, want }, "bt1").catch(() => {});
          await sleep(700);
          let after = (await core()).hand;
          if ((after[want] || 0) > (before[want] || 0) && (after[g] || 0) < (before[g] || 0)) { res.bankTrade = { action: act, payload: "{give,receive}" }; log("BANK TRADE found", act, "obj"); break; }
          await ev(({ act, g, want }) => window.__catan3d.sendGameAction(act, [g, want]), { act, g, want }, "bt2").catch(() => {});
          await sleep(700);
          after = (await core()).hand;
          if ((after[want] || 0) > (before[want] || 0) && (after[g] || 0) < (before[g] || 0)) { res.bankTrade = { action: act, payload: "[give,receive]" }; log("BANK TRADE found", act, "array"); break; }
        }
        if (res.bankTrade === null) { res.bankTrade = false; res.notes.push("bankTrade not found in candidate set"); }
      }
    }
    // CITY via 19
    if (res.city19 === null) {
      const canCity = (c.hand[4] || 0) >= 2 && (c.hand[5] || 0) >= 3 && c.cities > 0;
      if (canCity) {
        const corner = await ev(() => { const L = window.__catan3d.legalCities(); return L.length ? L[0].i : null; });
        const before = await ev((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, corner);
        await ev(({ i }) => window.__catan3d.sendGameAction(19, i), { i: corner });
        await sleep(900);
        const after = await ev((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, corner);
        res.city19 = (after === 2 && before !== 2);
        log("CITY via 19:", res.city19 ? "WORKS" : "failed", "corner", corner);
      }
    }
    await ev(() => window.__catan3d.sendGameAction(6, true)); await sleep(900); continue;
  }
  await sleep(700);
}
console.log("VERIFY_PRIMITIVES " + JSON.stringify(res));
try { await page.screenshot({ path: path.join(SHOTS_DIR, "verify-primitives.png") }); } catch {}
try { await ctx.close(); } catch {}
process.exit(0);
