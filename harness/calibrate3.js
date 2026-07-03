// Phase-3 calibration v3: fit Colonist's axial(x,y) HEX-CENTER -> canvas-pixel affine using
// the WHITE NUMBER-TOKEN discs. They are large, high-contrast, one per non-desert hex (18 of
// them), so blob detection + ICP matching to known hex centers is robust and unambiguous.
//
// Once we have hexCenter(x,y) -> pixel, corner/edge pixels follow from boardGeometry (their
// board-space positions transform by the same affine). Saves debug/calibration3.json.
import { launch, checkLogin, SHOTS_DIR, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { hexCenter } from "../extension/src/render/boardGeometry.js";
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
// Non-desert hexes have a token; get their axial coords.
const hexes = await page.evaluate(() => Object.values(window.__catan3d.state.gameState.mapState.tileHexStates).map((h) => ({ x: h.x, y: h.y, type: h.type, dice: h.diceNumber })));
const tokenHexes = hexes.filter((h) => h.type !== 0 && h.dice);
console.log("token hexes:", tokenHexes.length);

const buf = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
fs.writeFileSync(path.join(SHOTS_DIR, "calib3-canvas.png"), buf);
const png = PNG.sync.read(buf); const W = png.width, H = png.height;

// Detect number-token discs: bright near-white, restricted to the board region (exclude the
// right-hand UI panel and the top-left HUD), then keep only large round clusters (~token size).
function whiteBlobs() {
  const xMax = W * 0.66;              // board occupies the left ~2/3 of the canvas
  const hudX = W * 0.22, hudY = H * 0.5; // exclude the dark HUD box (top-left)
  const pts = [];
  for (let y = 0; y < H; y += 1) for (let x = 0; x < xMax; x += 1) {
    if (x < hudX && y < hudY) continue;
    const i = (y * W + x) * 4; const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    // token cream is bright & fairly neutral; reject saturated/greenish tile pixels
    if (r > 225 && g > 220 && b > 195 && Math.abs(r - g) < 16 && (r - b) < 40 && (g - b) < 40) pts.push([x, y]);
  }
  // grid-cluster then refine + filter by size and roundness.
  const cell = 40; const grid = new Map();
  for (const [x, y] of pts) { const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`; (grid.get(k) || grid.set(k, []).get(k)).push([x, y]); }
  const seeds = [];
  for (const arr of grid.values()) { if (arr.length < 40) continue; let ax = 0, ay = 0; for (const [x, y] of arr) { ax += x; ay += y; } seeds.push([ax / arr.length, ay / arr.length]); }
  const blobs = [];
  for (const [sx, sy] of seeds) {
    let ax = 0, ay = 0, n = 0, r2 = 0;
    for (const [x, y] of pts) { const dd = Math.hypot(x - sx, y - sy); if (dd < 24) { ax += x; ay += y; n++; r2 += dd; } }
    if (n < 120) continue;                       // token disc ~ hundreds of px at step 1
    const cx = ax / n, cy = ay / n, meanR = r2 / n;
    if (meanR < 6 || meanR > 20) continue;       // roundness/size gate
    blobs.push([cx, cy, n]);
  }
  const uniq = [];
  for (const b of blobs.sort((a, z) => z[2] - a[2])) if (!uniq.some((u) => Math.hypot(u[0] - b[0], u[1] - b[1]) < 28)) uniq.push(b);
  return uniq;
}
const blobs = whiteBlobs();
console.log("white blobs detected:", blobs.length);

const targets = tokenHexes.map((h) => { const { u, v } = hexCenter(h.x, h.y); return { X: u, Y: v }; });
// rough affine seed
let minX = Math.min(...targets.map((t) => t.X)), maxX = Math.max(...targets.map((t) => t.X));
let minY = Math.min(...targets.map((t) => t.Y)), maxY = Math.max(...targets.map((t) => t.Y));
const s0 = Math.min(box.width * 0.6 / (maxX - minX), box.height * 0.82 / (maxY - minY));
let aff = { a: s0, b: 0, tx: box.width * 0.32 - ((minX + maxX) / 2) * s0, c: 0, d: s0, ty: box.height / 2 - ((minY + maxY) / 2) * s0 };

function match(aff) {
  const used = new Set(); const pairs = [];
  // match each target to nearest unused blob
  for (const t of targets) {
    const [rx, ry] = project(aff, t.X, t.Y);
    let best = -1, bd = Infinity;
    for (let i = 0; i < blobs.length; i++) { if (used.has(i)) continue; const dd = Math.hypot(blobs[i][0] - rx, blobs[i][1] - ry); if (dd < bd) { bd = dd; best = i; } }
    if (best >= 0) { used.add(best); pairs.push({ X: t.X, Y: t.Y, px: blobs[best][0], py: blobs[best][1], d: bd }); }
  }
  return pairs;
}
// Fit a SIMILARITY (uniform scale s, rotation θ, translation) from >=2 pairs — the correct
// model for Colonist's top-down board (no shear). Umeyama.
function fitSimilarity(prs) {
  const n = prs.length; let mbx = 0, mby = 0, mpx = 0, mpy = 0;
  for (const p of prs) { mbx += p.X; mby += p.Y; mpx += p.px; mpy += p.py; } mbx /= n; mby /= n; mpx /= n; mpy /= n;
  let Sxx = 0, Sxy = 0, Syx = 0, Syy = 0, varB = 0;
  for (const p of prs) { const bx = p.X - mbx, by = p.Y - mby, px = p.px - mpx, py = p.py - mpy; Sxx += px * bx; Sxy += px * by; Syx += py * bx; Syy += py * by; varB += bx * bx + by * by; }
  const th = Math.atan2(Syx - Sxy, Sxx + Syy);
  const s = (Math.cos(th) * (Sxx + Syy) + Math.sin(th) * (Syx - Sxy)) / varB;
  const a = Math.cos(th) * s, b = -Math.sin(th) * s, c = Math.sin(th) * s, d = Math.cos(th) * s;
  return { a, b, tx: mpx - (a * mbx + b * mby), c, d, ty: mpy - (c * mbx + d * mby) };
}

// RANSAC over (hex -> blob) correspondences to find the similarity with the most inliers.
function ransac() {
  let best = null, bestInliers = -1, bestAff = null;
  const allBlobs = blobs;
  for (let trial = 0; trial < 4000; trial++) {
    // pick 2 distinct targets + 2 distinct blobs (deterministic pseudo-random via trial index)
    const i1 = (trial * 7) % targets.length, i2 = (trial * 13 + 3) % targets.length; if (i1 === i2) continue;
    const j1 = (trial * 5) % allBlobs.length, j2 = (trial * 11 + 1) % allBlobs.length; if (j1 === j2) continue;
    const prs = [{ X: targets[i1].X, Y: targets[i1].Y, px: allBlobs[j1][0], py: allBlobs[j1][1] }, { X: targets[i2].X, Y: targets[i2].Y, px: allBlobs[j2][0], py: allBlobs[j2][1] }];
    const aff = fitSimilarity(prs);
    const sc = Math.hypot(aff.a, aff.c);
    if (sc < box.width * 0.03 || sc > box.width * 0.2) continue; // plausible hex scale only
    // count inliers: each target has a blob within 18px of its projection
    let inl = 0;
    for (const t of targets) { const [px, py] = project(aff, t.X, t.Y); let bd = Infinity; for (const bl of allBlobs) bd = Math.min(bd, Math.hypot(bl[0] - px, bl[1] - py)); if (bd < 18) inl++; }
    if (inl > bestInliers) { bestInliers = inl; bestAff = aff; }
  }
  return { aff: bestAff, inliers: bestInliers };
}
const rr = ransac();
console.log("RANSAC inliers:", rr.inliers, "/", targets.length);
aff = rr.aff || aff;
// Establish correspondences with the RANSAC similarity, then refine with a FULL affine
// (absorbs any slight non-uniform scale/shear in Colonist's projection). Iterate once.
let pairs = match(aff).filter((p) => p.d < 22);
if (pairs.length >= 4) { aff = fitAffine(pairs); pairs = match(aff).filter((p) => p.d < 18); if (pairs.length >= 4) aff = fitAffine(pairs); }
pairs = match(aff);
let mean = 0; { let err = 0, cnt = 0; for (const p of pairs) if (p.d < 25) { err += p.d; cnt++; } mean = cnt ? err / cnt : Infinity; }
console.log("affine after full-fit refine, inlier pairs:", pairs.filter((p) => p.d < 18).length);
const affPage = { a: aff.a, b: aff.b, tx: aff.tx + box.x, c: aff.c, d: aff.d, ty: aff.ty + box.y };
console.log("AFFINE(page):", JSON.stringify(affPage));
console.log("final mean err (px):", mean.toFixed(1), "over", pairs.length, "hexes");
fs.writeFileSync(path.join(ROOT, "debug", "calibration3.json"), JSON.stringify({ affine: affPage, affineCanvas: aff, box, meanErr: mean, nPairs: pairs.length }, null, 2));
console.log("wrote debug/calibration3.json");

// Inline verify on THIS SAME game: overlay predicted hex centers (cyan) + corners (red).
const projP = (X, Y) => [affPage.a * X + affPage.b * Y + affPage.tx, affPage.c * X + affPage.d * Y + affPage.ty];
const allCorners = await page.evaluate(() => Object.values(window.__catan3d.state.gameState.mapState.tileCornerStates).map((c) => ({ x: c.x, y: c.y, z: c.z })));
const cornerModule = await import("../extension/src/render/boardGeometry.js");
await page.evaluate(({ hexPts, cornerPts }) => {
  const mk = (x, y, color, size) => { const d = document.createElement("div"); Object.assign(d.style, { position: "fixed", left: (x - size / 2) + "px", top: (y - size / 2) + "px", width: size + "px", height: size + "px", borderRadius: "50%", background: color, zIndex: "999999", pointerEvents: "none", opacity: "0.85" }); document.body.appendChild(d); };
  for (const p of hexPts) mk(p[0], p[1], "#00e5ff", 14);
  for (const p of cornerPts) mk(p[0], p[1], "#ff2d55", 8);
}, {
  hexPts: tokenHexes.map((h) => { const { u, v } = hexCenter(h.x, h.y); return projP(u, v); }),
  cornerPts: allCorners.map((c) => { const { u, v } = cornerModule.cornerPosExact(c.x, c.y, c.z); return projP(u, v); }),
});
await sleep(300);
await page.screenshot({ path: path.join(SHOTS_DIR, "calib3-verify.png") });
console.log("wrote calib3-verify.png (inline, same game)");
await context.close();
