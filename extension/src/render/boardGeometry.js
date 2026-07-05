/**
 * src/render/boardGeometry.js — re-export shim.
 *
 * The board geometry now lives in the standalone engine (catan-interface). This file re-exports
 * it so the renderer/interaction code keeps importing "../render/boardGeometry.js" unchanged,
 * while there is a SINGLE source of truth (no copy). The engine is the owner; the extension
 * consumes it (dependency arrow points inward).
 */
export {
  SQRT3,
  hexCenter,
  hexCorners,
  cornerHexes,
  cornerEdges,
  edgeCorners,
  cornerPos,
  cornerPosExact,
  edgePos,
  applySimilarity,
} from "../../catan-interface/src/domain/boardGeometry.js";
