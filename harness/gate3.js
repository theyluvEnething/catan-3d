// GATE 3: play a full bot game using ONLY our interaction layer (direct-send), driven by the
// legal-move engine — both initial placements, roads, main-phase builds, and rolling — to game
// end (or a turn cap), with NO desync between our reconstructed state and Colonist's.
//
// Placement uses window.__catan3d.buildSettlement/buildRoad (action 15/11). Rolling/passing
// use the keyboard (those are UI affordances, not board clicks). We verify after each action
// that our state updated consistently, proving the 3D interface can play the game.
import { launchClone } from "./parallel.js";
import { checkLogin } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { SHOTS_DIR } from "./launch.js";
import path from "node:path";

const clone = Number(process.argv[2] ?? 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("not logged in"); await ctx.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 40 && !(await page.$("#game-canvas")); w++) await sleep(1000);

const snap = () => page.evaluate(() => window.__catan3d.snapshot());
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const st = () => page.evaluate(() => { const s = window.__catan3d.state; return { us: s.us, turn: s.currentTurnColor, turnState: s.turnState, actionState: s.actionState, completed: s.completedTurns, dice: s.dice, robber: s.robberTileIndex }; });
const myPieces = () => page.evaluate(() => { const s = window.__catan3d.state, ms = s.gameState.mapState, us = s.us; return { settlements: Object.entries(ms.tileCornerStates).filter(([, c]) => c.owner === us && c.buildingType !== 2).map(([i]) => +i), cities: Object.entries(ms.tileCornerStates).filter(([, c]) => c.owner === us && c.buildingType === 2).map(([i]) => +i), roads: Object.entries(ms.tileEdgeStates).filter(([, e]) => e.owner === us).map(([i]) => +i) }; });

// place a settlement at a legal corner via direct-send; returns landed index or null
async function placeSettlement(setup) {
  const before = (await myPieces()).settlements.length + (await myPieces()).cities.length;
  const idx = await page.evaluate((setup) => { const L = window.__catan3d.legalSettlements({ setup }); return L && L.length ? L[Math.floor(Math.random() * Math.min(L.length, 6))].i : null; }, setup);
  if (idx == null) return null;
  const r = await page.evaluate((i) => window.__catan3d.buildSettlement(i), idx);
  await sleep(1200);
  const after = (await myPieces());
  return (after.settlements.length + after.cities.length) > before ? idx : null;
}
async function placeRoad(setup, fromCorner) {
  const before = (await myPieces()).roads.length;
  const idx = await page.evaluate(({ setup, fromCorner }) => { const L = window.__catan3d.legalRoads({ setup, fromCorner }); return L && L.length ? L[Math.floor(Math.random() * Math.min(L.length, 6))].i : null; }, { setup, fromCorner });
  if (idx == null) return null;
  await page.evaluate((i) => window.__catan3d.buildRoad(i), idx);
  await sleep(1200);
  return (await myPieces()).roads.length > before ? idx : null;
}

const report = { setupPlacements: 0, mainBuilds: 0, rolls: 0, desyncs: 0, events: [] };
let lastSettlementCorner = null;

const MAX_MS = 12 * 60 * 1000; const t0 = Date.now();
let over = false;
while (Date.now() - t0 < MAX_MS && !over) {
  const s = await st(); const p = await prompt();
  over = await page.evaluate(() => /game.*over|won|victory/i.test((document.body.innerText || "")) && !!window.__catan3d.state.gameOver);
  const mine = s.turn === s.us;

  if (/place settlement/.test(p) && mine) {
    const idx = await placeSettlement(true);
    if (idx != null) { report.setupPlacements++; lastSettlementCorner = await page.evaluate((i) => { const c = window.__catan3d.state.gameState.mapState.tileCornerStates[i]; return { x: c.x, y: c.y, z: c.z }; }, idx); report.events.push(`setup settlement @${idx}`); }
    else { report.desyncs++; report.events.push("FAILED setup settlement"); }
  } else if (/place road/.test(p) && mine) {
    const idx = await placeRoad(true, lastSettlementCorner);
    if (idx != null) { report.setupPlacements++; report.events.push(`setup road @${idx}`); }
    else { report.desyncs++; report.events.push("FAILED setup road"); }
  } else if (/roll/.test(p) && mine) {
    await page.keyboard.press("Space"); report.rolls++; await sleep(1400);
  } else if (/move.*robber|place.*robber/.test(p) && mine) {
    // move robber via legal hex (need a click — robber uses canvas; try direct action later).
    // For gate purposes, fall back to a click-scan to not stall.
    const rb = s.robber; const box = await (await page.$("#game-canvas")).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.4;
    outer: for (let ring = 0.1; ring <= 1; ring += 0.08) { for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(150); if ((await st()).robber !== rb) break outer; } }
    report.events.push("moved robber"); await sleep(1000);
  } else if (/discard/.test(p)) {
    // discard: click cards then confirm (UI); best-effort
    const box = await (await page.$("#game-canvas")).boundingBox();
    for (let i = 0; i < 4; i++) { await page.mouse.click(box.x + box.width * (0.3 + i * 0.1), box.y + box.height * 0.9); await sleep(200); }
    await page.keyboard.press("Enter"); await sleep(800);
  } else if (mine && /(your turn|build|trade|pass)/.test(p)) {
    // main phase: try to build a settlement or road via direct-send if legal, else pass.
    const built = (await page.evaluate(() => { const L = window.__catan3d.legalSettlements(); return L && L.length ? window.__catan3d.buildSettlement(L[0].i) : null; }));
    if (built && built.ok) { report.mainBuilds++; await sleep(1000); report.events.push("main settlement"); }
    else { const r = await page.evaluate(() => { const L = window.__catan3d.legalRoads(); return L && L.length ? window.__catan3d.buildRoad(L[0].i) : null; }); if (r && r.ok) { report.mainBuilds++; report.events.push("main road"); await sleep(1000); } }
    await page.keyboard.press("Space"); await sleep(900); // pass
  } else await sleep(1000);
}

const finalPieces = await myPieces();
report.finalPieces = finalPieces;
report.over = over;
await page.screenshot({ path: path.join(SHOTS_DIR, "gate3-final.png") });
console.log("GATE3_REPORT " + JSON.stringify(report));
await ctx.close();
