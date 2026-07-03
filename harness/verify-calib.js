// Verifies calibration by drawing predicted hex-center + corner markers over a live board
// screenshot. If markers land on the real tiles/vertices, the transform is correct.
import { launch, checkLogin, SHOTS_DIR, ROOT } from "./launch.js";
import { startBotGame, dismissConsent } from "./start-game.js";
import { hexCenter, cornerPosExact } from "../extension/src/render/boardGeometry.js";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cal = JSON.parse(fs.readFileSync(path.join(ROOT, "debug", "calibration3.json"), "utf8"));
const aff = cal.affine;
const project = (X, Y) => [aff.a * X + aff.b * Y + aff.tx, aff.c * X + aff.d * Y + aff.ty];

const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.error("not logged in"); await context.close(); process.exit(2); }
await dismissConsent(page);
await startBotGame(page, {});
await sleep(4500);

const data = await page.evaluate(() => {
  const ms = window.__catan3d.state.gameState.mapState;
  return { hexes: Object.values(ms.tileHexStates).map((h) => ({ x: h.x, y: h.y })), corners: Object.values(ms.tileCornerStates).map((c) => ({ x: c.x, y: c.y, z: c.z })) };
});

// Draw overlay markers directly in the page (absolute-positioned divs) then screenshot.
await page.evaluate(({ hexPts, cornerPts }) => {
  const mk = (x, y, color, size) => { const d = document.createElement("div"); Object.assign(d.style, { position: "fixed", left: (x - size / 2) + "px", top: (y - size / 2) + "px", width: size + "px", height: size + "px", borderRadius: "50%", background: color, zIndex: 999999, pointerEvents: "none", opacity: "0.8" }); document.body.appendChild(d); };
  for (const p of hexPts) mk(p[0], p[1], "#00e5ff", 12);      // cyan = hex centers
  for (const p of cornerPts) mk(p[0], p[1], "#ff2d55", 7);    // red = corners
}, {
  hexPts: data.hexes.map((h) => { const { u, v } = hexCenter(h.x, h.y); return project(u, v); }),
  cornerPts: data.corners.map((c) => { const { u, v } = cornerPosExact(c.x, c.y, c.z); return project(u, v); }),
});
await sleep(300);
await page.screenshot({ path: path.join(SHOTS_DIR, "calib-verify.png") });
console.log("wrote calib-verify.png — cyan=hex centers, red=corners; should align with board");
await context.close();
