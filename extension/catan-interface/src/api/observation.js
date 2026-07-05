/**
 * src/api/observation.js — a normalized, LLM-friendly snapshot of the game.
 *
 * Built purely from GameState + Tracker + the legal-move engine. No engine internals leak: the
 * shape is stable and documented (see schema.js and the README). Board node/edge ids are the
 * Colonist mapState indices (cornerIndex / edgeIndex), so an action can reference them directly.
 */
import {
  RESOURCE, RESOURCE_NAME, RESOURCE_NAMES, HEX_RESOURCE, BUILDING_NAME, DEVCARD_NAME,
  PLAYER_COLOR_NAME,
} from "../domain/enums.js";
import {
  hexCorners, cornerHexes, edgeCorners,
} from "../domain/boardGeometry.js";
import { CONTEXTS } from "../domain/controller.js";

// Map a controller context to the public "phase" vocabulary.
const PHASE_FOR_CONTEXT = {
  [CONTEXTS.SETUP_SETTLEMENT]: "setup", [CONTEXTS.SETUP_ROAD]: "setup",
  [CONTEXTS.BUILD_SETTLEMENT]: "main", [CONTEXTS.BUILD_CITY]: "main", [CONTEXTS.BUILD_ROAD]: "main",
  [CONTEXTS.MOVE_ROBBER]: "move-robber", [CONTEXTS.ROLL]: "roll", [CONTEXTS.DISCARD]: "discard",
  [CONTEXTS.NONE]: "idle",
};

const pid = (color) => (color == null ? null : "P" + color);
const keyC = (c) => `${c.x},${c.y},${c.z}`;

/**
 * Build the normalized Observation.
 * @param {GameState} state
 * @param {Tracker} tracker
 * @param {InteractionController} controller
 * @param {object} legal   the engine.legal facade { settlements(), cities(), roads(), robberHexes() }
 */
export function buildObservation(state, tracker, controller, legal) {
  if (!state.ready || !state.gameState) {
    return { phase: "connecting", turn: null, you: null, canAct: false, board: { hexes: [], nodes: [], edges: [] }, players: [], hand: emptyHand(), devHand: [], legalActions: [], bank: null, log: [] };
  }
  const gs = state.gameState;
  const ms = gs.mapState || {};

  const ctx = controller.context();
  const phase = PHASE_FOR_CONTEXT[ctx] || "main";

  // ---- board ----
  const cornerByKey = new Map();
  for (const [i, c] of Object.entries(ms.tileCornerStates || {})) cornerByKey.set(keyC(c), { i: Number(i), ...c });
  const hexIndexByXY = new Map();
  for (const [i, h] of Object.entries(ms.tileHexStates || {})) hexIndexByXY.set(`${h.x},${h.y}`, Number(i));

  const hexes = Object.entries(ms.tileHexStates || {}).map(([i, h]) => ({
    id: Number(i),
    resource: HEX_RESOURCE[h.type] || "unknown",
    number: h.diceNumber || 0,
    robber: Number(i) === state.robberTileIndex,
  }));

  // ports: portEdgeStates carry {x,y,z,type}. type maps to 3:1 or 2:1-<res>. We attach a port
  // label to the two nodes an edge touches. Colonist port type enum: 0 = generic 3:1, 1..5 = 2:1
  // of that resource id. (Kept defensive — unknown types render as null.)
  const nodePort = new Map(); // cornerKey -> port label
  for (const p of Object.values(ms.portEdgeStates || {})) {
    const label = portLabel(p.type);
    if (!label) continue;
    for (const c of edgeCorners(p.x, p.y, p.z)) nodePort.set(keyC(c), label);
  }

  const nodes = Object.entries(ms.tileCornerStates || {}).map(([i, c]) => {
    const hexes = cornerHexes(c.x, c.y, c.z).map((h) => hexIndexByXY.get(`${h.x},${h.y}`)).filter((x) => x != null);
    return {
      id: Number(i),
      owner: owned(c.owner) ? pid(c.owner) : null,
      building: owned(c.owner) ? (BUILDING_NAME[c.buildingType] || "settlement") : null,
      port: nodePort.get(keyC(c)) || null,
      hexes,
    };
  });

  const edges = Object.entries(ms.tileEdgeStates || {}).map(([i, e]) => {
    const [a, b] = edgeCorners(e.x, e.y, e.z);
    const na = cornerByKey.get(keyC(a)), nb = cornerByKey.get(keyC(b));
    return {
      id: Number(i),
      owner: owned(e.owner) ? pid(e.owner) : null,
      nodes: [na ? na.i : null, nb ? nb.i : null],
    };
  });

  // ---- players ----
  const roadState = gs.mechanicLongestRoadState || {};
  const armyHolder = awardHolder(gs.mechanicLargestArmyState);
  const roadHolder = awardHolder(gs.mechanicLongestRoadState);
  const players = state.playerColors.map((color) => {
    const ps = state.playerState(color) || {};
    const h = tracker.hand(color);
    return {
      id: pid(color),
      color,
      colorName: PLAYER_COLOR_NAME[color] || String(color),
      name: playerName(state, color),
      isBot: playerIsBot(state, color),
      isYou: color === state.us,
      vpPublic: sumVals(ps.victoryPointsState),
      resourceCount: h.total,
      devCount: (gs.mechanicDevelopmentCardsState?.players?.[color]?.developmentCards?.cards || []).length,
      knightsPlayed: tracker.knightsPlayed(color),
      settlementsLeft: gs.mechanicSettlementState?.[color]?.bankSettlementAmount ?? null,
      citiesLeft: gs.mechanicCityState?.[color]?.bankCityAmount ?? null,
      roadsLeft: gs.mechanicRoadState?.[color]?.bankRoadAmount ?? null,
      longestRoadLen: roadState[color]?.longestRoad || 0,
      longestRoad: roadHolder === color,
      largestArmy: armyHolder === color,
    };
  });

  // ---- your hand ----
  const you = tracker.hand(state.us);
  const hand = { wood: you.known.wood, brick: you.known.brick, sheep: you.known.sheep, wheat: you.known.wheat, ore: you.known.ore };
  const devHand = (gs.mechanicDevelopmentCardsState?.players?.[state.us]?.developmentCards?.cards || [])
    .map((id) => DEVCARD_NAME[id] || `dev${id}`);

  // ---- legal actions (as flat strings the tool layer accepts) ----
  const legalActions = buildLegalActionStrings(ctx, legal, state);

  // ---- bank ----
  const bankRaw = gs.bankState?.resourceCards || {};
  const bank = { wood: bankRaw[RESOURCE.WOOD] || 0, brick: bankRaw[RESOURCE.BRICK] || 0, sheep: bankRaw[RESOURCE.SHEEP] || 0, wheat: bankRaw[RESOURCE.WHEAT] || 0, ore: bankRaw[RESOURCE.ORE] || 0 };

  // ---- human log (recent) ----
  const log = tracker.eventLog.slice(-12).map((e) => describeEvent(e, state));

  return {
    phase,
    turn: pid(state.currentTurnColor),
    you: pid(state.us),
    canAct: controller.canAct(),
    board: { hexes, nodes, edges },
    players,
    hand,
    devHand,
    legalActions,
    bank,
    log,
  };
}

// ---- helpers ----------------------------------------------------------------------------------
function owned(o) { return o != null && o !== -1; }
function sumVals(o) { return o ? Object.values(o).reduce((a, x) => a + (Number(x) || 0), 0) : 0; }
function emptyHand() { return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; }

function portLabel(type) {
  if (type == null) return null;
  if (type === 0) return "3:1";
  const n = RESOURCE_NAME[type];
  return n && n !== "hidden" ? `2:1-${n}` : "3:1";
}

function awardHolder(mechState) {
  for (const [color, v] of Object.entries(mechState || {})) {
    if (v && typeof v === "object" && (v.isLargestArmy === true || v.isLongestRoad === true || v.hasAward === true || v.owner === true)) return Number(color);
  }
  return null;
}

function playerName(state, color) {
  const u = state.playerUserStates;
  if (Array.isArray(u)) { const m = u.find((x) => x && x.color === color); if (m) return m.username || m.name || `Player ${color}`; }
  else if (u && u[color]) return u[color].username || u[color].name || `Player ${color}`;
  return `Player ${color}`;
}
function playerIsBot(state, color) {
  const u = state.playerUserStates;
  const f = Array.isArray(u) ? u.find((x) => x && x.color === color) : (u && u[color]);
  if (!f) return false;
  return !!(f.isBot || f.bot || f.isBotPlayer || (typeof f.userId === "string" && f.userId.startsWith("bot")));
}

function buildLegalActionStrings(ctx, legal, state) {
  const out = [];
  const idxOf = (targets) => targets.map((t) => t.i).filter((i) => i != null);
  switch (ctx) {
    case CONTEXTS.SETUP_SETTLEMENT:
    case CONTEXTS.BUILD_SETTLEMENT:
      for (const i of idxOf(legal.settlements())) out.push(`build_settlement:${i}`);
      break;
    case CONTEXTS.BUILD_CITY:
      for (const i of idxOf(legal.cities())) out.push(`build_city:${i}`);
      break;
    case CONTEXTS.SETUP_ROAD:
    case CONTEXTS.BUILD_ROAD:
      for (const i of idxOf(legal.roads())) out.push(`build_road:${i}`);
      break;
    case CONTEXTS.MOVE_ROBBER:
      for (const i of idxOf(legal.robberHexes())) out.push(`move_robber:${i}`);
      break;
    case CONTEXTS.ROLL:
      out.push("roll");
      break;
    case CONTEXTS.DISCARD:
      out.push("discard");
      break;
    default:
      break;
  }
  // End turn is available whenever it's our main-phase turn and we're not mid-forced-action.
  if (state.currentTurnColor === state.us && (ctx === CONTEXTS.NONE || ctx === CONTEXTS.BUILD_SETTLEMENT || ctx === CONTEXTS.BUILD_CITY || ctx === CONTEXTS.BUILD_ROAD)) {
    out.push("end_turn");
  }
  return out;
}

function describeEvent(e, state) {
  const you = (c) => (c === state.us ? "you" : "P" + c);
  switch (e.kind) {
    case "gain": return `${you(e.color)} got ${e.resources.join(", ") || "resources"}`;
    case "year-of-plenty": return `${you(e.color)} took ${e.resources.join(", ")} (year of plenty)`;
    case "steal": return `${you(e.thief)} stole ${e.count} from ${you(e.victim)}${e.revealed.length ? " (" + e.revealed.join(",") + ")" : ""}`;
    case "dev-played": return `${you(e.color)} played ${e.dev}`;
    case "trade": return `${you(e.from)} traded ${e.gave.join(",") || "?"} → ${e.got.join(",") || "?"} with ${you(e.to)}`;
    case "buy-dev": return `${you(e.color)} bought a development card`;
    default: return e.kind;
  }
}
