/**
 * catan-interface — public entry (barrel) + createEngine.
 *
 * The ONLY public surface of the engine. Everything a consumer (extension, LLM agent, tests)
 * uses comes through here. Internal files under src/ are private.
 *
 * The engine is TRANSPORT-AGNOSTIC: you feed it inbound bytes (engine.ingest) and give it an
 * outbound `send(bytes)` callback; it owns the game channel + sequence counter internally.
 */
import { GameState } from "./src/state/gameState.js";
import { attachWatchdog } from "./src/state/watchdog.js";
import { EventBus } from "./src/state/eventBus.js";
import { InteractionController } from "./src/domain/controller.js";
import {
  legalSettlementCorners, legalCityCorners, legalRoadEdges, legalRobberHexes, stealTargetsAtHex,
} from "./src/domain/legal.js";
import { Tracker } from "./src/tracker/tracker.js";
import { buildObservation } from "./src/api/observation.js";
import { createActions } from "./src/api/actions.js";
import { decodeFrame, decodeOutgoing, encodeChannel } from "./src/protocol/frames.js";

// ---- public re-exports ------------------------------------------------------------------------
export { RESOURCE, RESOURCE_NAME, RESOURCE_ID, DEVCARD, DEVCARD_NAME, DEVCARD_ID, ACTION, BUILDING, PLAYER_HEX, PLAYER_COLOR_NAME, COST } from "./src/domain/enums.js";
export { CONTEXTS } from "./src/domain/controller.js";
export { OBSERVATION_SCHEMA, ACTION_SCHEMAS, ACTION_DESCRIPTIONS, TOOL_DEFINITIONS } from "./src/api/schema.js";
export { msgpackDecode, MsgpackDecoder } from "./src/protocol/decode.js";
export { msgpackEncode } from "./src/protocol/encode.js";
export { decodeFrame, decodeOutgoing, encodeChannel } from "./src/protocol/frames.js";
// Board geometry (a 3D renderer imports these instead of a copy).
export {
  hexCenter, hexCorners, cornerHexes, cornerEdges, edgeCorners, cornerPos, cornerPosExact, edgePos, SQRT3,
} from "./src/domain/boardGeometry.js";

/**
 * Create an engine instance.
 *
 * @param {object} opts
 * @param {(bytes:Uint8Array)=>void} [opts.send]  transmit raw outbound bytes on the real socket.
 *   The engine encodes the game frame; the adapter just transmits. If omitted, actions that send
 *   will report { ok:false, error:"no transport" }.
 * @param {()=>number} [opts.now]  injectable clock (Node tests pass a fake). Defaults to Date.now.
 * @returns engine — see the returned object's shape (getState/getObservation/legal/tracker/actions
 *   /on/ingest/...).
 */
export function createEngine(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const transmit = typeof opts.send === "function" ? opts.send : null;

  const bus = new EventBus();
  const state = new GameState({ now });
  const controller = new InteractionController(state);
  const tracker = new Tracker(state, { now });
  const watchdog = attachWatchdog(state, { now, onDesync: (drift) => bus.emit("desync", drift) });

  // Channel + sequence ownership. We learn the game channel (serverId) and the latest outgoing
  // sequence by sniffing outbound frames we transmit AND, defensively, inbound handshake payloads.
  const wire = { channel: null, sequence: 0, open: true };

  // Fan out state changes.
  state.subscribe((s, evt) => {
    bus.emit("change", s);
    if (evt && evt.kind === "diff") bus.emit("event", { kind: "diff", diff: evt.diff });
    if (evt && evt.kind === "snapshot") bus.emit("event", { kind: "snapshot" });
  });

  // ---- inbound ---------------------------------------------------------------------------------
  /**
   * Ingest one inbound raw frame. Accepts a Uint8Array / ArrayBuffer (binary), a string (text),
   * or an already-shaped { dir, kind, bytes|b64|text } frame object (as the harness relays).
   */
  function ingest(input) {
    const frame = toInboundFrame(input);
    if (!frame) return;
    // learn the game channel from the type-1 handshake payload if present
    let decoded = null;
    try { decoded = decodeFrame(frame); } catch { return; }
    if (!decoded) return;
    if (decoded.dir === "in") {
      if (decoded.id === "130" && decoded.type === 1 && decoded.payload && decoded.payload.serverId) {
        wire.channel = decoded.payload.serverId;
      }
      state.applyIncoming(decoded);
    }
  }

  // ---- outbound --------------------------------------------------------------------------------
  /** Set the game channel serverId explicitly (an adapter that sniffs it can inform the engine). */
  function setChannel(ch) { if (ch) wire.channel = ch; }
  /** Inform the engine of the latest observed outgoing sequence (from an adapter sniffing sends). */
  function setSequence(n) { if (typeof n === "number") wire.sequence = n; }

  /**
   * Encode + transmit one game action on the game channel. Owns the sequence counter.
   * Returns { ok, error?, action, payload, sequence?, channel? }.
   */
  function sendAction(action, payload) {
    if (!transmit) return { ok: false, error: "no transport (createEngine was called without send)" };
    if (!wire.channel) return { ok: false, error: "no game channel yet (waiting for handshake / setChannel)" };
    const sequence = (wire.sequence || 0) + 1;
    try {
      const bytes = encodeChannel(wire.channel, action, payload, sequence);
      transmit(bytes);
      wire.sequence = sequence;
      bus.emit("action", { action, payload, sequence });
      return { ok: true, action, payload, sequence, channel: wire.channel };
    } catch (e) { return { ok: false, error: String((e && e.message) || e), action, payload }; }
  }

  // ---- legal facade ----------------------------------------------------------------------------
  const legal = {
    settlements: () => (state.ready ? legalSettlementCorners(state, { setup: controller.isSetup() }) : []),
    cities: () => (state.ready ? legalCityCorners(state) : []),
    roads: () => (state.ready ? legalRoadEdges(state, { setup: controller.isSetup(), fromCorner: controller._fromCorner || null }) : []),
    robberHexes: () => (state.ready ? legalRobberHexes(state) : []),
    stealTargets: (hex) => (state.ready ? stealTargetsAtHex(state, hex) : []),
    all: () => ({
      settlements: legal.settlements(), cities: legal.cities(), roads: legal.roads(), robberHexes: legal.robberHexes(),
    }),
  };

  const actions = createActions({ state, legal, controller, sendAction });

  // ---- public engine object --------------------------------------------------------------------
  const engine = {
    // subscriptions
    on: (name, fn) => bus.on(name, fn),
    once: (name, fn) => bus.once(name, fn),
    off: (name, fn) => bus.off(name, fn),

    // inbound / outbound transport
    ingest,
    setChannel,
    setSequence,
    sendAction,           // low-level escape hatch (verified action ids only)

    // state + views
    getState: () => state,
    getObservation: () => buildObservation(state, tracker, controller, legal),
    get ready() { return state.ready; },
    get wire() { return { channel: wire.channel, sequence: wire.sequence }; },

    // facades
    legal,
    tracker,
    controller,
    actions,
    watchdog,

    // lifecycle
    reset: () => state.reset(),
    dispose: () => { try { tracker.dispose(); } catch {} try { watchdog.detach(); } catch {} bus.removeAll(); },
  };
  return engine;
}

// ---- inbound frame normalization --------------------------------------------------------------
function toInboundFrame(input) {
  if (input == null) return null;
  // already a shaped frame?
  if (typeof input === "object" && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer) && (input.kind || input.dir)) {
    return { dir: input.dir || "in", kind: input.kind || (input.text != null ? "text" : "binary"), text: input.text, b64: input.b64, bytes: input.bytes };
  }
  if (typeof input === "string") return { dir: "in", kind: "text", text: input };
  if (input instanceof ArrayBuffer) return { dir: "in", kind: "binary", bytes: new Uint8Array(input) };
  if (ArrayBuffer.isView(input)) return { dir: "in", kind: "binary", bytes: new Uint8Array(input.buffer, input.byteOffset, input.byteLength) };
  return null;
}
