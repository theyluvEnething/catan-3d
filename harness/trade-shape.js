// Capture the exact TRADE payload shape from incoming type-43 frames (bots trade constantly),
// so we can construct an OUTGOING create-trade/bank-trade frame directly (bypassing the fragile
// trade-creator UI). Logs every distinct type-43 body + hunts for a matching OUTGOING action.
import { launchClone } from "./parallel.js";
import { checkLogin } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { decodeFrame, decodeOutgoing } from "../extension/src/protocol/decode.js";

const clone = Number(process.argv[2] ?? 92);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const to = (pr, ms, l) => Promise.race([pr, new Promise((_, r) => setTimeout(() => r(new Error("TO")), ms))]);

const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());
const seenIn = new Map();   // signature -> sample body
const outSeen = new Map();  // action -> sample payload
page.on("websocket", (ws) => {
  ws.on("framereceived", (f) => { const p = f.payload; if (!Buffer.isBuffer(p)) return; try { const d = decodeFrame({ dir: "in", kind: "binary", bytes: new Uint8Array(p) }); const body = d && d.payload; if (body && (body.givingCards || body.receivingCards || body.offeredResources || body.wantedResources || d.type === 43)) { const sig = "t" + d.type + ":" + Object.keys(body).sort().join(","); if (!seenIn.has(sig)) { seenIn.set(sig, { type: d.type, body }); log("IN type", d.type, JSON.stringify(body).slice(0, 260)); } } } catch {} });
  ws.on("framesent", (f) => { const p = f.payload; if (!Buffer.isBuffer(p)) return; try { const d = decodeOutgoing(p); if (d.b0 === 3 && d.body && d.body.action != null && ![66, 6, 67, 47, 15, 11, 19, 3, 2].includes(d.body.action)) { if (!outSeen.has(d.body.action)) { outSeen.set(d.body.action, d.body.payload); log("OUT action", d.body.action, "payload", JSON.stringify(d.body.payload).slice(0, 200)); } } } catch {} });
});

const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("TSHAPE not logged in"); await ctx.close(); process.exit(0); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 90 && !(await page.$("#game-canvas")); w++) { await sleep(1000); if (w === 45) await page.evaluate(() => { const b = document.querySelector("#mm-details-play-button, #mm-mode-card-button"); if (b) b.click(); }).catch(() => {}); }
log("in game — observing trades (we just play setup then pass, bots trade)");
const ev = (fn, arg) => to(page.evaluate(fn, arg), 8000);
const core = () => ev(() => { const s = window.__catan3d.state; return { completed: s.completedTurns, turn: s.currentTurnColor, us: s.us, turnState: s.turnState, robber: s.robberTileIndex }; });
const prompt = () => ev(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase().slice(0, 30) : ""; });
let lastCorner = null;
const t0 = Date.now();
while (Date.now() - t0 < 8 * 60 * 1000) {
  let c, p; try { c = await core(); p = await prompt(); } catch { continue; }
  const m = c.turn === c.us;
  if (c.completed < 8) {
    if (m && /place settlement/.test(p)) { const r = await ev(() => { const L = window.__catan3d.legalSettlements({ setup: true }); if (!L.length) return null; const i = L[0].i; window.__catan3d.buildSettlement(i); return window.__catan3d.state.gameState.mapState.tileCornerStates[i]; }); lastCorner = r; await sleep(1100); }
    else if (m && /place road/.test(p)) { await ev((fc) => { const L = window.__catan3d.legalRoads({ setup: true, fromCorner: fc }); if (L.length) window.__catan3d.buildRoad(L[0].i); }, lastCorner); await sleep(1100); }
    else await sleep(700);
    continue;
  }
  if (/move.*robber|place.*robber/.test(p) && m) { await ev(() => { const L = window.__catan3d.legalRobberHexes(); if (L.length) window.__catan3d.sendGameAction(3, L[0].i); }); await sleep(900); continue; }
  if (/select player to rob|steal/.test(p) && m) { await page.keyboard.press("Escape").catch(() => {}); await sleep(400); continue; }
  if (m && c.turnState === 1) { await to(page.keyboard.press("Space"), 6000).catch(() => {}); await sleep(1200); continue; }
  if (m && c.turnState === 2) { await ev(() => window.__catan3d.sendGameAction(6, true)); await sleep(900); continue; }
  await sleep(800);
}
console.log("TRADE_SHAPES " + JSON.stringify([...seenIn.values()]).slice(0, 2000));
console.log("OUT_ACTIONS " + JSON.stringify([...outSeen.entries()]));
try { await ctx.close(); } catch {}
process.exit(0);
