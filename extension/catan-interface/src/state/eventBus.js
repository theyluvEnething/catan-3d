/**
 * state/eventBus.js — a tiny, dependency-free typed event emitter.
 *
 * Used by createEngine() to expose the public `engine.on(topic, cb)` surface. Kept minimal and
 * synchronous: handlers run in registration order and a throwing handler never breaks the
 * emitter (its error is reported to console but swallowed). No wildcard, no once — the engine
 * only needs a handful of named topics ("change" | "event" | "desync" | "ready").
 *
 * Pure ESM. `console` is available in both browsers and Node; we guard the call anyway.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._topics = new Map();
  }

  /**
   * Subscribe to `topic`. Returns an unsubscribe function.
   * @param {string} topic
   * @param {Function} fn
   * @returns {() => void}
   */
  on(topic, fn) {
    if (typeof fn !== "function") return () => {};
    let set = this._topics.get(topic);
    if (!set) { set = new Set(); this._topics.set(topic, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Remove a single handler (or all handlers for `topic` if `fn` is omitted). */
  off(topic, fn) {
    const set = this._topics.get(topic);
    if (!set) return;
    if (fn) set.delete(fn);
    else set.clear();
  }

  /** Emit `payload` to every handler of `topic`. Errors in handlers are isolated. */
  emit(topic, payload) {
    const set = this._topics.get(topic);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try { fn(payload); }
      catch (e) { try { console.warn("[catan-interface] event handler error on '" + topic + "':", e); } catch {} }
    }
  }

  /** Drop all handlers on all topics. */
  clear() { this._topics.clear(); }
}
