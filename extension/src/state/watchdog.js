/**
 * src/state/watchdog.js — re-export shim.
 *
 * The desync watchdog now lives in the standalone engine (catan-interface). This file re-exports
 * it so any remaining importer keeps working, with a SINGLE source of truth.
 */
export { attachWatchdog } from "../../catan-interface/src/state/watchdog.js";
