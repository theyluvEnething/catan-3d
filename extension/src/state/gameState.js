/**
 * src/state/gameState.js — re-export shim.
 *
 * Game-state reconstruction now lives in the standalone engine (catan-interface). This file
 * re-exports it so any remaining importer keeps working, with a SINGLE source of truth.
 */
export { GameState, deepMerge } from "../../catan-interface/src/state/gameState.js";
