/**
 * MAIN-world WebSocket interceptor.
 *
 * Runs at document_start in the PAGE's world (world: "MAIN") so it can monkey-patch
 * window.WebSocket BEFORE Colonist constructs its game socket. Captures BOTH directions
 * (outgoing .send and incoming 'message') with a timestamp + direction, and bridges each
 * frame to the isolated-world content script via window.postMessage.
 *
 * The isolated content-script world CANNOT see the page's WebSocket instance directly,
 * so this postMessage bridge is mandatory.
 *
 * This file is intentionally protocol-AGNOSTIC: it forwards raw frames only. All decoding
 * lives in src/protocol/decode.js (isolated world). The one protocol-adjacent thing we do
 * here is opportunistically locate Colonist's OWN encode/decode inside its webpack runtime,
 * because that runs in this world — but that is a best-effort fallback, gated behind a flag.
 */
(() => {
  "use strict";
  // Colonist's game runs in the top frame; skip ad/analytics iframes.
  try { if (window.top !== window.self) return; } catch { return; }

  const BRIDGE = "CATAN3D_FRAME"; // postMessage type for captured frames
  const TAG = "[catan3d/interceptor]";

  // Monotonic-ish timestamp. performance.now() is high-res; pair with a wall-clock origin.
  const T0 = Date.now();
  const now = () => T0 + performance.now();

  // --- base64 helpers for binary frames (ArrayBuffer/typed array) ---
  function bytesToB64(bytes) {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  let seq = 0;
  function post(dir, payload) {
    // payload: { kind: 'text'|'binary', text?, b64?, byteLength? }
    window.postMessage(
      {
        source: BRIDGE,
        dir, // 'in' (server->client) or 'out' (client->server)
        seq: seq++,
        t: now(),
        ...payload,
      },
      window.location.origin
    );
  }

  function normalizeAndPost(dir, data) {
    try {
      if (typeof data === "string") {
        post(dir, { kind: "text", text: data });
        return;
      }
      if (data instanceof ArrayBuffer) {
        post(dir, {
          kind: "binary",
          b64: bytesToB64(new Uint8Array(data)),
          byteLength: data.byteLength,
        });
        return;
      }
      if (ArrayBuffer.isView(data)) {
        const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        post(dir, { kind: "binary", b64: bytesToB64(view), byteLength: data.byteLength });
        return;
      }
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        // Blob is async; read then post preserving order best-effort via seq.
        data.arrayBuffer().then((buf) => {
          post(dir, {
            kind: "binary",
            b64: bytesToB64(new Uint8Array(buf)),
            byteLength: buf.byteLength,
            wasBlob: true,
          });
        });
        return;
      }
      // Unknown type — stringify a description so we at least see it in dumps.
      post(dir, { kind: "text", text: `[unknown ${Object.prototype.toString.call(data)}]` });
    } catch (e) {
      // Never let capture break the game.
      console.warn(TAG, "capture error", e);
    }
  }

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) {
    console.warn(TAG, "no native WebSocket found; aborting");
    return;
  }

  // --- PURE BYTE TRANSPORT (MAIN world owns the real socket) --------------------------------
  // The isolated content script can't touch the page socket. ALL protocol encoding/decoding now
  // lives in the catan-interface engine (isolated world). MAIN only:
  //   1) forwards every inbound + outbound frame to ISOLATED (so the engine can decode state and
  //      learn the game channel/sequence from Colonist's own outbound frames), and
  //   2) accepts a { source:'CATAN3D_TRANSMIT', b64 } message and calls socket.send with those
  //      exact bytes — no encoding here.
  const wire = { socket: null };

  function b64ToU8(b64) {
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function PatchedWebSocket(...args) {
    const socket = new NativeWebSocket(...args);
    try {
      console.debug(TAG, "socket opened:", args[0]);
      socket.addEventListener("message", (ev) => normalizeAndPost("in", ev.data));
    } catch (e) {
      console.warn(TAG, "attach listener failed", e);
    }

    // Wrap send (client -> server): forward a copy to ISOLATED (so the engine learns channel/seq),
    // then send unchanged. Remember the socket + its native send for our own transmits.
    const nativeSend = socket.send;
    socket.send = function (data) {
      normalizeAndPost("out", data);
      try {
        let u8 = null;
        if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
        else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (u8 && u8[0] === 0x03) { wire.socket = socket; wire._nativeSend = nativeSend; }
      } catch {}
      return nativeSend.apply(this, arguments);
    };
    // Track the socket as soon as it opens, even before Colonist's first game send.
    try { socket.addEventListener("open", () => { wire.socket = socket; wire._nativeSend = nativeSend; }); } catch {}
    return socket;
  }

  // Preserve statics/prototype so page code that reads WebSocket.OPEN etc. still works.
  PatchedWebSocket.prototype = NativeWebSocket.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((k) => {
    try { PatchedWebSocket[k] = NativeWebSocket[k]; } catch {}
  });

  window.WebSocket = PatchedWebSocket;
  console.info(TAG, "WebSocket patched at document_start (byte-only transport)");

  // Transmit raw bytes the engine encoded. Byte-only — no protocol logic here.
  function transmitBytes(u8) {
    if (!wire.socket || wire.socket.readyState !== 1) return { ok: false, error: "socket not open" };
    try { (wire._nativeSend || wire.socket.send).call(wire.socket, u8); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  window.__CATAN3D__ = window.__CATAN3D__ || {};
  window.__CATAN3D__.transmit = (u8) => transmitBytes(u8);
  window.__CATAN3D__.wire = () => ({ open: wire.socket && wire.socket.readyState === 1 });

  // Bridge: isolated posts { source:'CATAN3D_TRANSMIT', b64 } → we send those exact bytes.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data) return;
    const d = ev.data;
    if (d.source === "CATAN3D_TRANSMIT" && d.b64) {
      transmitBytes(b64ToU8(d.b64));
    }
  });
})();
