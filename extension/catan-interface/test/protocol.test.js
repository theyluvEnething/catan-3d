/**
 * test/protocol.test.js — MessagePack + Colonist framing round-trips.
 *
 * Runs with `node --test`. Uses the bundled fixture capture (test/fixtures/fullgame.jsonl) so the
 * folder is self-contained: no external captures, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { msgpackDecode, msgpackEncode, decodeFrame, decodeOutgoing, encodeChannel } from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "fullgame.jsonl");
const frames = fs.readFileSync(FIXTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const b64ToU8 = (b64) => new Uint8Array(Buffer.from(b64, "base64"));

test("msgpack encode→decode round-trips primitive/array/map values", () => {
  const samples = [0, 1, 127, 128, 255, 256, 65535, 65536, -1, -32, -128, -1000, true, false, null,
    "hi", "a".repeat(40), [1, 2, 3], { action: 15, payload: 27, sequence: 1 }, { nested: { a: [true, null, "x"] } }];
  for (const v of samples) {
    const round = msgpackDecode(msgpackEncode(v));
    assert.deepEqual(round, v, `round-trip failed for ${JSON.stringify(v)}`);
  }
});

test("decodeFrame decodes every captured inbound binary frame without error", () => {
  let ok = 0, snaps = 0, diffs = 0;
  for (const l of frames) {
    if (l.dir !== "in" || l.kind !== "binary") continue;
    const d = decodeFrame({ dir: "in", kind: "binary", b64: l.b64 });
    assert.ok(d, "decodeFrame returned falsy");
    ok++;
    if (d.type === 4) snaps++;
    if (d.type === 91) diffs++;
  }
  assert.ok(ok > 0, "no inbound binary frames in fixture");
  assert.ok(snaps >= 1, "expected at least one snapshot");
  assert.ok(diffs >= 1, "expected diffs");
});

test("decodeOutgoing reads action/payload/sequence from every captured outbound frame", () => {
  let seen = 0;
  for (const l of frames) {
    if (l.dir !== "out" || l.kind !== "binary") continue;
    const u8 = b64ToU8(l.b64);
    if (u8[0] !== 0x03) continue; // only game-channel frames carry action/payload/sequence
    const d = decodeOutgoing(u8);
    assert.equal(d.b0, 0x03);
    assert.equal(typeof d.channel, "string");
    assert.ok(d.action != null, "missing action");
    assert.ok(typeof d.body.sequence === "number", "missing sequence");
    seen++;
  }
  assert.ok(seen > 0, "no outbound game frames in fixture");
});

test("encodeChannel produces the verified byte-exact game frame and re-decodes to the same values", () => {
  const bytes = encodeChannel("012B34", 15, 27, 5);
  assert.equal(bytes[0], 0x03, "header byte must be 0x03 (game channel)");
  assert.equal(bytes[1], 0x01, "second byte must be 0x01");
  assert.equal(bytes[2], "012B34".length, "strlen byte must be channel length");
  const dec = decodeOutgoing(bytes);
  assert.equal(dec.channel, "012B34");
  assert.equal(dec.action, 15);
  assert.equal(dec.payload, 27);
  assert.equal(dec.body.sequence, 5);
});

test("encodeChannel round-trips a captured outbound frame byte-for-byte", () => {
  // Take a real captured game frame, decode it, re-encode with the same values, and compare bytes.
  const outFrame = frames.find((l) => l.dir === "out" && l.kind === "binary" && b64ToU8(l.b64)[0] === 0x03);
  assert.ok(outFrame, "need at least one captured outbound game frame");
  const orig = b64ToU8(outFrame.b64);
  const dec = decodeOutgoing(orig);
  const reEncoded = encodeChannel(dec.channel, dec.action, dec.payload, dec.body.sequence);
  assert.deepEqual(Array.from(reEncoded), Array.from(orig), "re-encoded bytes differ from the original capture");
});
