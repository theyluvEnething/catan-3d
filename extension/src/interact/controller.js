/**
 * src/interact/controller.js — interaction controller (Phase 3 UI brain).
 *
 * Pure logic, no DOM. Given the reconstructed GameState, it derives the current interaction
 * CONTEXT — what a click on the 3D board should mean right now — from the state's turn/phase
 * fields, and exposes the small API the UI (Forwarder / HUD buttons) drives:
 *
 *   canAct()        -> boolean: is it our turn AND is there something we may do?
 *   context()       -> one of the CONTEXTS strings (below), or "none".
 *   legalTargets()  -> the legal corners/edges/hexes for the current context (delegates legal.js).
 *
 * ── Context vocabulary ──────────────────────────────────────────────────────────────────────
 *   "setup-settlement"  place the opening settlement (setup phase)
 *   "setup-road"        place the road attached to the just-placed opening settlement
 *   "build-settlement"  main phase: build a settlement (needs road connection + distance rule)
 *   "build-city"        main phase: upgrade one of our settlements to a city
 *   "build-road"        main phase: build a road
 *   "move-robber"       place / move the robber on a hex
 *   "roll"              our main turn has begun but the dice are not yet thrown
 *   "discard"           a 7 was rolled and we must discard down to the hand limit
 *   "none"              nothing for us to do (not our turn, or an unhandled/idle sub-state)
 *
 * ── State fields relied on (all GameState getters over gameState.currentState / diceState) ────
 *   state.us                  our player color
 *   state.currentTurnColor    currentState.currentTurnPlayerColor — whose turn it is
 *   state.actionState         currentState.actionState  (1 normal, 3 must-place-road,
 *                                                         24 moving-robber, 27 select-steal)
 *   state.completedTurns      currentState.completedTurns  (< 8 ⇒ opening setup, base 4p)
 *   state.turnState           currentState.turnState  (coarse phase; kept for future use)
 *   state.dice                {thrown, ...} derived from diceState.diceThrown
 *
 * The setup / actionState enum values below are the ones verified in forward.js + NOTES.md
 * from live captures. `SETUP_TURNS` = 8 is the two-round opening for a 4-player base game
 * (2 placements × 4 players); each placement bumps completedTurns once its road lands.
 */
import {
  legalSettlementCorners,
  legalCityCorners,
  legalRoadEdges,
  legalRobberHexes,
} from "./legal.js";

// actionState enum (verified from live diffs — see forward.js / NOTES.md §type-91).
const AS_NORMAL = 1; // normal: awaiting a WANT_BUILD_* / roll / pass
const AS_PLACE_ROAD = 3; // must place a road (post-settlement, incl. setup 2nd half)
const AS_MOVE_ROBBER = 24; // moving the robber
const AS_SELECT_STEAL = 27; // choosing a steal victim (no board target — handled elsewhere)

// Opening-phase length for a base 4-player game (2 rounds × 4 players).
const SETUP_TURNS = 8;

export const CONTEXTS = Object.freeze({
  SETUP_SETTLEMENT: "setup-settlement",
  SETUP_ROAD: "setup-road",
  BUILD_SETTLEMENT: "build-settlement",
  BUILD_CITY: "build-city",
  BUILD_ROAD: "build-road",
  MOVE_ROBBER: "move-robber",
  ROLL: "roll",
  DISCARD: "discard",
  NONE: "none",
});

export class InteractionController {
  /**
   * @param {GameState} state  the live state model (from src/state/gameState.js)
   */
  constructor(state) {
    this.state = state;
    // UI-selected build intent for the ambiguous main-phase build choice.
    // The state alone can't tell settlement-vs-city-vs-road once we're in the normal
    // action state, so a build-mode button sets this; cleared when it no longer applies.
    this._buildMode = null; // "settlement" | "city" | "road" | null
    // Set by the UI when a 7 forces us to discard (driven by Colonist's discard prompt,
    // which is a client-side modal, not a distinct board actionState).
    this._mustDiscard = false;
  }

  // ── UI-driven mode setters ────────────────────────────────────────────────
  /** UI build buttons call this: "settlement" | "city" | "road" | null. */
  setBuildMode(mode) {
    this._buildMode = mode || null;
    return this;
  }
  clearBuildMode() {
    this._buildMode = null;
    return this;
  }
  /** UI calls this when the discard prompt appears / clears. */
  setMustDiscard(flag) {
    this._mustDiscard = !!flag;
    return this;
  }

  // ── Core queries ──────────────────────────────────────────────────────────
  /** Is it our turn? */
  isOurTurn() {
    const s = this.state;
    return s.ready && s.us != null && s.currentTurnColor === s.us;
  }

  /** True when we are still in the opening placement phase. */
  isSetup() {
    return (this.state.completedTurns ?? 0) < SETUP_TURNS;
  }

  /**
   * The current interaction context, derived purely from state (+ UI build mode).
   * Returns one of CONTEXTS.* (a string). "none" when there's no board action for us.
   */
  context() {
    const s = this.state;
    if (!this.isOurTurn()) return CONTEXTS.NONE;

    const as = s.actionState;

    // Robber placement takes precedence whenever the engine is in that sub-state
    // (can occur mid-turn after rolling a 7). Steal-victim selection has no board
    // target here, so it is treated as "none" for the board-forwarding layer.
    if (as === AS_MOVE_ROBBER) return CONTEXTS.MOVE_ROBBER;
    if (as === AS_SELECT_STEAL) return CONTEXTS.NONE;

    // Forced discard (7 rolled) — surfaced by the UI, not a distinct board actionState.
    if (this._mustDiscard) return CONTEXTS.DISCARD;

    if (this.isSetup()) {
      // Opening: actionState 3 means "place the road for the settlement just placed",
      // otherwise we're placing the opening settlement.
      return as === AS_PLACE_ROAD
        ? CONTEXTS.SETUP_ROAD
        : CONTEXTS.SETUP_SETTLEMENT;
    }

    // ── Main phase ──
    // Before the dice are thrown on our turn, the only action is to roll.
    const dice = s.dice;
    if (as === AS_NORMAL && dice && dice.thrown === false) return CONTEXTS.ROLL;

    // A pending road placement (e.g. from a Road Building dev card, or a mid-turn
    // WANT_BUILD_ROAD) is unambiguous from state.
    if (as === AS_PLACE_ROAD) return CONTEXTS.BUILD_ROAD;

    // Otherwise (normal action state, dice thrown) the specific build is a UI choice.
    if (as === AS_NORMAL) {
      if (this._buildMode === "city") return CONTEXTS.BUILD_CITY;
      if (this._buildMode === "road") return CONTEXTS.BUILD_ROAD;
      if (this._buildMode === "settlement") return CONTEXTS.BUILD_SETTLEMENT;
      return CONTEXTS.NONE; // our turn, dice thrown, no build selected → idle
    }

    return CONTEXTS.NONE;
  }

  /**
   * Can the UI act right now? True whenever the derived context is something the
   * player can perform (i.e. not "none").
   */
  canAct() {
    return this.context() !== CONTEXTS.NONE;
  }

  /**
   * Legal board targets for the current context, delegating to legal.js.
   * Returns { kind, targets } where kind ∈ "corner"|"edge"|"hex"|null so the UI
   * knows which pick layer to light up. `targets` is [] for non-board contexts
   * (roll / discard / none).
   */
  legalTargets() {
    const s = this.state;
    const ctx = this.context();
    switch (ctx) {
      case CONTEXTS.SETUP_SETTLEMENT:
        return { kind: "corner", context: ctx, targets: legalSettlementCorners(s, { setup: true }) };
      case CONTEXTS.BUILD_SETTLEMENT:
        return { kind: "corner", context: ctx, targets: legalSettlementCorners(s, { setup: false }) };
      case CONTEXTS.BUILD_CITY:
        return { kind: "corner", context: ctx, targets: legalCityCorners(s) };
      case CONTEXTS.SETUP_ROAD:
        // In setup the legal roads hang off the settlement we just placed. If the UI
        // tracked that corner it can pass it via setFromCorner(); otherwise legal.js
        // falls back to the connectivity rule.
        return {
          kind: "edge",
          context: ctx,
          targets: legalRoadEdges(s, { setup: true, fromCorner: this._fromCorner || null }),
        };
      case CONTEXTS.BUILD_ROAD:
        return { kind: "edge", context: ctx, targets: legalRoadEdges(s, { setup: false }) };
      case CONTEXTS.MOVE_ROBBER:
        return { kind: "hex", context: ctx, targets: legalRobberHexes(s) };
      case CONTEXTS.ROLL:
      case CONTEXTS.DISCARD:
      case CONTEXTS.NONE:
      default:
        return { kind: null, context: ctx, targets: [] };
    }
  }

  /** UI records the just-placed setup settlement so setup-road can be constrained to it. */
  setFromCorner(corner) {
    this._fromCorner = corner || null;
    return this;
  }
}

export default InteractionController;
