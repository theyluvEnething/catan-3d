// Parallel-game infrastructure: clone the logged-in profile into N isolated copies so N
// Colonist bot games can run concurrently (Colonist allows many parallel games). Each clone
// gets its own Chrome context. Used by the Phase-3 capture/validation fan-out.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildInitScript } from "./inject.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
const BASE_PROFILE = path.join(ROOT, ".colonist-profile");
const CLONES_DIR = path.join(ROOT, ".profile-clones");
const EXTENSION_DIR = path.join(ROOT, "extension");

// Copy only the login-critical parts of the profile (fast; ~ a few MB vs 286MB full copy).
const KEEP = [
  "Default/Network/Cookies", "Default/Network/Cookies-journal",
  "Default/Local Storage", "Default/Session Storage",
  "Default/Preferences", "Default/Secure Preferences",
  "Local State",
];
function copyRec(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const f of fs.readdirSync(src)) copyRec(path.join(src, f), path.join(dst, f)); }
  else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
}
export function makeClone(i) {
  const dir = path.join(CLONES_DIR, "p" + i);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of KEEP) {
    const src = path.join(BASE_PROFILE, rel);
    if (!fs.existsSync(src)) continue;
    copyRec(src, path.join(dir, rel));
  }
  return dir;
}

export async function launchClone(i, { inject = true } = {}) {
  const dir = makeClone(i);
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chrome", headless: false, viewport: null,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  if (inject) await ctx.addInitScript({ content: buildInitScript() });
  return { ctx, dir };
}
