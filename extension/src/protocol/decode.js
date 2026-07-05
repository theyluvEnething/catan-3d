/**
 * src/protocol/decode.js — re-export shim.
 *
 * The protocol (MessagePack decode/encode + Colonist framing) now lives in the standalone engine
 * (catan-interface). This file re-exports it so any remaining importer keeps working, with a
 * SINGLE source of truth. The engine is split into decode.js (decoder), encode.js (encoder), and
 * frames.js (decodeFrame/decodeOutgoing/encodeChannel); this shim recombines them under the old
 * import path.
 */
export { MsgpackDecoder, msgpackDecode } from "../../catan-interface/src/protocol/decode.js";
export { msgpackEncode } from "../../catan-interface/src/protocol/encode.js";
export { decodeFrame, decodeOutgoing, encodeChannel } from "../../catan-interface/src/protocol/frames.js";
