/**
 * src/protocol/frames.js — Colonist.io frame (de)framing on top of MessagePack.
 *
 * VERIFIED framing (NOTES.md §2):
 *   - Handshake: 2 TEXT JSON frames.
 *   - Incoming binary: bare MessagePack  ->  { id, data:{ type, payload, sequence? } }.
 *   - Outgoing binary: [b0][seq][strlen][channel(strlen)][msgpack body].
 *       b0=0x02 channel message, body = { action, payload }.
 *       b0=0x03 game-channel build message (what we emit), body = { action, payload, sequence }.
 *       b0=0x04 direct  message, body = { id, data }.
 *
 * No DOM/Node/external imports. Base64 helpers use atob (global in browsers and Node >=16); a
 * pure-JS fallback is provided so a capture with `bytes` (not `b64`) needs no atob at all.
 */
import { MsgpackDecoder, msgpackDecode } from "./decode.js";
import { msgpackEncode, encodeUtf8 } from "./encode.js";

/**
 * Decode a captured/relayed frame into a normalized structure.
 * `frame` = { dir, kind, text?, b64?/bytes? }.
 * Returns { dir, transport, ...decoded } or a text wrapper.
 */
export function decodeFrame(frame) {
  if (frame.kind === "text") {
    let json = null;
    try { json = JSON.parse(frame.text); } catch {}
    return { dir: frame.dir, transport: "text", json, raw: frame.text };
  }
  const bytes = frame.bytes ? toU8(frame.bytes) : b64ToU8(frame.b64);
  if (frame.dir === "in") {
    // bare msgpack
    const obj = msgpackDecode(bytes);
    return {
      dir: "in",
      transport: "msgpack",
      id: obj && obj.id,
      type: obj && obj.data && obj.data.type,
      payload: obj && obj.data && obj.data.payload,
      sequence: obj && obj.data && obj.data.sequence,
      msg: obj,
    };
  }
  // outgoing: [b0][seq][strlen][channel][msgpack body]
  return decodeOutgoing(bytes);
}

export function decodeOutgoing(bytes) {
  const u8 = toU8(bytes);
  const b0 = u8[0];
  const seq = u8[1];
  const strlen = u8[2];
  const channel = strlen ? new MsgpackDecoder(u8.subarray(3, 3 + strlen))._str(strlen) : "";
  const body = msgpackDecode(u8.subarray(3 + strlen));
  return {
    dir: "out",
    transport: "colonist-out",
    b0,
    seq,
    channel,
    kind: b0 === 0x02 ? "channel" : b0 === 0x04 ? "direct" : b0 === 0x03 ? "game" : "unknown(" + b0 + ")",
    action: body && body.action,
    payload: body && body.payload,
    body,
  };
}

/**
 * Encode an OUTGOING game-channel message. VERIFIED byte-exact against captured build frames:
 *   [0x03][0x01][strlen][channel bytes][msgpack {action, payload, sequence}]
 * The frame header byte is 0x03 (game channel) and byte[1] is 0x01 (constant on captured frames).
 * `sequence` is the per-channel client counter and MUST be inside the msgpack body.
 *
 * @param channel  game serverId string (e.g. "012B34")
 * @param action   action id (15=settlement, 11=road, ...)
 * @param payload  board index (cornerIndex / edgeIndex), object, or null
 * @param sequence per-channel outgoing counter (next value)
 */
export function encodeChannel(channel, action, payload, sequence, b0 = 0x03, hdr1 = 0x01) {
  const chan = encodeUtf8(channel);
  const body = msgpackEncode({ action, payload, sequence });
  const out = new Uint8Array(3 + chan.length + body.length);
  out[0] = b0; out[1] = hdr1; out[2] = chan.length;
  out.set(chan, 3);
  out.set(body, 3 + chan.length);
  return out;
}

// ----------------------------- helpers -------------------------------------
function b64ToU8(b64) {
  if (b64 == null) return new Uint8Array(0);
  if (typeof atob === "function") {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  // Pure-JS base64 fallback (no atob) — keeps the module usable anywhere.
  return _b64Decode(b64);
}

const _B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function _b64Decode(str) {
  const clean = str.replace(/[^A-Za-z0-9+/]/g, "");
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const e1 = _B64.indexOf(clean[i]);
    const e2 = _B64.indexOf(clean[i + 1]);
    const e3 = _B64.indexOf(clean[i + 2]);
    const e4 = _B64.indexOf(clean[i + 3]);
    const n = (e1 << 18) | (e2 << 12) | ((e3 & 63) << 6) | (e4 & 63);
    out.push((n >> 16) & 0xff);
    if (e3 !== -1 && clean[i + 2] !== undefined) out.push((n >> 8) & 0xff);
    if (e4 !== -1 && clean[i + 3] !== undefined) out.push(n & 0xff);
  }
  return Uint8Array.from(out);
}

export function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  return Uint8Array.from(x);
}
