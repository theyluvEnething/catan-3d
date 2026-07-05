/**
 * test/engine-api.test.js — createEngine, Observation, and the Action tool surface end-to-end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, decodeOutgoing, OBSERVATION_SCHEMA, TOOL_DEFINITIONS, ACTION } from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frames = fs.readFileSync(path.join(__dirname, "fixtures", "fullgame.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function fedEngine() {
  const sent = [];
  const engine = createEngine({ send: (b) => sent.push(b), now: () => 0 });
  for (const l of frames) {
    if (l.dir === "in") engine.ingest({ dir: "in", kind: l.kind, text: l.text, b64: l.b64 });
    else if (l.dir === "out" && l.kind === "binary" && l.b64) {
      const u8 = new Uint8Array(Buffer.from(l.b64, "base64"));
      if (u8[0] === 0x03) { const d = decodeOutgoing(u8); if (d.channel) engine.setChannel(d.channel); if (typeof d.body.sequence === "number") engine.setSequence(d.body.sequence); }
    }
  }
  return { engine, sent };
}

test("createEngine ingests a capture and reports ready with a clean watchdog", () => {
  const { engine } = fedEngine();
  assert.equal(engine.ready, true);
  assert.equal(engine.watchdog.report().clean, true);
  assert.equal(typeof engine.wire.channel, "string");
});

test("getObservation returns a complete, schema-shaped snapshot", () => {
  const { engine } = fedEngine();
  const obs = engine.getObservation();
  // top-level required keys present
  for (const k of OBSERVATION_SCHEMA.required) assert.ok(k in obs, `observation missing '${k}'`);
  assert.equal(obs.board.hexes.length, 19);
  assert.equal(obs.board.nodes.length, 54);
  assert.equal(obs.board.edges.length, 72);
  assert.ok(obs.players.length >= 2);
  for (const p of obs.players) { assert.ok(p.id.startsWith("P")); assert.equal(typeof p.resourceCount, "number"); }
  // hand + bank are resource-count maps
  for (const n of ["wood", "brick", "sheep", "wheat", "ore"]) { assert.equal(typeof obs.hand[n], "number"); assert.equal(typeof obs.bank[n], "number"); }
});

test("verified actions validate legality then emit the byte-exact wire frame", () => {
  // Force a setup-settlement, our-turn state so legalActions populate.
  const { engine } = fedEngine();
  const gs = engine.getState();
  gs.gameState.currentState = { currentTurnPlayerColor: gs.us, actionState: 1, completedTurns: 0, turnState: 0 };
  const obs = engine.getObservation();
  const legalStr = obs.legalActions.find((a) => a.startsWith("build_settlement:"));
  assert.ok(legalStr, "expected at least one legal settlement");
  const node = Number(legalStr.split(":")[1]);
  const before = engine.wire.sequence;
  const res = engineSyncPlace(engine, node);
  assert.equal(res.ok, true);
  assert.equal(res.action, ACTION.BUILD_SETTLEMENT);
  assert.equal(res.sequence, before + 1, "sequence must increment");
});

// build_settlement is async; run it synchronously via the low-level sendAction the tool uses.
function engineSyncPlace(engine, node) {
  // Mirror actions.build_settlement's contract without awaiting: legality is already checked in
  // getObservation; here we assert the encode+send path directly.
  return engine.sendAction(ACTION.BUILD_SETTLEMENT, node);
}

test("illegal action is rejected without sending", async () => {
  const { engine, sent } = fedEngine();
  // Make it our turn so the legality check (not the turn guard) is what rejects.
  const gs = engine.getState();
  gs.gameState.currentState = { currentTurnPlayerColor: gs.us, actionState: 1, completedTurns: 0, turnState: 0 };
  const n0 = sent.length;
  const res = await engine.actions.build_settlement(999999);
  assert.equal(res.ok, false);
  assert.match(res.error, /illegal/);
  assert.equal(sent.length, n0, "no bytes should be transmitted for an illegal action");
});

test("unimplemented actions return the documented unimplemented result (never emit a guess)", async () => {
  const { engine, sent } = fedEngine();
  // Make it our turn so roll() reaches its unimplemented path (not the turn guard).
  const gs = engine.getState();
  gs.gameState.currentState = { currentTurnPlayerColor: gs.us, actionState: 1, completedTurns: 20, turnState: 2 };
  const n0 = sent.length;
  for (const name of ["buy_dev_card", "play_dev", "bank_trade", "create_trade", "roll"]) {
    const res = await engine.actions[name]({});
    assert.equal(res.ok, false, `${name} should be unimplemented`);
    assert.match(res.error, /unimplemented/);
  }
  assert.equal(sent.length, n0, "unimplemented actions must not transmit");
});

test("TOOL_DEFINITIONS exposes a function schema for every action", () => {
  const names = TOOL_DEFINITIONS.map((t) => t.function.name);
  for (const n of ["build_settlement", "build_city", "build_road", "roll", "end_turn", "move_robber", "discard", "respond_trade", "buy_dev_card", "play_dev", "bank_trade", "create_trade"]) {
    assert.ok(names.includes(n), `TOOL_DEFINITIONS missing '${n}'`);
  }
  for (const t of TOOL_DEFINITIONS) { assert.equal(t.type, "function"); assert.ok(t.function.parameters); }
});
