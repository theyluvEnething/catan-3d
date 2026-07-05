/**
 * src/interact/legal.js — re-export shim.
 *
 * The legal-move rules now live in the standalone engine (catan-interface). This file re-exports
 * them so the interaction code keeps importing "./legal.js" unchanged, while there is a SINGLE
 * source of truth (no copy). The engine owns the logic; the extension consumes it.
 */
export {
  legalSettlementCorners,
  legalCityCorners,
  legalRoadEdges,
  legalRobberHexes,
  stealTargetsAtHex,
} from "../../catan-interface/src/domain/legal.js";
