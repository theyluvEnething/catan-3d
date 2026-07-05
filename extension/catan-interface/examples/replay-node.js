/**
 * examples/replay-node.js — headless full-game replay, proving the engine is standalone (Node,
 * no browser). Feeds a captured frames.jsonl through createEngine, prints the final normalized
 * Observation, and asserts the desync watchdog reports 0 desyncs.
 *
 *   node examples/replay-node.js [path/to/frames.jsonl]
 *
 * With no argument it uses the bundled fixture (test/fixtures/fullgame.jsonl), so the folder runs
 * this example with zero external files.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, decodeOutgoing } from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(__dirname, "..", "test", "fixtures", "fullgame.jsonl");
if (!fs.existsSync(file)) { console.error("capture not found:", file); process.exit(2); }

const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const b64ToU8 = (b64) => new Uint8Array(Buffer.from(b64, "base64"));

// The engine is transport-agnostic: `send` would transmit outbound bytes; here we just capture.
const transmitted = [];
const engine = createEngine({ send: (bytes) => transmitted.push(bytes) });

let events = 0;
engine.on("event", () => events++);
engine.on("desync", (drift) => console.warn("DESYNC:", JSON.stringify(drift)));

let inCount = 0;
for (const l of lines) {
  if (l.dir === "in") {
    engine.ingest({ dir: "in", kind: l.kind, text: l.text, b64: l.b64 });
    inCount++;
  } else if (l.dir === "out" && l.kind === "binary" && l.b64) {
    // Learn the game channel + sequence from Colonist's own outbound frames (as the browser
    // adapter does), so the engine could send in-sequence.
    const u8 = b64ToU8(l.b64);
    if (u8[0] === 0x03) {
      const d = decodeOutgoing(u8);
      if (d.channel) engine.setChannel(d.channel);
      if (d.body && typeof d.body.sequence === "number") engine.setSequence(d.body.sequence);
    }
  }
}

const obs = engine.getObservation();
const wd = engine.watchdog.report();
const trk = engine.tracker.summary();

console.log("=".repeat(72));
console.log("catan-interface — headless replay of", path.basename(file));
console.log("=".repeat(72));
console.log(`ingested ${inCount} inbound frames · ${events} normalized events · channel ${engine.wire.channel}`);
console.log("");
console.log("FINAL OBSERVATION");
console.log(JSON.stringify(obs, null, 2));
console.log("");
console.log("TRACKER (hand beliefs)");
for (const p of trk.players) {
  const est = Object.entries(p.estimate).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`  ${p.isUs ? "*" : " "}P${p.color}  total=${p.total} known=${JSON.stringify(p.known)} unknown=${p.unknownCount}  est[${est}]`);
}
console.log(`  devDeckRemaining=${trk.devDeckRemaining} devTotals=${JSON.stringify(trk.devTotals)}`);
console.log("");
console.log("WATCHDOG:", JSON.stringify(wd));

// Assert the acceptance condition: the engine reconstructed the game and never drifted.
const ok = obs.board.hexes.length === 19 && obs.board.nodes.length === 54 && obs.board.edges.length === 72 && wd.clean;
console.log("");
console.log(ok
  ? "✅ ACCEPTANCE: full game reconstructed headlessly (19/54/72 board) with 0 desyncs — engine is standalone."
  : "✗ ACCEPTANCE FAILED");
process.exit(ok ? 0 : 1);
