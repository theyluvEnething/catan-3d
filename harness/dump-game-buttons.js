// dump-game-buttons.js — reconnect into the game and dump every actionable UI element (id,
// class, text, rect) so we can find the real buy-dev / build / trade controls.
import { launch, checkLogin, ROOT } from "./launch.js";
import fs from "node:fs";
import path from "node:path";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (c) => setTimeout(() => process.exit(c), 400);
const context = await launch({ inject: true });
const page = context.pages()[0] || (await context.newPage());
const { loggedIn } = await checkLogin(page);
if (!loggedIn) { console.log("not logged in"); done(2); }
await page.goto("https://colonist.io/", { waitUntil: "domcontentloaded" }).catch(() => {});
await sleep(3000);
const rc = await page.evaluateHandle(() => Array.from(document.querySelectorAll("button,.top-notification-button,div")).find((e) => /^reconnect$/i.test((e.innerText || "").trim()) && e.getBoundingClientRect().width > 0) || null);
const el = rc.asElement(); if (el) { await el.click({ force: true }).catch(() => {}); console.log("reconnected"); await sleep(6000); }
if (!(await page.$("#game-canvas"))) { console.log("no canvas"); done(1); }

// Dump all elements with an id OR that look interactive, in the bottom + right regions.
const dump = await page.evaluate(() => {
  const out = [];
  const all = document.querySelectorAll("*");
  for (const e of all) {
    const r = e.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const id = e.id || "";
    const cls = (e.className && e.className.toString) ? e.className.toString() : "";
    const txt = (e.innerText || "").trim().slice(0, 30);
    const interesting = id || /button|btn|action|build|dev|card|trade|bank|end-turn|hourglass/i.test(id + " " + cls);
    if (!interesting) continue;
    // only bottom tray (y>60% ) or right panel (x>75%)
    const inTray = r.top > innerHeight * 0.55;
    const inRight = r.left > innerWidth * 0.72;
    if (!inTray && !inRight && !id) continue;
    out.push({ id, cls: cls.slice(0, 60), txt, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), region: inTray ? "tray" : inRight ? "right" : "" });
  }
  return out;
});
const uniq = []; const seen = new Set();
for (const d of dump) { const k = d.id + "|" + d.cls + "|" + d.txt; if (seen.has(k)) continue; seen.add(k); uniq.push(d); }
fs.writeFileSync(path.join(ROOT, "debug", "hud", "game-buttons.json"), JSON.stringify(uniq, null, 2));
console.log("dumped", uniq.length, "elements");
for (const d of uniq) console.log(`  [${d.region}] id="${d.id}" cls="${d.cls}" txt="${d.txt}" @${d.x},${d.y} ${d.w}x${d.h}`);
await page.screenshot({ path: path.join(ROOT, "debug", "hud", "game-buttons.png") }).catch(() => {});
done(0);
