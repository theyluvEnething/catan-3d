/**
 * src/api/schema.js — JSON Schemas for the Observation and every Action's arguments.
 *
 * A later LLM agent gets machine-readable tool definitions for free: OBSERVATION_SCHEMA
 * documents the state it sees; ACTION_SCHEMAS[name] documents the args each tool accepts.
 * TOOL_DEFINITIONS packages them as an OpenAI/Anthropic-style function/tool list.
 *
 * Plain data, no imports. Draft-07 JSON Schema.
 */

const RESOURCE_COUNTS = {
  type: "object",
  properties: {
    wood: { type: "integer", minimum: 0 }, brick: { type: "integer", minimum: 0 },
    sheep: { type: "integer", minimum: 0 }, wheat: { type: "integer", minimum: 0 },
    ore: { type: "integer", minimum: 0 },
  },
  required: ["wood", "brick", "sheep", "wheat", "ore"],
  additionalProperties: false,
};

export const OBSERVATION_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "CatanObservation",
  type: "object",
  properties: {
    phase: { type: "string", enum: ["connecting", "setup", "main", "roll", "discard", "move-robber", "idle"] },
    turn: { type: ["string", "null"], description: "player id whose turn it is, e.g. 'P2'" },
    you: { type: ["string", "null"], description: "your player id" },
    canAct: { type: "boolean" },
    board: {
      type: "object",
      properties: {
        hexes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              resource: { type: "string", enum: ["wood", "brick", "sheep", "wheat", "ore", "desert", "unknown"] },
              number: { type: "integer", minimum: 0, maximum: 12 },
              robber: { type: "boolean" },
            },
            required: ["id", "resource", "number", "robber"],
          },
        },
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              owner: { type: ["string", "null"] },
              building: { type: ["string", "null"], enum: ["settlement", "city", null] },
              port: { type: ["string", "null"], description: "'3:1' or '2:1-<resource>' or null" },
              hexes: { type: "array", items: { type: "integer" } },
            },
            required: ["id", "owner", "building", "port", "hexes"],
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              owner: { type: ["string", "null"] },
              nodes: { type: "array", items: { type: ["integer", "null"] }, minItems: 2, maxItems: 2 },
            },
            required: ["id", "owner", "nodes"],
          },
        },
      },
      required: ["hexes", "nodes", "edges"],
    },
    players: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, color: { type: "integer" }, colorName: { type: "string" },
          name: { type: "string" }, isBot: { type: "boolean" }, isYou: { type: "boolean" },
          vpPublic: { type: "integer" }, resourceCount: { type: "integer" }, devCount: { type: "integer" },
          knightsPlayed: { type: "integer" },
          settlementsLeft: { type: ["integer", "null"] }, citiesLeft: { type: ["integer", "null"] },
          roadsLeft: { type: ["integer", "null"] }, longestRoadLen: { type: "integer" },
          longestRoad: { type: "boolean" }, largestArmy: { type: "boolean" },
        },
        required: ["id", "color", "vpPublic", "resourceCount", "devCount"],
      },
    },
    hand: RESOURCE_COUNTS,
    devHand: { type: "array", items: { type: "string" } },
    legalActions: { type: "array", items: { type: "string" }, description: "flat action strings, e.g. 'build_road:14'" },
    bank: RESOURCE_COUNTS,
    log: { type: "array", items: { type: "string" } },
  },
  required: ["phase", "turn", "you", "canAct", "board", "players", "hand", "devHand", "legalActions", "bank", "log"],
};

// ---- Action argument schemas ------------------------------------------------------------------
const NODE = { type: "integer", description: "board node (corner) id from observation.board.nodes[].id" };
const EDGE = { type: "integer", description: "board edge id from observation.board.edges[].id" };
const HEX = { type: "integer", description: "board hex id from observation.board.hexes[].id" };

export const ACTION_SCHEMAS = {
  build_settlement: { type: "object", properties: { node: NODE }, required: ["node"], additionalProperties: false },
  build_city: { type: "object", properties: { node: NODE }, required: ["node"], additionalProperties: false },
  build_road: { type: "object", properties: { edge: EDGE }, required: ["edge"], additionalProperties: false },
  roll: { type: "object", properties: {}, additionalProperties: false },
  end_turn: { type: "object", properties: {}, additionalProperties: false },
  move_robber: {
    type: "object",
    properties: { hex: HEX, victim: { type: ["string", "null"], description: "player id to steal from (optional)" } },
    required: ["hex"], additionalProperties: false,
  },
  discard: {
    type: "object",
    properties: { cards: RESOURCE_COUNTS },
    required: ["cards"], additionalProperties: false,
  },
  respond_trade: {
    type: "object",
    properties: { id: { type: ["string", "integer"] }, accept: { type: "boolean" } },
    required: ["id", "accept"], additionalProperties: false,
  },
  // Present but unimplemented (action ids not reverse-engineered). Args documented for the future.
  buy_dev_card: { type: "object", properties: {}, additionalProperties: false },
  play_dev: {
    type: "object",
    properties: {
      card: { type: "string", enum: ["knight", "monopoly", "road-building", "year-of-plenty"] },
      args: { type: "object", description: "card-specific args (e.g. monopoly resource, YoP picks)" },
    },
    required: ["card"], additionalProperties: false,
  },
  bank_trade: {
    type: "object",
    properties: { give: RESOURCE_COUNTS, get: RESOURCE_COUNTS },
    required: ["give", "get"], additionalProperties: false,
  },
  create_trade: {
    type: "object",
    properties: {
      offer: RESOURCE_COUNTS, want: RESOURCE_COUNTS,
      targets: { type: "array", items: { type: "string" }, description: "player ids to offer to (empty = all)" },
    },
    required: ["offer", "want"], additionalProperties: false,
  },
};

/** Human/LLM-facing descriptions for each tool. */
export const ACTION_DESCRIPTIONS = {
  build_settlement: "Build a settlement on a legal node (verified).",
  build_city: "Upgrade one of your settlements to a city on a legal node (verified).",
  build_road: "Build a road on a legal edge (verified).",
  roll: "Roll the dice (client shortcut; no verified game-action id — adapter simulates Spacebar).",
  end_turn: "End your turn / pass (verified).",
  move_robber: "Move the robber to a hex and optionally choose a steal victim (verified move; victim follow-up handled by UI).",
  discard: "Discard cards when a 7 forces it (verified; one frame per card).",
  respond_trade: "Accept or decline an incoming trade offer by id (verified).",
  buy_dev_card: "Buy a development card. UNIMPLEMENTED: action id not yet reverse-engineered.",
  play_dev: "Play a development card. UNIMPLEMENTED: action id not yet reverse-engineered.",
  bank_trade: "Trade with the bank/port. UNIMPLEMENTED: action id not yet reverse-engineered.",
  create_trade: "Create a trade offer to other players. UNIMPLEMENTED: action id not yet reverse-engineered.",
};

/** OpenAI/Anthropic-style tool definitions (function name + description + JSON-Schema params). */
export const TOOL_DEFINITIONS = Object.keys(ACTION_SCHEMAS).map((name) => ({
  type: "function",
  function: {
    name,
    description: ACTION_DESCRIPTIONS[name] || name,
    parameters: ACTION_SCHEMAS[name],
  },
}));
