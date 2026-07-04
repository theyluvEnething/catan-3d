/**
 * src/interact/legal.js — legal-move computation from the reconstructed GameState.
 *
 * Pure functions (no DOM). Given the mapState, compute which corners/edges/hexes are legal
 * for the current player+context, so the 3D UI can highlight only valid targets and the
 * direct-send layer never emits an illegal action. Uses boardGeometry adjacency.
 *
 * Rules (base Catan):
 *  - Settlement: unowned corner, no adjacent (edge-connected) corner is occupied (distance rule),
 *    and (outside setup) at least one of the player's roads touches it.
 *  - City: a corner the player already owns as a settlement (buildingType 1).
 *  - Road: unowned edge adjacent to one of the player's roads OR to one of their buildings
 *    (in setup, adjacent to the just-placed settlement).
 *  - Robber: any hex tile index other than its current location.
 */
import { cornerEdges, edgeCorners, hexCorners } from "../render/boardGeometry.js";

const keyC = (c) => `${c.x},${c.y},${c.z}`;
const keyE = (e) => `${e.x},${e.y},${e.z}`;

function indexCorners(mapState) {
  const byKey = new Map();
  for (const [i, c] of Object.entries(mapState.tileCornerStates || {})) byKey.set(keyC(c), { i: Number(i), ...c });
  return byKey;
}
function indexEdges(mapState) {
  const byKey = new Map();
  for (const [i, e] of Object.entries(mapState.tileEdgeStates || {})) byKey.set(keyE(e), { i: Number(i), ...e });
  return byKey;
}

// Corners adjacent to a corner = the other endpoint of each incident edge.
function adjacentCorners(c) {
  const out = [];
  for (const e of cornerEdges(c.x, c.y, c.z)) {
    const [a, b] = edgeCorners(e.x, e.y, e.z);
    const other = (a.x === c.x && a.y === c.y && a.z === c.z) ? b : a;
    out.push(other);
  }
  return out;
}

const owned = (o) => o != null && o !== -1;

export function legalSettlementCorners(state, { setup = false } = {}) {
  const ms = state.gameState.mapState;
  const cornerByKey = indexCorners(ms);
  const edgeByKey = indexEdges(ms);
  const us = state.us;
  const res = [];
  for (const c of cornerByKey.values()) {
    if (owned(c.owner)) continue;
    // distance rule: no occupied adjacent corner
    let blocked = false;
    for (const nc of adjacentCorners(c)) { const n = cornerByKey.get(keyC(nc)); if (n && owned(n.owner)) { blocked = true; break; } }
    if (blocked) continue;
    if (!setup) {
      // must connect to one of our roads
      let connected = false;
      for (const e of cornerEdges(c.x, c.y, c.z)) { const ee = edgeByKey.get(keyE(e)); if (ee && ee.owner === us) { connected = true; break; } }
      if (!connected) continue;
    }
    res.push(c);
  }
  return res;
}

export function legalCityCorners(state) {
  const ms = state.gameState.mapState;
  const us = state.us;
  const res = [];
  for (const [i, c] of Object.entries(ms.tileCornerStates || {})) {
    if (c.owner === us && (c.buildingType === 1 || c.buildingType == null)) res.push({ i: Number(i), ...c });
  }
  return res;
}

export function legalRoadEdges(state, { setup = false, fromCorner = null } = {}) {
  const ms = state.gameState.mapState;
  const cornerByKey = indexCorners(ms);
  const edgeByKey = indexEdges(ms);
  const us = state.us;
  const res = [];
  for (const e of edgeByKey.values()) {
    if (owned(e.owner)) continue;
    const [a, b] = edgeCorners(e.x, e.y, e.z);
    if (setup && fromCorner) {
      // in setup the road must touch the settlement just placed
      if ((a.x === fromCorner.x && a.y === fromCorner.y && a.z === fromCorner.z) ||
          (b.x === fromCorner.x && b.y === fromCorner.y && b.z === fromCorner.z)) res.push(e);
      continue;
    }
    // connect to our road or building at either endpoint
    let connected = false;
    for (const end of [a, b]) {
      const cc = cornerByKey.get(keyC(end));
      if (cc && cc.owner === us) { connected = true; break; }
      // or an incident edge we own (road network), but not through an opponent building
      for (const ie of cornerEdges(end.x, end.y, end.z)) {
        const ee = edgeByKey.get(keyE(ie));
        if (ee && ee.owner === us) {
          // blocked if the shared corner holds an opponent building
          if (cc && owned(cc.owner) && cc.owner !== us) continue;
          connected = true; break;
        }
      }
      if (connected) break;
    }
    if (connected) res.push(e);
  }
  return res;
}

export function legalRobberHexes(state) {
  const ms = state.gameState.mapState;
  const cur = state.robberTileIndex;
  const res = [];
  for (const [i, h] of Object.entries(ms.tileHexStates || {})) { if (Number(i) !== cur) res.push({ i: Number(i), ...h }); }
  return res;
}

// Players you can steal from at a robber hex = owners of buildings on that hex's corners (≠ us).
export function stealTargetsAtHex(state, hex) {
  const ms = state.gameState.mapState;
  const cornerByKey = indexCorners(ms);
  const victims = new Set();
  for (const c of hexCorners(hex.x, hex.y)) { const cc = cornerByKey.get(keyC(c)); if (cc && owned(cc.owner) && cc.owner !== state.us) victims.add(cc.owner); }
  return [...victims];
}
