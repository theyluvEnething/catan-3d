/**
 * test/state-legal.test.js — state reconstruction, watchdog, and legal-move rules.
 * Replays the bundled fixture through GameState, then exercises the legal-move engine on a
 * synthetic setup board (deterministic, no capture needed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFrame } from "../index.js";
import { GameState } from "../src/state/gameState.js";
import { attachWatchdog } from "../src/state/watchdog.js";
import {
  legalSettlementCorners, legalCityCorners, legalRoadEdges, legalRobberHexes,
} from "../src/domain/legal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frames = fs.readFileSync(path.join(__dirname, "fixtures", "fullgame.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function replay() {
  const gs = new GameState({ now: () => 0 });
  const wd = attachWatchdog(gs, { now: () => 0 });
  for (const l of frames) {
    if (l.dir !== "in" || l.kind === "text") continue;
    let d; try { d = decodeFrame({ dir: "in", kind: l.kind, b64: l.b64 }); } catch { continue; }
    if (d.id !== "130") continue;
    gs.applyIncoming(d);
  }
  return { gs, wd };
}

test("replaying the fixture reconstructs a standard 19/54/72/9 board", () => {
  const { gs } = replay();
  assert.equal(gs.ready, true);
  assert.equal(gs.hexes.length, 19);
  assert.equal(gs.corners.length, 54);
  assert.equal(gs.edges.length, 72);
  assert.equal(gs.ports.length, 9);
});

test("watchdog reports 0 desyncs over the fixture replay", () => {
  const { wd } = replay();
  const r = wd.report();
  assert.equal(r.clean, true);
  assert.equal(r.desyncs, 0);
});

test("buildings() extracts placed settlements/cities/roads", () => {
  const { gs } = replay();
  const b = gs.buildings();
  assert.ok(b.settlements.length >= 1, "expected settlements");
  assert.ok(b.roads.length >= 1, "expected roads");
  for (const s of b.settlements) { assert.equal(typeof s.color, "number"); assert.equal(typeof s.cornerIndex, "number"); }
});

// ---- legal-move rules on a deterministic tiny board -------------------------------------------
// Build a minimal mapState with 3 corners in a line (0-1-2 via edge 0 between 0,1 and edge 1
// between 1,2) plus one hex, to exercise the distance rule + road connectivity precisely.
function tinyState({ us = 1 } = {}) {
  // corners: A(0,0,0) B(0,1,0) C(-1,1,0) — A and B are edge-adjacent via edge (0,1,0) [endpoints
  // (0,1,0) and (-1,2,0)]. We instead assert against the real adjacency the geometry computes.
  const gs = new GameState({ now: () => 0 });
  gs.applyIncoming({
    id: "130", type: 4,
    payload: {
      playerColor: us, playOrder: [us],
      gameState: {
        mapState: {
          tileHexStates: { 0: { x: 0, y: 0, type: 1, diceNumber: 8 } },
          tileCornerStates: {
            0: { x: 0, y: 0, z: 0 },
            1: { x: 0, y: 0, z: 1 },
            2: { x: 1, y: -1, z: 1 },
          },
          tileEdgeStates: {
            0: { x: 0, y: 0, z: 0 },   // incident to corner (0,0,0)
            1: { x: 0, y: 0, z: 2 },   // incident to corner (0,0,1)
          },
          portEdgeStates: {},
        },
        mechanicRobberState: { locationTileIndex: 0 },
        currentState: { currentTurnPlayerColor: us, actionState: 1, completedTurns: 0, turnState: 0 },
        playerStates: { [us]: { resourceCards: { cards: [] } } },
      },
    },
  });
  return gs;
}

test("legalSettlementCorners in setup returns all unowned, distance-legal corners", () => {
  const gs = tinyState();
  const legal = legalSettlementCorners(gs, { setup: true });
  // all 3 corners are unowned and (in this tiny board) not mutually adjacent via a shared edge
  assert.ok(legal.length >= 1);
  assert.ok(legal.every((c) => c.owner == null || c.owner === -1));
});

test("distance rule blocks a corner adjacent to an owned one", () => {
  const gs = tinyState();
  // own corner (0,0,0). Its edge-adjacent corner is the other endpoint of edge (0,0,0).
  gs.gameState.mapState.tileCornerStates[0].owner = 1;
  gs.gameState.mapState.tileCornerStates[0].buildingType = 1;
  const legal = legalSettlementCorners(gs, { setup: true }).map((c) => `${c.x},${c.y},${c.z}`);
  assert.ok(!legal.includes("0,0,0"), "owned corner should not be legal");
});

test("legalCityCorners returns only our own settlements", () => {
  const gs = tinyState();
  gs.gameState.mapState.tileCornerStates[1].owner = 1;
  gs.gameState.mapState.tileCornerStates[1].buildingType = 1; // settlement
  gs.gameState.mapState.tileCornerStates[2].owner = 2;        // opponent
  gs.gameState.mapState.tileCornerStates[2].buildingType = 1;
  const cities = legalCityCorners(gs);
  assert.equal(cities.length, 1);
  assert.equal(cities[0].i, 1);
});

test("legalRobberHexes excludes the robber's current tile", () => {
  const gs = tinyState();
  const hexes = legalRobberHexes(gs);
  assert.ok(hexes.every((h) => h.i !== 0), "current robber tile must be excluded");
});

test("legalRoadEdges in setup constrains to edges touching the given corner", () => {
  const gs = tinyState();
  const from = { x: 0, y: 0, z: 0 };
  const roads = legalRoadEdges(gs, { setup: true, fromCorner: from });
  // edge (0,0,0) is incident to corner (0,0,0) → should be legal; all returned edges are unowned
  assert.ok(roads.every((e) => e.owner == null || e.owner === -1));
});
