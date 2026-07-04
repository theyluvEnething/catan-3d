// Definitively find the city-build action by reaching city-affordable state fast (direct-send
// setup + build roads to burn wood/brick, keep wheat/ore), then:
//  (1) dump all build-toolbar buttons,
//  (2) enumerate a WIDE action-id range via direct-send against a legal city corner,
//  (3) if none work, click Colonist's real city button + the settlement and capture the frame.
import { launchClone } from "./parallel.js";
import { checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { decodeOutgoing } from "../extension/src/protocol/decode.js";
import path from "node:path";

const clone = Number(process.argv[2] ?? 70);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const to = (pr, ms, l) => Promise.race([pr, new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT " + l)), ms))]);

const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());
let tag = ""; const frames = [];
page.on("websocket", (ws) => ws.on("framesent", (f) => { const p = f.payload; if (!Buffer.isBuffer(p)) return; try { const d = decodeOutgoing(p); if (d.b0 === 3 && d.body && d.body.action != null && ![66, 6, 67, 68].includes(d.body.action)) frames.push({ action: d.body.action, payload: d.body.payload, tag }); } catch {} }));
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("FINDCITY not logged in"); await ctx.close(); process.exit(0); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 90 && !(await page.$("#game-canvas")); w++) { await sleep(1000); if (w === 45) await page.evaluate(() => { const b = document.querySelector("#mm-details-play-button, #mm-mode-card-button"); if (b) b.click(); }).catch(() => {}); }
log("in game");
const box = await (await page.$("#game-canvas")).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.42;
const ev = (fn, arg, l) => to(page.evaluate(fn, arg), 8000, l || "ev");
const core = () => ev(() => { const s = window.__catan3d.state; const ps = s.playerState(s.us) || {}; const raw = (ps.resourceCards && ps.resourceCards.cards) || []; const h = {}; for (const r of raw) h[r] = (h[r] || 0) + 1; return { completed: s.completedTurns, turn: s.currentTurnColor, us: s.us, turnState: s.turnState, hand: h, cities: window.__catan3d.legalCities().length, robber: s.robberTileIndex }; }, null, "core");
const prompt = () => ev(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase().slice(0, 30) : ""; }, null, "prompt");
let lastCorner = null;

const result = { cityAction: null, robberAction: null, buttons: null, notes: [] };

async function robberClick() { const rb = (await core()).robber; outer: for (let ring = 0.14; ring <= 1; ring += 0.12) for (let j = 0; j < 12; j++) { const a = (j / 12) * Math.PI * 2; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(140); if ((await core()).robber !== rb) break outer; } }

for (let i = 0; i < 500 && !result.cityAction; i++) {
  let c, p; try { c = await core(); p = await prompt(); } catch (e) { log("read timeout", e.message); continue; }
  const m = c.turn === c.us;
  if (c.completed < 8) {
    if (m && /place settlement/.test(p)) { const r = await ev(() => { const L = window.__catan3d.legalSettlements({ setup: true }); if (!L.length) return null; const i = L[0].i; window.__catan3d.buildSettlement(i); return window.__catan3d.state.gameState.mapState.tileCornerStates[i]; }, null, "ss"); lastCorner = r; await sleep(1100); }
    else if (m && /place road/.test(p)) { await ev((fc) => { const L = window.__catan3d.legalRoads({ setup: true, fromCorner: fc }); if (L.length) window.__catan3d.buildRoad(L[0].i); }, lastCorner, "sr"); await sleep(1100); }
    else await sleep(600);
    continue;
  }
  if (/move.*robber|place.*robber/.test(p) && m) {
    // try direct-send robber=3, else click
    const rb = c.robber; tag = "robber";
    await ev(() => { const L = window.__catan3d.legalRobberHexes(); if (L.length) window.__catan3d.sendGameAction(3, L[0].i); }, null, "rob3"); await sleep(900);
    if ((await core()).robber === rb) { await robberClick(); } else if (!result.robberAction) { result.robberAction = 3; log("robber=3 works (direct-send)"); }
    tag = ""; await sleep(400); continue;
  }
  if (/select player to rob|steal/.test(p) && m) { for (let j = 0; j < 8; j++) { await page.mouse.click(cx + Math.cos(j) * R * 0.16, cy + Math.sin(j) * R * 0.16); await sleep(160); if (!/select player|steal/.test(await prompt())) break; } continue; }
  if (m && c.turnState === 1) { await to(page.keyboard.press("Space"), 6000, "roll").catch(() => {}); await sleep(1200); continue; }
  if (m && c.turnState === 2) {
    const canCity = (c.hand[4] || 0) >= 2 && (c.hand[5] || 0) >= 3 && c.cities > 0;
    if (canCity) {
      const corner = await ev(() => { const L = window.__catan3d.legalCities(); return L.length ? L[0].i : null; }, null, "cc");
      if (!result.buttons) { result.buttons = await ev(() => [...document.querySelectorAll("button,[role=button],[class*=button],[id]")].map((e) => ({ id: e.id, cls: (e.className || "").toString().slice(0, 40), al: e.getAttribute("aria-label"), t: (e.innerText || "").trim().slice(0, 16) })).filter((b) => /city|upgrade|build/i.test((b.id || "") + (b.cls || "") + (b.al || "") + (b.t || ""))), null, "btns"); log("BUILD_BUTTONS", JSON.stringify(result.buttons)); }
      // (2) wide direct-send enumeration
      for (let act = 12; act <= 60 && !result.cityAction; act++) {
        if ([15, 11, 66, 6].includes(act)) continue;
        const before = await ev((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, corner, "bt0");
        await ev(({ act, i }) => window.__catan3d.sendGameAction(act, i), { act, i: corner }, "try");
        await sleep(500);
        const after = await ev((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, corner, "bt1");
        if (after === 2 && before !== 2) { result.cityAction = act; log("FOUND city action =", act); break; }
      }
      if (!result.cityAction) { log("wide enum failed; trying UI button + click"); tag = "cityUI"; await ev(() => { const b = [...document.querySelectorAll("button,[role=button],[class*=button],[id]")].find((e) => /city|upgrade/i.test((e.id || "") + (e.className || "") + (e.getAttribute("aria-label") || "") + (e.innerText || ""))); if (b) b.click(); }, null, "cbtn"); await sleep(400); for (let ring = 0.05; ring <= 0.65; ring += 0.05) { for (let j = 0; j < 16; j++) { const a = (j / 16) * Math.PI * 2; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(110); if (frames.some((f) => f.tag === "cityUI")) break; } if (frames.some((f) => f.tag === "cityUI")) break; } if (frames.some((f) => f.tag === "cityUI")) { result.cityAction = frames.find((f) => f.tag === "cityUI").action; log("FOUND city via UI =", result.cityAction, JSON.stringify(frames.filter((f) => f.tag === "cityUI"))); } tag = ""; }
    }
    await ev(() => window.__catan3d.sendGameAction(6, true), null, "end"); await sleep(900); continue;
  }
  await sleep(700);
}

console.log("FINDCITY_RESULT " + JSON.stringify(result));
try { await page.screenshot({ path: path.join(SHOTS_DIR, "find-city-final.png") }); } catch {}
try { await ctx.close(); } catch {}
process.exit(0);
