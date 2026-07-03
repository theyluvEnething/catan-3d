// Phase-3 calibration: derive Colonist's axial(x,y,z corner) -> canvas-pixel AFFINE transform
// from placed-settlement blobs, which are visible colored marks on the WebGL canvas.
//
// Method:
//   1. Play the opening so several settlements exist at KNOWN corner coords (from state).
//   2. Screenshot the canvas; for each player color, find its settlement blob centroids.
//   3. Match each blob to the nearest expected corner (greedy by count), giving
//      (cornerBoardXY -> pixel) pairs.
//   4. Least-squares fit a full 2D affine [a b tx; c d ty]. Save debug/calibration2.json.
//
// The board projection is a fixed affine (Colonist's board doesn't rotate), so a handful of
// non-collinear pairs pin it precisely. We validate reprojection error and, if low, we're done.
import { launch, checkLogin, SHOTS_DIR, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { cornerPosExact } from "../extension/src/render/boardGeometry.js";
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Player color id -> approximate RGB of Colonist's pieces (for blob detection).
const PIECE_RGB = {
  1: [210, 60, 60], 2: [60, 116, 210], 3: [224, 132, 46], 4: [55, 162, 78],
  11: [138, 79, 208], 12: [43, 182, 166], 13: [212, 79, 154], 14: [201, 181, 47],
};
function colorDist(p, c) { return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]); }

function fitAffine(pairs) {
  // x' = a*X + b*Y + tx ; y' = c*X + d*Y + ty. Normal equations (shared 3x3).
  const n = pairs.length;
  let SXX = 0, SYY = 0, SXY = 0, SX = 0, SY = 0, SxpX = 0, SxpY = 0, Sxp = 0, SypX = 0, SypY = 0, Syp = 0;
  for (const { X, Y, px, py } of pairs) {
    SXX += X * X; SYY += Y * Y; SXY += X * Y; SX += X; SY += Y;
    SxpX += px * X; SxpY += px * Y; Sxp += px; SypX += py * X; SypY += py * Y; Syp += py;
  }
  const M = [[SXX, SXY, SX], [SXY, SYY, SY], [SX, SY, n]];
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const solve = (rhs) => { const D = det3(M); const col = (i) => M.map((r, ri) => r.map((v, ci) => ci === i ? rhs[ri] : v)); return [det3(col(0)) / D, det3(col(1)) / D, det3(col(2)) / D]; };
  const [a, b, tx] = solve([SxpX, SxpY, Sxp]);
  const [c, d, ty] = solve([SypX, SypY, Syp]);
  return { a, b, tx, c, d, ty };
}
const project = (aff, X, Y) => [aff.a * X + aff.b * Y + aff.tx, aff.c * X + aff.d * Y + aff.ty];

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.error("not logged in"); await context.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4000);

const box = await (await page.$("#game-canvas")).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2, R = Math.min(box.width, box.height) * 0.46;
const prompt = () => page.evaluate(() => { const el = document.querySelector("[class*=messageContainer]"); return el ? (el.innerText || "").trim().toLowerCase() : ""; });
const owned = () => page.evaluate(() => { const gs = window.__catan3d?.state, cs = gs?.gameState?.mapState?.tileCornerStates || {}, es = gs?.gameState?.mapState?.tileEdgeStates || {}, us = gs?.us; return Object.values(cs).filter((c) => c.owner === us).length + Object.values(es).filter((e) => e.owner === us).length; });
const diceThrown = () => page.evaluate(() => window.__catan3d?.state?.gameState?.diceState?.diceThrown);
const turnOf = () => page.evaluate(() => window.__catan3d?.state?.currentTurnColor);
const usColor = () => page.evaluate(() => window.__catan3d?.state?.us);

// Play the opening (setup) so all 4 players place 2 settlements each.
console.log("playing setup to populate settlements…");
for (let i = 0; i < 80; i++) {
  const done = await page.evaluate(() => window.__catan3d?.state?.completedTurns || 0);
  if (done >= 8) break;
  const p = await prompt();
  if (/place settlement|place road/.test(p)) { const b = await owned(); outer: for (let ring = 0.08; ring <= 1; ring += 0.04) { const n = Math.max(8, Math.round(ring * 54)); for (let j = 0; j < n; j++) { const a = (j / n) * Math.PI * 2 + ring; await page.mouse.click(cx + Math.cos(a) * R * ring, cy + Math.sin(a) * R * ring); await sleep(140); if (await owned() > b) break outer; } } await sleep(500); }
  else if (/roll/.test(p)) { await page.keyboard.press("Space"); await sleep(1000); }
  else if (/answer trade/.test(p)) { await page.keyboard.press("Escape"); await sleep(400); }
  else if (await turnOf() === await usColor() && await diceThrown()) { await page.keyboard.press("Space"); await sleep(600); }
  else await sleep(900);
}

// Grab all settlement corners (coord + owner) from state.
const settlements = await page.evaluate(() => {
  const cs = window.__catan3d.state.gameState.mapState.tileCornerStates;
  return Object.values(cs).filter((c) => c.owner != null && c.owner !== -1).map((c) => ({ x: c.x, y: c.y, z: c.z, owner: c.owner }));
});
console.log("settlements placed:", settlements.length);

// Screenshot just the canvas region.
const buf = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
fs.writeFileSync(path.join(SHOTS_DIR, "calib2-canvas.png"), buf);
const png = PNG.sync.read(buf);
const W = png.width, H = png.height;

// For each settlement, find the pixel of its color blob near the EXPECTED position. We don't
// yet have the transform, so we detect ALL blobs per color, then match to corners by an
// initial rough affine (from the board center + scale guess), then refine.
function blobsForColor(rgb, tol = 60) {
  // find connected-ish bright pixels matching color; return centroids via simple clustering.
  const pts = [];
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
    const i = (y * W + x) * 4;
    if (colorDist([png.data[i], png.data[i + 1], png.data[i + 2]], rgb) < tol) pts.push([x, y]);
  }
  // cluster by 24px grid
  const clusters = new Map();
  for (const [x, y] of pts) { const k = `${Math.round(x / 24)},${Math.round(y / 24)}`; const c = clusters.get(k) || [0, 0, 0]; c[0] += x; c[1] += y; c[2]++; clusters.set(k, c); }
  return [...clusters.values()].filter((c) => c[2] >= 4).map((c) => [c[0] / c[2], c[1] / c[2], c[2]]);
}

// Build (corner boardXY, owner) targets; boardXY from cornerPosExact.
const targets = settlements.map((s) => { const { u, v } = cornerPosExact(s.x, s.y, s.z); return { ...s, X: u, Y: v }; });

// Detect all blobs per color once (in canvas-local pixels).
const blobsByColor = {};
for (const owner of new Set(targets.map((t) => t.owner))) {
  const rgb = PIECE_RGB[owner]; if (!rgb) continue;
  blobsByColor[owner] = blobsForColor(rgb).sort((a, b) => b[2] - a[2]);
}

// Board bounds in board-space to seed a better rough transform (map board bbox -> canvas bbox
// occupied by the island, which we estimate as left-ish 62% of the canvas per observation).
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (const t of targets) { minX = Math.min(minX, t.X); maxX = Math.max(maxX, t.X); minY = Math.min(minY, t.Y); maxY = Math.max(maxY, t.Y); }
// island roughly fills the canvas height and ~ left 62% width; center offset accordingly.
const islandW = box.width * 0.62, islandH = box.height * 0.88;
const sx = islandW / Math.max(0.01, maxX - minX), sy = islandH / Math.max(0.01, maxY - minY);
const s0 = Math.min(sx, sy);
let aff = { a: s0, b: 0, tx: box.width * 0.31 - ((minX + maxX) / 2) * s0, c: 0, d: s0, ty: box.height / 2 - ((minY + maxY) / 2) * s0 };

// Iterated closest-point: match blobs with current aff, refit, repeat.
function matchPairs(aff) {
  const pairs = [];
  for (const t of targets) {
    const blobs = blobsByColor[t.owner]; if (!blobs || !blobs.length) continue;
    const [rx, ry] = project(aff, t.X, t.Y);
    let best = null, bd = Infinity;
    for (const bl of blobs) { const dd = Math.hypot(bl[0] - rx, bl[1] - ry); if (dd < bd) { bd = dd; best = bl; } }
    if (best) pairs.push({ X: t.X, Y: t.Y, px: best[0], py: best[1], owner: t.owner, d: bd });
  }
  return pairs;
}
let pairs = [], mean = Infinity;
for (let iter = 0; iter < 12; iter++) {
  pairs = matchPairs(aff);
  if (pairs.length < 3) break;
  aff = fitAffine(pairs);
  let err = 0; for (const p of pairs) { const [px, py] = project(aff, p.X, p.Y); err += Math.hypot(px - p.px, py - p.py); }
  mean = err / pairs.length;
  console.log(`iter ${iter}: pairs=${pairs.length} meanErr=${mean.toFixed(1)}px`);
  if (mean < 6) break;
}

// Convert affine to full-page pixels (add canvas box origin into translation).
const affPage = { a: aff.a, b: aff.b, tx: aff.tx + box.x, c: aff.c, d: aff.d, ty: aff.ty + box.y };
console.log("AFFINE(page):", JSON.stringify(affPage));
console.log("final mean err (px):", mean.toFixed(1));
fs.writeFileSync(path.join(ROOT, "debug", "calibration2.json"), JSON.stringify({ affine: affPage, affineCanvas: aff, box, meanErr: mean, nPairs: pairs.length }, null, 2));
console.log("wrote debug/calibration2.json");
await context.close();
