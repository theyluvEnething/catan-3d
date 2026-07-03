// Phase-3 calibration v4 — EXACT pairs, no matching ambiguity.
//
// Each time WE place a settlement, exactly one new blob of OUR color appears. We know the
// corner (from state) and can locate that single blob precisely -> an exact (cornerBoardXY ->
// pixel) pair. We place both setup settlements + (if needed) probe more, accumulate >=3 exact
// pairs, and fit a full affine. No ICP, no mismatches. Saves debug/calibration.json (final).
import { launch, checkLogin, SHOTS_DIR, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { cornerPosExact } from "../extension/src/render/boardGeometry.js";
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const US_RGB_CANDIDATES = { 1: [210, 60, 60], 2: [60, 116, 210], 3: [224, 132, 46], 11: [138, 79, 208] };

function fitAffine(pairs) {
  const n = pairs.length; let SXX = 0, SYY = 0, SXY = 0, SX = 0, SY = 0, SxpX = 0, SxpY = 0, Sxp = 0, SypX = 0, SypY = 0, Syp = 0;
  for (const { X, Y, px, py } of pairs) { SXX += X * X; SYY += Y * Y; SXY += X * Y; SX += X; SY += Y; SxpX += px * X; SxpY += px * Y; Sxp += px; SypX += py * X; SypY += py * Y; Syp += py; }
  const M = [[SXX, SXY, SX], [SXY, SYY, SY], [SX, SY, n]];
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const solve = (rhs) => { const D = det3(M); const col = (i) => M.map((r, ri) => r.map((v, ci) => ci === i ? rhs[ri] : v)); return [det3(col(0)) / D, det3(col(1)) / D, det3(col(2)) / D]; };
  const [a, b, tx] = solve([SxpX, SxpY, Sxp]); const [c, d, ty] = solve([SypX, SypY, Syp]);
  return { a, b, tx, c, d, ty };
}
const project = (aff, X, Y) => [aff.a * X + aff.b * Y + aff.tx, aff.c * X + aff.d * Y + aff.ty];

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.error("not logged in"); await context.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);

const box = await (await page.$("#game-canvas")).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.46;
const usColor = await page.evaluate(() => window.__catan3d.state.us);
const RGB = US_RGB_CANDIDATES[usColor] || [138, 79, 208];
console.log("us color:", usColor, "rgb", RGB);

const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const ownedCorners = () => page.evaluate((us) => { const cs = window.__catan3d.state.gameState.mapState.tileCornerStates; return Object.entries(cs).filter(([, c]) => c.owner === us).map(([i, c]) => ({ i: Number(i), x: c.x, y: c.y, z: c.z })); }, usColor);
const ownedEdges = () => page.evaluate((us) => { const es = window.__catan3d.state.gameState.mapState.tileEdgeStates; return Object.entries(es).filter(([, e]) => e.owner === us).map(([i]) => Number(i)); }, usColor);

// Find the centroid of OUR color pixels within a search window, from a fresh canvas screenshot.
async function myBlobNear(exclX = [], expectPx = null) {
  const buf = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  const png = PNG.sync.read(buf); const W = png.width, Hh = png.height;
  const pts = [];
  for (let y = 0; y < Hh; y += 1) for (let x = 0; x < W * 0.66; x += 1) {
    const i = (y * W + x) * 4; const d = Math.hypot(png.data[i] - RGB[0], png.data[i + 1] - RGB[1], png.data[i + 2] - RGB[2]);
    if (d < 55) pts.push([x, y]);
  }
  if (!pts.length) return null;
  // cluster; return the cluster farthest from excluded previous positions (i.e., the NEW one)
  const cell = 26; const grid = new Map();
  for (const [x, y] of pts) { const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`; let c = grid.get(k); if (!c) { c = [0, 0, 0]; grid.set(k, c); } c[0] += x; c[1] += y; c[2]++; }
  let clusters = [...grid.values()].filter((c) => c[2] >= 15).map((c) => [c[0] / c[2], c[1] / c[2], c[2]]);
  // merge nearby
  const merged = [];
  for (const c of clusters.sort((a, b) => b[2] - a[2])) if (!merged.some((m) => Math.hypot(m[0] - c[0], m[1] - c[1]) < 30)) merged.push(c);
  // pick cluster not near excluded
  let cand = merged.filter((c) => !exclX.some((e) => Math.hypot(c[0] - e[0], c[1] - e[1]) < 34));
  if (!cand.length) cand = merged;
  cand.sort((a, b) => b[2] - a[2]);
  return cand[0] ? [cand[0][0] + box.x, cand[0][1] + box.y] : null;
}

const pairs = [];
const prevBlobs = [];
// place both setup settlements, recording an exact pair each time
for (let round = 0; round < 4 && pairs.length < 3; round++) {
  let ok = false; for (let w = 0; w < 60; w++) { if (/place settlement/.test(await prompt())) { ok = true; break; } await sleep(1000); }
  if (!ok) break;
  const before = (await ownedCorners()).map((c) => c.i);
  let landed = null;
  scan: for (let ring = 0.1; ring <= 1; ring += 0.05) { const n = Math.max(8, Math.round(ring * 48)); for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(280); const now = await ownedCorners(); const fresh = now.find((c) => !before.includes(c.i)); if (fresh) { landed = fresh; break scan; } } }
  if (!landed) break;
  await sleep(700);
  const blob = await myBlobNear(prevBlobs);
  if (blob) {
    const { u, v } = cornerPosExact(landed.x, landed.y, landed.z);
    pairs.push({ X: u, Y: v, px: blob[0], py: blob[1], corner: landed.i });
    prevBlobs.push([blob[0] - box.x, blob[1] - box.y]);
    console.log(`PAIR ${pairs.length}: corner${landed.i}(${landed.x},${landed.y},${landed.z}) board(${u.toFixed(2)},${v.toFixed(2)}) -> px(${blob[0].toFixed(0)},${blob[1].toFixed(0)})`);
  }
  // place a road to advance
  for (let w = 0; w < 20; w++) { if (/place road/.test(await prompt())) break; await sleep(500); }
  const beforeE = await ownedEdges();
  road: for (let rr = 0.03; rr <= 0.14; rr += 0.02) { for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; await page.mouse.click(blob ? blob[0] + Math.cos(a) * R * rr : cx, blob ? blob[1] + Math.sin(a) * R * rr : cy); await sleep(250); if ((await ownedEdges()).some((e) => !beforeE.includes(e))) break road; } }
  await sleep(1500);
}

console.log("exact pairs:", pairs.length);
if (pairs.length >= 3) {
  const aff = fitAffine(pairs);
  let err = 0; for (const p of pairs) { const [px, py] = project(aff, p.X, p.Y); err += Math.hypot(px - p.px, py - p.py); }
  console.log("AFFINE:", JSON.stringify(aff), "meanErr", (err / pairs.length).toFixed(1));
  fs.writeFileSync(path.join(ROOT, "debug", "calibration.json"), JSON.stringify({ affine: aff, box, meanErr: err / pairs.length, nPairs: pairs.length, method: "exact-blobs" }, null, 2));
  console.log("wrote debug/calibration.json");
} else if (pairs.length === 2) {
  // fit similarity from 2 exact pairs (uniform scale + rotation + translation)
  const [p, q] = pairs;
  const bdx = q.X - p.X, bdy = q.Y - p.Y, pdx = q.px - p.px, pdy = q.py - p.py;
  const s = Math.hypot(pdx, pdy) / Math.hypot(bdx, bdy);
  const th = Math.atan2(pdy, pdx) - Math.atan2(bdy, bdx);
  const a = Math.cos(th) * s, b = -Math.sin(th) * s, c = Math.sin(th) * s, d = Math.cos(th) * s;
  const tx = p.px - (a * p.X + b * p.Y), ty = p.py - (c * p.X + d * p.Y);
  const aff = { a, b, tx, c, d, ty };
  console.log("SIMILARITY(2pt):", JSON.stringify(aff));
  fs.writeFileSync(path.join(ROOT, "debug", "calibration.json"), JSON.stringify({ affine: aff, box, nPairs: 2, method: "similarity-2pt" }, null, 2));
  console.log("wrote debug/calibration.json (2-pt similarity)");
} else {
  console.log("insufficient pairs");
}
await context.close();
