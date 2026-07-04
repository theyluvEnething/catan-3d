// Capture the outgoing game-channel action id + payload for a specific game action, by
// driving it with REAL trusted clicks in an isolated cloned-profile game and diffing the
// outgoing frames. Usage:
//   node harness/capture-action.js <which> <cloneIndex>
// where <which> ∈ roll|pass|city|robber|steal|discard|buydev|knight|roadbuilding|
//                 yearofplenty|monopoly|banktrade|accepttrade|rejecttrade
// Prints a JSON line: {which, actions:[{action,payload}...], notes}
import { launchClone } from "./parallel.js";
import { checkLogin } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { decodeOutgoing } from "../extension/src/protocol/decode.js";

const which = process.argv[2] || "roll";
const clone = Number(process.argv[3] || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());

// collect non-hover game commits
const commits = [];
page.on("websocket", (ws) => ws.on("framesent", (f) => {
  const p = f.payload; if (!Buffer.isBuffer(p)) return;
  try { const d = decodeOutgoing(p); if (d.b0 === 3 && d.body && d.body.action != null && d.body.action !== 66) commits.push({ action: d.body.action, payload: d.body.payload }); } catch {}
}));

const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log(JSON.stringify({ which, error: "not logged in" })); await ctx.close(); process.exit(0); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);

// The board canvas (#game-canvas, WebGL2) may not have mounted yet when startBotGame
// returns; poll for it (up to ~40s) instead of dereferencing null immediately.
let canvasEl = await page.$("#game-canvas");
for (let w = 0; w < 40 && !canvasEl; w++) { await sleep(1000); canvasEl = await page.$("#game-canvas"); }
if (!canvasEl) { console.log(JSON.stringify({ which, clone, actions: [], notes: "game-canvas never mounted" })); await ctx.close(); process.exit(0); }
const box = await canvasEl.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.46;
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const snap = () => page.evaluate(() => window.__catan3d.snapshot());
const ownedCount = () => page.evaluate(() => { const s = window.__catan3d.state, ms = s.gameState.mapState; const us = s.us; return Object.values(ms.tileCornerStates).filter((c) => c.owner === us).length + Object.values(ms.tileEdgeStates).filter((e) => e.owner === us).length; });
const clickScan = async (predicate, { ring0 = 0.06, ring1 = 1, step = 0.04 } = {}) => { for (let ring = ring0; ring <= ring1; ring += step) { const n = Math.max(8, Math.round(ring * 52)); for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + ring; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(150); if (await predicate()) return true; } } return false; };
const usColor = await page.evaluate(() => window.__catan3d.state.us);
const isMyTurn = async () => (await page.evaluate(() => window.__catan3d.state.currentTurnColor)) === usColor;

// Play through setup using direct-send (fast + reliable) so we reach main game quickly.
async function completeSetupViaDirectSend() {
  for (let guard = 0; guard < 40; guard++) {
    const s = await snap();
    if ((s.completedTurns ?? 0) >= 8) return;
    const p = await prompt();
    if (/place settlement/.test(p) && await isMyTurn()) {
      const legal = await page.evaluate(() => { const L = window.__catan3d.legalSettlementCorners ? window.__catan3d.legalSettlementCorners() : null; return L; });
      // fallback: click-scan settlement then road
      const b = await ownedCount(); await clickScan(async () => (await ownedCount()) > b);
      const b2 = await ownedCount(); await clickScan(async () => (await ownedCount()) > b2, { ring0: 0.03, ring1: 0.14, step: 0.02 });
    } else if (/place road/.test(p) && await isMyTurn()) {
      const b = await ownedCount(); await clickScan(async () => (await ownedCount()) > b, { ring0: 0.03, ring1: 0.2, step: 0.02 });
    } else await sleep(900);
  }
}

const before = commits.length;
let notes = "";
try {
  if (which === "roll") {
    // wait for our main-phase turn, then roll
    for (let w = 0; w < 60; w++) { if (await isMyTurn() && /roll/.test(await prompt())) break; await sleep(1000); if ((await snap()).completedTurns < 8) await completeSetupViaDirectSend(); }
    await page.keyboard.press("Space"); await sleep(1500);
  } else {
    await completeSetupViaDirectSend();
    // now in main game; act depending on `which`
    for (let w = 0; w < 90; w++) {
      const p = await prompt(); const mine = await isMyTurn();
      if (which === "pass" && mine && /(trade|build|pass|your turn)/.test(p)) { await page.keyboard.press("Space"); await sleep(600); await page.keyboard.press("Space"); await sleep(800); break; }
      if (which === "city" && mine) { /* click city button then our settlement */ const btn = await page.$('[class*="city" i], [aria-label*="city" i]'); if (btn) { await btn.click(); await sleep(300); } const b = await ownedCount(); await clickScan(async () => (await page.evaluate(() => { const s = window.__catan3d.state; return Object.values(s.gameState.mapState.tileCornerStates).some((c) => c.owner === s.us && c.buildingType === 2); }))); break; }
      if (which === "robber" || which === "steal") { if (/move.*robber|place.*robber/.test(p)) { const rb = (await snap()).robber; await clickScan(async () => (await snap()).robber !== rb); await sleep(800); if (which === "steal") { /* a steal target selection may appear */ await clickScan(async () => (await prompt()) === "" , { ring0: 0.02, ring1: 0.3, step: 0.05 }); } break; } if (mine && /roll/.test(p)) { await page.keyboard.press("Space"); await sleep(1200); } else await sleep(800); }
      if (which === "discard") { if (/discard/.test(p)) { await clickScan(async () => !/discard/.test(await prompt()), { ring0: 0.5, ring1: 1.2, step: 0.1 }); break; } if (mine && /roll/.test(p)) { await page.keyboard.press("Space"); await sleep(1200); } else await sleep(800); }
      if (which === "buydev" && mine) { const btn = await page.$('[class*="devcard" i],[class*="buy" i],[aria-label*="development" i]'); if (btn) { await btn.click(); await sleep(800); } break; }
      if (!mine) await sleep(800); else await sleep(600);
    }
  }
} catch (e) { notes = "err:" + (e.message || e); }
await sleep(800);
const captured = commits.slice(before);
console.log(JSON.stringify({ which, clone, actions: captured, notes }));
await ctx.close();
