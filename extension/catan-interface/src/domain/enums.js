/**
 * src/domain/enums.js — the verified game enums (resources, dev cards, colours, building types).
 *
 * All values are VERIFIED against live captured frames (see the repo NOTES.md):
 *   resource ids: 0 = hidden, 1 wood, 2 brick, 3 sheep, 4 wheat, 5 ore
 *   dev-card ids: 10 = hidden/back; 12 = monopoly, 15 = year-of-plenty (confirmed by play);
 *                 11 knight, 13 road-building, 14 victory-point (standard Colonist ordering).
 *   buildingType: 1 = settlement, 2 = city.
 *
 * No DOM, no external imports.
 */

// ---- Resources ------------------------------------------------------------------------------
export const RESOURCE = Object.freeze({ HIDDEN: 0, WOOD: 1, BRICK: 2, SHEEP: 3, WHEAT: 4, ORE: 5 });
export const RESOURCE_NAME = Object.freeze({ 0: "hidden", 1: "wood", 2: "brick", 3: "sheep", 4: "wheat", 5: "ore" });
export const RESOURCE_ID = Object.freeze({ hidden: 0, wood: 1, brick: 2, sheep: 3, wheat: 4, ore: 5 });
export const RESOURCE_ORDER = Object.freeze([1, 2, 3, 4, 5]); // wood, brick, sheep, wheat, ore
export const RESOURCE_NAMES = Object.freeze(["wood", "brick", "sheep", "wheat", "ore"]);

// Hex tile `type` enum (resource produced by the hex). 0 = desert (no production).
export const HEX_RESOURCE = Object.freeze({ 0: "desert", 1: "wood", 2: "brick", 3: "sheep", 4: "wheat", 5: "ore" });

// ---- Development cards -----------------------------------------------------------------------
export const DEVCARD = Object.freeze({ HIDDEN: 10, KNIGHT: 11, MONOPOLY: 12, ROAD_BUILDING: 13, VICTORY_POINT: 14, YEAR_OF_PLENTY: 15 });
export const DEVCARD_NAME = Object.freeze({
  10: "hidden", 11: "knight", 12: "monopoly", 13: "road-building", 14: "victory-point", 15: "year-of-plenty",
});
export const DEVCARD_ID = Object.freeze({
  hidden: 10, knight: 11, monopoly: 12, "road-building": 13, "victory-point": 14, "year-of-plenty": 15,
});
// Total development cards in a standard deck.
export const DEVCARD_DECK_SIZE = 25;

// ---- Buildings ------------------------------------------------------------------------------
export const BUILDING = Object.freeze({ SETTLEMENT: 1, CITY: 2 });
export const BUILDING_NAME = Object.freeze({ 1: "settlement", 2: "city" });

// ---- Player colours (Colonist colour id -> display hex + label) -----------------------------
export const PLAYER_HEX = Object.freeze({
  1: "#e23b3b", 2: "#3f7fd6", 3: "#e08a2e", 4: "#3aa84f",
  11: "#8a5cd1", 12: "#37b3a3", 13: "#d94f9a", 14: "#c9c032",
});
export const PLAYER_COLOR_NAME = Object.freeze({
  1: "red", 2: "blue", 3: "orange", 4: "green",
  11: "purple", 12: "teal", 13: "pink", 14: "yellow",
});

// ---- Piece build costs (resource id -> count) ------------------------------------------------
export const COST = Object.freeze({
  road: Object.freeze({ [RESOURCE.WOOD]: 1, [RESOURCE.BRICK]: 1 }),
  settlement: Object.freeze({ [RESOURCE.WOOD]: 1, [RESOURCE.BRICK]: 1, [RESOURCE.SHEEP]: 1, [RESOURCE.WHEAT]: 1 }),
  city: Object.freeze({ [RESOURCE.WHEAT]: 2, [RESOURCE.ORE]: 3 }),
  devCard: Object.freeze({ [RESOURCE.SHEEP]: 1, [RESOURCE.WHEAT]: 1, [RESOURCE.ORE]: 1 }),
});

// ---- Verified outgoing action ids (NOTES.md — zero-desync set) -------------------------------
// Only the ones proven byte-for-byte against live captures. Unverified actions (buy-dev, play-dev,
// bank-trade, create-trade) are intentionally NOT given ids here — the api layer returns an
// "unimplemented" result for them rather than emitting a guessed action.
export const ACTION = Object.freeze({
  BUILD_SETTLEMENT: 15,   // payload cornerIndex
  BUILD_ROAD: 11,         // payload edgeIndex
  BUILD_CITY: 19,         // payload cornerIndex
  MOVE_ROBBER: 3,         // payload hexIndex
  DISCARD: 2,             // payload true (one frame per card)
  END_TURN: 6,            // payload true (also "pass")
  RESPOND_TRADE: 50,      // payload { id, response }
  ADD_TRADE_CARD: 47,     // payload (trade-builder card add; byproduct capture)
});

// Resource-count helpers ----------------------------------------------------------------------
/** Turn an array of resource ids into a {wood,brick,sheep,wheat,ore} count map (ignores hidden 0). */
export function countResourceArray(arr) {
  const c = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  for (const id of arr || []) { const n = RESOURCE_NAME[id]; if (n && n !== "hidden") c[n]++; }
  return c;
}
/** Count array entries by value → { value: count }. */
export function countBy(arr) {
  const m = {};
  for (const x of arr || []) m[x] = (m[x] || 0) + 1;
  return m;
}
