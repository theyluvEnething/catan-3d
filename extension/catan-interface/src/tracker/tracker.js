/**
 * src/tracker/tracker.js — card-counting / hand-belief / dev-log layer.
 *
 * Colonist leaks a LOT publicly. This tracker models information honestly as
 *   known  — cards we can deterministically attribute to a player,
 *   unknownCount — cards in a player's hand whose exact resource is hidden from us,
 *   estimate — a per-resource expectation (fractional) blending known + a spread of the unknowns.
 *
 * The AUTHORITATIVE total for each player is always the state's `resourceCards.cards.length`
 * (Colonist publishes every player's hand SIZE — opponents' entries are 0 = card backs, ours are
 * real resource ids). We reconcile our per-event bookkeeping to that authoritative count every
 * update, so the tracker can never drift far from truth.
 *
 * Primary signal = the decoded state diffs + the ordered `gameLogState`. We read the log entry
 * `text.type` vocabulary (VERIFIED, see NOTES.md):
 *   47 = resource distribution on roll {playerColor, cardsToBroadcast:[resIds]}
 *   16 = steal {playerColorThief, playerColorVictim, cardBacks}
 *   20 = dev played {playerColor, cardEnum}
 *   21 = year-of-plenty take {cardEnums:[a,b]}
 *   115 = trade completed {playerColor, acceptingPlayerColor, givenCardEnums, receivedCardEnums}
 *    5 = bought dev {playerColor}
 *
 * No DOM, no external imports beyond sibling enums. Correct-when-derivable, otherwise
 * unknownCount + estimate.
 */
import {
  RESOURCE, RESOURCE_NAME, RESOURCE_NAMES, DEVCARD_NAME, DEVCARD_DECK_SIZE, countBy,
} from "../domain/enums.js";

const EMPTY_RES = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const resName = (id) => RESOURCE_NAME[id];
const isRealRes = (id) => id >= 1 && id <= 5;

export class Tracker {
  /**
   * @param {GameState} state
   * @param {object} [opts] { now }
   */
  constructor(state, opts = {}) {
    this.state = state;
    this._now = typeof opts.now === "function" ? opts.now : () => { try { return Date.now(); } catch { return 0; } };
    this._logCursor = 0;              // index of the next gameLog entry to process
    this._seenUsed = {};             // color -> last-seen developmentCardsUsed length
    this._beliefs = new Map();       // color -> { known:{res:count}, unknownCount }
    this.devLog = [];                // [{ color, dev, devName, t }] chronological dev plays
    this.eventLog = [];              // [{ t, kind, ...normalized }] normalized tracker events
    this._unsub = state.subscribe(() => this.update());
    this.update();
  }

  dispose() { if (this._unsub) this._unsub(); }

  // ---- belief accessors -----------------------------------------------------------------------

  /** Ensure a belief record exists for a color. */
  _belief(color) {
    let b = this._beliefs.get(color);
    if (!b) { b = { known: EMPTY_RES(), unknownCount: 0 }; this._beliefs.set(color, b); }
    return b;
  }

  /**
   * The hand belief for a player: { total, known:{...}, unknownCount, estimate:{...} }.
   * If it's US (or a fully-revealed hand), `known` is exact and unknownCount 0.
   */
  hand(color) {
    color = Number(color);
    const isUs = color === this.state.us;
    const total = this._authoritativeCount(color);
    if (isUs) {
      const known = this._ourHand();
      return { total, known, unknownCount: 0, estimate: { ...known } };
    }
    const b = this._belief(color);
    // Reconcile known+unknown to the authoritative total (belief may lag by an event).
    const knownSum = sum(b.known);
    let unknownCount = Math.max(0, total - knownSum);
    // If our known somehow exceeds the truth (over-attribution), clamp toward the total.
    const known = { ...b.known };
    if (knownSum > total) { scaleDownTo(known, total); unknownCount = 0; }
    return { total, known, unknownCount, estimate: this._estimate(color, known, unknownCount) };
  }

  /** Blend known counts with a spread of the unknowns across plausible resources. */
  _estimate(color, known, unknownCount) {
    const est = { ...known };
    if (unknownCount > 0) {
      // Spread unknowns proportionally to what remains in the "unseen" pool (bank + other hidden
      // hands). Simple + honest: weight by bank composition (public) as the maximum-entropy prior.
      const weights = this._unseenWeights();
      const wsum = RESOURCE_NAMES.reduce((a, n) => a + weights[n], 0) || 1;
      for (const n of RESOURCE_NAMES) est[n] = round3(est[n] + unknownCount * (weights[n] / wsum));
    }
    return est;
  }

  /** Weight prior for unknown cards = current bank counts (public), a max-entropy proxy. */
  _unseenWeights() {
    const bank = this.state.bank || {};
    return {
      wood: bank[RESOURCE.WOOD] || 0, brick: bank[RESOURCE.BRICK] || 0, sheep: bank[RESOURCE.SHEEP] || 0,
      wheat: bank[RESOURCE.WHEAT] || 0, ore: bank[RESOURCE.ORE] || 0,
    };
  }

  /** Our exact resource counts from state (our resourceCards.cards are real ids). */
  _ourHand() {
    const ps = this.state.playerState(this.state.us);
    const c = EMPTY_RES();
    for (const id of ps?.resourceCards?.cards || []) { const n = resName(id); if (n && n !== "hidden") c[n]++; }
    return c;
  }

  /** Authoritative hand size for a color = length of its resourceCards.cards array. */
  _authoritativeCount(color) {
    const ps = this.state.playerState(color);
    const cards = ps?.resourceCards?.cards;
    return Array.isArray(cards) ? cards.length : 0;
  }

  // ---- dev card accounting --------------------------------------------------------------------

  /** Development-card totals: deck remaining + per-type played counts + per-player held count. */
  get devDeckRemaining() {
    const bank = this.state.gameState?.mechanicDevelopmentCardsState?.bankDevelopmentCards?.cards;
    if (Array.isArray(bank)) return bank.length;
    // fall back to 25 - total bought (inferred from used + held) if bank not present
    return Math.max(0, DEVCARD_DECK_SIZE - this._totalDevBought());
  }

  _totalDevBought() {
    const players = this.state.gameState?.mechanicDevelopmentCardsState?.players || {};
    let n = 0;
    for (const p of Object.values(players)) n += (p.developmentCards?.cards?.length || 0) + (p.developmentCardsUsed?.length || 0);
    return n;
  }

  /** Per-type totals of dev cards PLAYED across all players (public). */
  get devTotals() {
    const players = this.state.gameState?.mechanicDevelopmentCardsState?.players || {};
    const totals = {};
    for (const p of Object.values(players)) {
      for (const id of p.developmentCardsUsed || []) { const n = DEVCARD_NAME[id] || `dev${id}`; totals[n] = (totals[n] || 0) + 1; }
    }
    return totals;
  }

  /** Knights played by a color (drives largest-army). */
  knightsPlayed(color) {
    const p = this.state.gameState?.mechanicDevelopmentCardsState?.players?.[color];
    return (p?.developmentCardsUsed || []).filter((id) => DEVCARD_NAME[id] === "knight").length;
  }

  // ---- update loop ----------------------------------------------------------------------------

  update() {
    if (!this.state.ready || !this.state.gameState) return;
    this._ingestDevPlays();
    this._ingestLog();
    this._emitSummaryHook();
  }

  /** Append newly-used dev cards to devLog (append-only; diff carries the full array). */
  _ingestDevPlays() {
    const players = this.state.gameState?.mechanicDevelopmentCardsState?.players || {};
    for (const [color, p] of Object.entries(players)) {
      const used = p.developmentCardsUsed;
      if (!Array.isArray(used)) continue;
      const prev = this._seenUsed[color] || 0;
      for (let i = prev; i < used.length; i++) {
        const dev = used[i];
        this.devLog.push({ color: Number(color), dev, devName: DEVCARD_NAME[dev] || `dev${dev}`, t: this._now() });
      }
      this._seenUsed[color] = used.length;
    }
  }

  /**
   * Process new gameLog entries in order, updating per-opponent hand beliefs.
   * Only entries at/after _logCursor are processed, so this is incremental + idempotent.
   */
  _ingestLog() {
    const gl = this.state.gameState?.gameLogState;
    if (!gl) return;
    // gameLog is keyed by integer index; process in numeric order from the cursor.
    const indices = Object.keys(gl).map(Number).filter((n) => n >= this._logCursor).sort((a, b) => a - b);
    for (const idx of indices) {
      const entry = gl[idx];
      if (entry && entry.text) this._applyLogEntry(entry.text);
      this._logCursor = Math.max(this._logCursor, idx + 1);
    }
  }

  _applyLogEntry(text) {
    const t = text.type;
    switch (t) {
      case 47: { // resource distribution on roll: {playerColor, cardsToBroadcast:[resIds]}
        const color = Number(text.playerColor);
        for (const id of text.cardsToBroadcast || []) if (isRealRes(id)) this._add(color, id, 1);
        this._event("gain", { color, resources: idsToNames(text.cardsToBroadcast) });
        break;
      }
      case 21: { // year-of-plenty take: {playerColor?, cardEnums:[a,b]} — the current dev-player took 2
        const color = text.playerColor != null ? Number(text.playerColor) : this.state.currentTurnColor;
        for (const id of text.cardEnums || []) if (isRealRes(id)) this._add(color, id, 1);
        this._event("year-of-plenty", { color, resources: idsToNames(text.cardEnums) });
        break;
      }
      case 16: { // steal: {playerColorThief, playerColorVictim, cardBacks:[...]}
        const thief = Number(text.playerColorThief);
        const victim = Number(text.playerColorVictim);
        const revealed = (text.cardBacks || []).filter(isRealRes); // exact only if we are giver/receiver
        const n = (text.cardBacks || []).length || 1;
        this._steal(thief, victim, n, revealed);
        this._event("steal", { thief, victim, count: n, revealed: idsToNames(revealed) });
        break;
      }
      case 20: { // dev played: {playerColor, cardEnum}
        const color = Number(text.playerColor);
        this._event("dev-played", { color, dev: DEVCARD_NAME[text.cardEnum] || `dev${text.cardEnum}` });
        break;
      }
      case 115: { // trade completed: {playerColor, acceptingPlayerColor, givenCardEnums, receivedCardEnums}
        const a = Number(text.playerColor), b = Number(text.acceptingPlayerColor);
        const given = (text.givenCardEnums || []).filter(isRealRes);   // a gave these to b
        const received = (text.receivedCardEnums || []).filter(isRealRes); // a received these from b
        for (const id of given) { this._add(a, id, -1); this._add(b, id, +1); }
        for (const id of received) { this._add(a, id, +1); this._add(b, id, -1); }
        this._event("trade", { from: a, to: b, gave: idsToNames(given), got: idsToNames(received) });
        break;
      }
      case 5: { // bought a dev card: {playerColor} — costs sheep+wheat+ore (public cost)
        const color = Number(text.playerColor);
        this._add(color, RESOURCE.SHEEP, -1); this._add(color, RESOURCE.WHEAT, -1); this._add(color, RESOURCE.ORE, -1);
        this._event("buy-dev", { color });
        break;
      }
      case 4: { // placed a piece: {playerColor, pieceEnum} 2=settlement,0=road,1=city — subtract cost
        const color = Number(text.playerColor);
        if (text.pieceEnum === 2) this._spend(color, { [RESOURCE.WOOD]: 1, [RESOURCE.BRICK]: 1, [RESOURCE.SHEEP]: 1, [RESOURCE.WHEAT]: 1 });
        else if (text.pieceEnum === 0) this._spend(color, { [RESOURCE.WOOD]: 1, [RESOURCE.BRICK]: 1 });
        else if (text.pieceEnum === 1) this._spend(color, { [RESOURCE.WHEAT]: 2, [RESOURCE.ORE]: 3 });
        break;
      }
      // Monopoly / discard-on-7 details, when present in the log, would be handled here. We keep
      // it simple: the authoritative count reconciliation in hand() absorbs anything we miss.
      default: break;
    }
  }

  // ---- belief mutations (only affect OPPONENT known maps; ours is read from state) -------------

  _add(color, resId, delta) {
    color = Number(color);
    if (color === this.state.us) return; // our hand is authoritative from state; don't track deltas
    const n = resName(resId); if (!n || n === "hidden") return;
    const b = this._belief(color);
    b.known[n] = Math.max(0, (b.known[n] || 0) + delta);
  }

  _spend(color, cost) {
    for (const [resId, amt] of Object.entries(cost)) this._add(color, Number(resId), -amt);
  }

  /**
   * A steal moves `n` cards from victim to thief. If `revealed` gives exact ids (we are a party),
   * apply exactly; otherwise the thief gains n unknowns and the victim loses n (from unknown pool
   * first, then proportionally from known — a card left the victim's hand).
   */
  _steal(thief, victim, n, revealed) {
    if (revealed && revealed.length) {
      for (const id of revealed) { this._add(victim, id, -1); this._add(thief, id, +1); }
      return;
    }
    // Unknown card: reduce victim's belief (from known, weighted) and mark thief +unknown.
    const vb = victim === this.state.us ? null : this._belief(victim);
    if (vb) {
      // Remove from the victim's most-likely known resource(s); if victim has only unknowns, the
      // authoritative reconciliation in hand() handles the count drop.
      for (let k = 0; k < n; k++) removeOneWeighted(vb.known);
    }
    // Thief gains an unknown — represented implicitly (their authoritative count rises; known
    // stays, so hand() attributes the extra to unknownCount). Nothing to add to `known`.
  }

  // ---- events ---------------------------------------------------------------------------------

  _event(kind, data) {
    const e = { t: this._now(), kind, ...data };
    this.eventLog.push(e);
    if (this.eventLog.length > 500) this.eventLog.shift();
  }
  _emitSummaryHook() { /* consumers read summary() on demand; no push here */ }

  // ---- public summary -------------------------------------------------------------------------

  /** A compact snapshot of everything the tracker knows. */
  summary() {
    const colors = this.state.playerColors;
    const players = colors.map((color) => {
      const h = this.hand(color);
      return {
        color,
        isUs: color === this.state.us,
        total: h.total,
        known: h.known,
        unknownCount: h.unknownCount,
        estimate: h.estimate,
        devHeld: (this.state.gameState?.mechanicDevelopmentCardsState?.players?.[color]?.developmentCards?.cards || []).length,
        knightsPlayed: this.knightsPlayed(color),
      };
    });
    return {
      players,
      devDeckRemaining: this.devDeckRemaining,
      devTotals: this.devTotals,
      devLog: this.devLog.slice(-40),
      bank: this.state.bank || null,
    };
  }
}

// ---- helpers ----------------------------------------------------------------------------------
function sum(o) { return Object.values(o).reduce((a, x) => a + (x || 0), 0); }
function round3(x) { return Math.round(x * 1000) / 1000; }
function idsToNames(ids) { return (ids || []).map((id) => RESOURCE_NAME[id]).filter((n) => n && n !== "hidden"); }
function scaleDownTo(counts, target) {
  let s = sum(counts);
  while (s > target) { removeOneWeighted(counts); s--; }
}
function removeOneWeighted(counts) {
  // remove one card from the largest bucket (deterministic, simple)
  let best = null, bestV = 0;
  for (const n of RESOURCE_NAMES) { if ((counts[n] || 0) > bestV) { bestV = counts[n]; best = n; } }
  if (best && counts[best] > 0) counts[best]--;
}
