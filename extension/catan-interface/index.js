/**
 * catan-interface — public entry (barrel).
 *
 * The ONLY public surface of the engine. Everything a consumer (extension, LLM agent, tests)
 * uses comes through here. Internal files under src/ are private.
 *
 * NOTE: filled out across the extraction stages. Protocol is live; state/domain/tracker/api
 * are added in subsequent stages.
 */

// Protocol (verified wire format) — exported for adapters/tests that need raw framing.
export { msgpackDecode, MsgpackDecoder } from "./src/protocol/decode.js";
export { msgpackEncode } from "./src/protocol/encode.js";
export { decodeFrame, decodeOutgoing, encodeChannel } from "./src/protocol/frames.js";
