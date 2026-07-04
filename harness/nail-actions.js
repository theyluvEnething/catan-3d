// Reliably isolate city + buydev + robber action ids via direct-send probing.
//  - Setup via direct-send (proven).
//  - Farm turns (roll + pass) until we can afford a CITY (>=2 wheat, 3 ore) and own a
//    settlement; then try candidate city action ids and detect buildingType->2.
//  - When we can afford a DEV CARD (1 wheat,1 ore,1 sheep); try candidate ids, detect dev
//    card count / bank change.
//  - On a 7 -> probe robber ids, detect robberTileIndex change.
// Reports only ids that provably worked. One game, low resource.
import { launchClone } from "./parallel.js";
import { checkLogin, SHOTS_DIR } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import path from "node:path";

const clone = Number(process.argv[2] ?? 52);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { ctx } = await launchClone(clone);
const page = ctx.pages()[0] || (await ctx.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("NAIL not logged in"); await ctx.close(); process.exit(0); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);
for (let w = 0; w < 40 && !(await page.$("#game-canvas")); w++) await sleep(1000);

const S = () => page.evaluate(() => { const s = window.__catan3d.state; return { us: s.us, turn: s.currentTurnColor, completed: s.completedTurns, robber: s.robberTileIndex }; });
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const mine = async () => (await S()).turn === (await S()).us;
const myRes = () => page.evaluate(() => { const s = window.__catan3d.state; const ps = s.playerState ? s.playerState(s.us) : null; const rc = ps && (ps.resourceCards || ps.resourceCardsState); return rc ? (rc.cards || rc) : null; });

let lastCorner = null;
async function setup() {
  for (let g = 0; g < 40; g++) {
    const s = await S(); if (s.completed >= 8) return true;
    const p = await prompt(); const m = s.turn === s.us;
    if (/place settlement/.test(p) && m) { const r = await page.evaluate(() => { const L = window.__catan3d.legalSettlements({ setup: true }); if (!L.length) return null; const i = L[0].i; window.__catan3d.buildSettlement(i); return window.__catan3d.state.gameState.mapState.tileCornerStates[i]; }); lastCorner = r; await sleep(1300); }
    else if (/place road/.test(p) && m) { await page.evaluate((fc) => { const L = window.__catan3d.legalRoads({ setup: true, fromCorner: fc }); if (L.length) window.__catan3d.buildRoad(L[0].i); }, lastCorner); await sleep(1300); }
    else await sleep(700);
  }
  return false;
}

const out = { city: null, buydev: null, robber: null, notes: [] };
const CITY = [28, 47, 27, 17, 12];
const DEV = [21, 24, 22, 46];
const ROB = [3, 16, 25, 24];

async function tryCands(cands, detect, getIndex) {
  for (const cand of cands) {
    const idx = await getIndex();
    const before = await detect();
    await page.evaluate(({ cand, idx }) => window.__catan3d.sendGameAction(cand, idx), { cand, idx });
    await sleep(1000);
    const after = await detect();
    if (after.changed(before)) return { cand, idx };
  }
  return null;
}

try {
  await setup();
  out.notes.push("setup done");

  const t0 = Date.now();
  while (Date.now() - t0 < 9 * 60 * 1000 && (!out.city || !out.buydev || !out.robber)) {
    const s = await S(); const p = await prompt(); const m = s.turn === s.us;

    if (/move.*robber|place.*robber/.test(p) && !out.robber) {
      const rb = s.robber;
      for (const cand of ROB) { const hex = await page.evaluate(() => { const L = window.__catan3d.legalRobberHexes(); return L.length ? L[0].i : null; }); await page.evaluate(({ cand, hex }) => window.__catan3d.sendGameAction(cand, hex), { cand, hex }); await sleep(900); if ((await S()).robber !== rb) { out.robber = cand; out.notes.push(`robber=${cand}`); break; } }
      // clear any steal picker
      await page.keyboard.press("Escape"); await sleep(500);
      continue;
    }
    if (/discard/.test(p)) { await page.evaluate(() => { for (let k = 0; k < 4; k++) window.__catan3d.sendGameAction(2, true); }); await sleep(800); continue; }

    if (m && /roll/.test(p)) { await page.keyboard.press("Space"); await sleep(1300); continue; }

    if (m && /(your turn|build|trade|pass)/.test(p)) {
      // CITY probe
      if (!out.city) {
        const cityCorner = await page.evaluate(() => { const L = window.__catan3d.legalCities(); return L.length ? L[0].i : null; });
        if (cityCorner != null) {
          for (const cand of CITY) {
            const before = await page.evaluate((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, cityCorner);
            await page.evaluate(({ cand, i }) => window.__catan3d.sendGameAction(cand, i), { cand, i: cityCorner });
            await sleep(1000);
            const after = await page.evaluate((i) => window.__catan3d.state.gameState.mapState.tileCornerStates[i].buildingType, cityCorner);
            if (after === 2 && before !== 2) { out.city = cand; out.notes.push(`city=${cand} (corner ${cityCorner})`); break; }
          }
        }
      }
      // DEV CARD probe (detect via total dev card count growth)
      if (!out.buydev) {
        const devCount = () => page.evaluate(() => { try { const s = window.__catan3d.state; const ps = s.playerState(s.us); const d = ps.developmentCards || ps.developmentCardsState || {}; return Object.values(d).reduce((a, x) => a + (typeof x === "number" ? x : 0), 0); } catch { return 0; } });
        for (const cand of DEV) { const before = await devCount(); await page.evaluate((cand) => window.__catan3d.sendGameAction(cand, true), cand); await sleep(1000); const after = await devCount(); if (after > before) { out.buydev = cand; out.notes.push(`buydev=${cand}`); break; } }
      }
      await page.keyboard.press("Space"); await sleep(900);
    } else await sleep(900);
  }
} catch (e) { out.notes.push("err:" + (e && e.message || e)); }

console.log("NAIL_RESULT " + JSON.stringify(out));
try { await page.screenshot({ path: path.join(SHOTS_DIR, "nail-actions-final.png") }); } catch {}
try { await ctx.close(); } catch {}
process.exit(0);
