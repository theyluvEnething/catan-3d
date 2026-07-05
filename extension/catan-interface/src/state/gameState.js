/**
 * state/gameState.js — reconstructs the full Catan game state from intercepted frames.
 *
 * Colonist delivers state as:
 *   - a FULL snapshot   (id "130", data.type 4)  -> replace gameState wholesale
 *   - INCREMENTAL diffs (id "130", data.type 91) -> deep-merge `payload.diff` into gameState
 *
 * The diff format (type 91) is a partial object mirroring the gameState tree; applying it is
 * a recursive merge where `null` means delete. This applier is validated against full-game
 * captures (see test/, and the repo NOTES.md §3).
 *
 * This class is protocol-SHAPED but not protocol-DECODING (that's protocol/*). It carries the
 * raw reconstructed `gameState` tree plus convenience getters, an internal subscribe/emit for
 * views (renderer/model), and a `normalizeEvents()` helper that turns a raw diff into a list of
 * structured gameplay events (roll/build/rob/steal/trade/dev/...) for the tracker + observation
 * log. Pure ESM — no DOM, no three.js, no chrome.*.
 */

// gameLog text.type enum (VERIFIED — see NOTES.md §type-91 gameLog vocabulary).
export const LOG = Object.freeze({
  TURN_MARKER: 1,
  PLACE_PIECE: 4,     // { pieceEnum } 2=settlement,0=road,1=city
  BOUGHT_DEV: 5,      // { pieceEnum, isVp }
  DICE: 10,           // { firstDice, secondDice }
  ROBBER_TILE: 11,    // { pieceEnum:5, tileInfo }
  STEAL: 16,          // { playerColorThief, playerColorVictim, cardBacks }
  DEV_PLAYED: 20,     // { playerColor, cardEnum }
  YOP_TAKE: 21,       // { cardEnums:[a,b] }
  END_TURN: 44,
  DISTRIBUTION: 47,   // { playerColor, cardsToBroadcast:[resIds], distributionType }
  ROBBER_BLOCKED: 49, // { tileInfo }
  TRADE_DONE: 115,    // { playerColor, acceptingPlayerColor, givenCardEnums, receivedCardEnums }
  TRADE_OFFER: 118,   // { wantedCardEnums, offeredCardEnums }
});

// gameLog piece enum (VERIFIED): 0=road, 1=city, 2=settlement.
export const PIECE = Object.freeze({ ROAD: 0, CITY: 1, SETTLEMENT: 2 });

export class GameState {
  constructor() {
    this.reset();
  }
  reset() {
    this.ready = false;         // true once we've seen a snapshot
    this.us = null;             // our player color
    this.playOrder = [];        // array of colors in turn order
    this.gameState = null;      // the live gameState tree
    this.gameDetails = null;
    this.gameSettings = null;
    this.playerUserStates = null;
    this.serverId = null;       // game channel serverId (from the type-1 handshake)
    this.log = [];              // human-readable event log for the HUD
    this.rev = 0;               // bumps on every applied change
    this._subs = new Set();
    this._logSeen = 0;          // highest gameLogState index already normalized into events
  }

  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  _emit(evt) { this.rev++; for (const fn of this._subs) { try { fn(this, evt); } catch (e) { try { console.warn(e); } catch {} } } }

  /**
   * Apply a decoded incoming frame. `decoded` is the output of decodeFrame() for dir:"in":
   *   { id, type, payload, sequence, msg }
   */
  applyIncoming(decoded) {
    if (!decoded || decoded.id !== "130") return; // game stream only
    const { type, payload } = decoded;
    switch (type) {
      case 4: return this._applySnapshot(payload);
      case 91: return this._applyDiff(payload);
      case 1:
        this.gameSettingsMeta = payload;
        // The type-1 handshake carries the game-channel serverId used for direct-send.
        if (payload && payload.serverId) this.serverId = payload.serverId;
        return;
      default:
        // Record unknown game types so we can discover them from live play.
        this._note(`type${type}`, payload);
        return;
    }
  }

  _applySnapshot(payload) {
    this.us = payload.playerColor;
    this.playOrder = payload.playOrder || [];
    this.gameState = payload.gameState || {};
    this.gameDetails = payload.gameDetails || null;
    this.gameSettings = payload.gameSettings || null;
    this.playerUserStates = payload.playerUserStates || null;
    this.ready = true;
    // A fresh snapshot resets the gameLog cursor — the authoritative log replaces ours.
    this._logSeen = maxLogIndex(this.gameState);
    this._logEvent("snapshot", { us: this.us, order: this.playOrder });
    this._emit({ kind: "snapshot" });
  }

  _applyDiff(payload) {
    if (!this.gameState) return; // diff before snapshot — shouldn't happen
    const diff = payload && payload.diff;
    let events = [];
    if (diff && typeof diff === "object") {
      // Extract structured events from the diff BEFORE merging (we need the newly-appended
      // gameLog entries, and the pre-merge board for a couple of derivations).
      events = this._extractEvents(diff);
      deepMerge(this.gameState, diff);
      this._summarizeDiff(diff);
    }
    if (payload && payload.timeLeftInState != null) this.timeLeftInState = payload.timeLeftInState;
    this._emit({ kind: "diff", diff, events });
  }

  // ---- convenience accessors (used by HUD + renderer) ----
  get hexes() { return objVals(this.gameState?.mapState?.tileHexStates); }
  get corners() { return objVals(this.gameState?.mapState?.tileCornerStates); }
  get edges() { return objVals(this.gameState?.mapState?.tileEdgeStates); }
  get ports() { return objVals(this.gameState?.mapState?.portEdgeStates); }
  get robberTileIndex() { return this.gameState?.mechanicRobberState?.locationTileIndex; }
  get dice() {
    const d = this.gameState?.diceState;
    return d ? { thrown: d.diceThrown, d1: d.dice1, d2: d.dice2, sum: d.dice1 + d.dice2 } : null;
  }
  get currentTurnColor() { return this.gameState?.currentState?.currentTurnPlayerColor; }
  get turnState() { return this.gameState?.currentState?.turnState; }
  get actionState() { return this.gameState?.currentState?.actionState; }
  get completedTurns() { return this.gameState?.currentState?.completedTurns; }
  get bank() { return this.gameState?.bankState?.resourceCards; }
  get playerColors() {
    const ps = this.gameState?.playerStates;
    return ps ? Object.keys(ps).map(Number) : [];
  }
  playerState(color) { return this.gameState?.playerStates?.[color]; }

  // Settlements/cities/roads placed, as {color, cornerIndex|edgeIndex}.
  buildings() {
    const out = { settlements: [], cities: [], roads: [] };
    const corners = this.gameState?.mapState?.tileCornerStates || {};
    for (const [idx, c] of Object.entries(corners)) {
      if (c && c.owner != null && c.owner !== -1) {
        // buildingType enum (verified from live diffs): 1 = settlement, 2 = city.
        const kind = c.buildingType === 2 ? "cities" : "settlements";
        out[kind].push({ color: c.owner, cornerIndex: Number(idx), raw: c });
      }
    }
    const edges = this.gameState?.mapState?.tileEdgeStates || {};
    for (const [idx, e] of Object.entries(edges)) {
      if (e && e.owner != null && e.owner !== -1) {
        out.roads.push({ color: e.owner, edgeIndex: Number(idx), raw: e });
      }
    }
    return out;
  }

  // ---- normalized event extraction (for tracker + observation log) ----
  /**
   * Turn a raw type-91 diff into a list of structured gameplay events. Derived primarily from
   * the newly-appended `gameLogState` entries (the authoritative, ordered event feed), with a
   * couple of board-derived fallbacks. Each event is `{ type, ... }` where type is one of:
   *   "roll" {dice:[a,b], sum} · "build" {piece, color, index?} · "buy-dev" {color, isVp}
   *   "dev-played" {color, card} · "year-of-plenty" {color, cards:[a,b]}
   *   "distribution" {color, cards:[resId...]} · "robber" {color?, tile} · "steal" {thief, victim, count}
   *   "trade" {from, to, gave:[resId...], got:[resId...]} · "trade-offer" {wanted, offered}
   *   "turn-end" {color?} · "log" {logType, raw}   (fallback for unrecognized entries)
   * Pure: does not mutate state.
   */
  _extractEvents(diff) {
    const logDiff = diff?.gameLogState;
    if (!logDiff || typeof logDiff !== "object") return [];
    const out = [];
    // gameLogState is keyed by numeric index; only entries beyond _logSeen are new.
    const entries = Object.entries(logDiff)
      .map(([k, v]) => [Number(k), v])
      .filter(([k, v]) => Number.isFinite(k) && k > this._logSeen && v && typeof v === "object")
      .sort((a, b) => a[0] - b[0]);
    for (const [idx, entry] of entries) {
      const ev = normalizeLogEntry(entry);
      if (ev) out.push({ ...ev, _logIndex: idx });
      this._logSeen = Math.max(this._logSeen, idx);
    }
    return out;
  }

  // ---- logging ----
  _logEvent(kind, data) {
    this.log.push({ rev: this.rev, kind, data, t: nowSafe() });
    if (this.log.length > 500) this.log.shift();
  }
  _note(kind, payload) { this._logEvent(kind, summarize(payload)); }
  _summarizeDiff(diff) {
    // Try to describe the diff in gameplay terms for the HUD log.
    const parts = [];
    if (diff.diceState) parts.push(`dice=${diff.diceState.dice1}+${diff.diceState.dice2}`);
    if (diff.mechanicRobberState?.locationTileIndex != null)
      parts.push(`robber→tile${diff.mechanicRobberState.locationTileIndex}`);
    if (diff.currentState?.currentTurnPlayerColor != null)
      parts.push(`turn→${diff.currentState.currentTurnPlayerColor}`);
    if (diff.currentState?.turnState != null) parts.push(`turnState=${diff.currentState.turnState}`);
    if (diff.mapState?.tileCornerStates) parts.push(`corners±`);
    if (diff.mapState?.tileEdgeStates) parts.push(`edges±`);
    this._logEvent("diff", parts.length ? parts.join(" ") : Object.keys(diff));
  }
}

// Normalize one gameLogState entry into a structured event, or null if uninteresting.
// text.type values are VERIFIED in NOTES.md. Field names come from captured payloads; unknown
// shapes degrade to a generic {type:"log"} so nothing crashes on an unseen entry.
function normalizeLogEntry(entry) {
  const t = entry.text || {};
  const from = entry.from;
  switch (t.type) {
    case LOG.DICE:
      return { type: "roll", color: from, dice: [t.firstDice, t.secondDice], sum: (t.firstDice || 0) + (t.secondDice || 0) };
    case LOG.PLACE_PIECE: {
      const piece = t.pieceEnum === PIECE.ROAD ? "road" : t.pieceEnum === PIECE.CITY ? "city" : "settlement";
      return { type: "build", piece, color: t.playerColor ?? from };
    }
    case LOG.BOUGHT_DEV:
      return { type: "buy-dev", color: t.playerColor ?? from, isVp: !!t.isVp };
    case LOG.DEV_PLAYED:
      return { type: "dev-played", color: t.playerColor ?? from, card: t.cardEnum };
    case LOG.YOP_TAKE:
      return { type: "year-of-plenty", color: from, cards: (t.cardEnums || []).slice() };
    case LOG.DISTRIBUTION:
      return { type: "distribution", color: t.playerColor ?? from, cards: (t.cardsToBroadcast || []).slice(), distributionType: t.distributionType };
    case LOG.ROBBER_TILE:
      return { type: "robber", color: from, tile: t.tileInfo };
    case LOG.STEAL:
      return { type: "steal", thief: t.playerColorThief, victim: t.playerColorVictim, count: (t.cardBacks && t.cardBacks.length) || 1 };
    case LOG.TRADE_DONE:
      return { type: "trade", from: t.playerColor, to: t.acceptingPlayerColor, gave: (t.givenCardEnums || []).slice(), got: (t.receivedCardEnums || []).slice() };
    case LOG.TRADE_OFFER:
      return { type: "trade-offer", color: from, wanted: (t.wantedCardEnums || []).slice(), offered: (t.offeredCardEnums || []).slice() };
    case LOG.END_TURN:
      return { type: "turn-end", color: from };
    case LOG.TURN_MARKER:
      return { type: "turn-start", color: from };
    case LOG.ROBBER_BLOCKED:
      return { type: "robber-blocked", color: from, tile: t.tileInfo };
    default:
      return t.type != null ? { type: "log", logType: t.type, raw: t } : null;
  }
}

// Highest numeric key present in gameState.gameLogState (used to seed the event cursor on snapshot).
function maxLogIndex(gs) {
  const log = gs?.gameLogState;
  if (!log) return 0;
  let m = 0;
  for (const k of Object.keys(log)) { const n = Number(k); if (Number.isFinite(n) && n > m) m = n; }
  return m;
}

// --- deep merge: applies a Colonist diff into a target. null = delete key. ---
export function deepMerge(target, patch) {
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === null) { delete target[k]; continue; }
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array)) {
      if (!target[k] || typeof target[k] !== "object" || Array.isArray(target[k])) target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v; // primitives, arrays, Date, bytes -> replace
    }
  }
  return target;
}

function objVals(o) {
  if (!o) return [];
  return Object.entries(o).map(([idx, v]) => ({ index: Number(idx), ...v }));
}
function summarize(p) {
  if (p == null) return p;
  if (Array.isArray(p)) return `[array ${p.length}]`;
  if (typeof p === "object") return Object.keys(p);
  return p;
}
function nowSafe() { try { return Date.now(); } catch { return 0; } }
