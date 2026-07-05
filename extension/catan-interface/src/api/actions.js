/**
 * src/api/actions.js — the ACTION tool surface (what a human UI or an LLM agent calls).
 *
 * Each action is `async (args) => { ok, error?, action?, payload? }`. It validates against the
 * legal-move engine FIRST, then encodes the (verified) game frame and hands it to the engine's
 * transmit function. The engine owns the channel + sequence.
 *
 * VERIFIED action ids come from domain/enums.js (settlement 15, road 11, city 19, robber 3,
 * discard 2, end-turn 6, respond-trade 50). The not-yet-reverse-engineered actions
 * (buy_dev_card, play_dev, bank_trade, create_trade) are PRESENT but return
 *   { ok:false, error:"unimplemented: action id not yet reverse-engineered (see NOTES.md)" }
 * so the interface is complete/forward-compatible without ever emitting a guessed action.
 */
import { ACTION } from "../domain/enums.js";

const UNIMPL = (name) => ({ ok: false, error: `unimplemented: ${name} action id not yet reverse-engineered (see NOTES.md)` });

/**
 * @param {object} deps
 * @param {GameState} deps.state
 * @param {object} deps.legal   { settlements(), cities(), roads(), robberHexes() }
 * @param {InteractionController} deps.controller
 * @param {(action:number, payload:any)=>({ok:boolean,...})} deps.sendAction  encode+transmit one game action
 */
export function createActions({ state, legal, controller, sendAction }) {
  const hasIndex = (targets, index) => targets.some((t) => t.i === Number(index));
  const notYourTurn = () => state.currentTurnColor !== state.us;

  const send = (action, payload) => {
    const res = sendAction(action, payload);
    // sendAction returns {ok,...}; normalize to include action/payload for callers.
    return { ok: !!(res && res.ok), error: res && res.error, action, payload, ...(res || {}) };
  };

  return {
    // ---- VERIFIED actions -----------------------------------------------------------------

    async build_settlement(node) {
      if (notYourTurn()) return { ok: false, error: "not your turn" };
      if (!hasIndex(legal.settlements(), node)) return { ok: false, error: `illegal settlement at node ${node}` };
      return send(ACTION.BUILD_SETTLEMENT, Number(node));
    },

    async build_city(node) {
      if (notYourTurn()) return { ok: false, error: "not your turn" };
      if (!hasIndex(legal.cities(), node)) return { ok: false, error: `illegal city at node ${node}` };
      return send(ACTION.BUILD_CITY, Number(node));
    },

    async build_road(edge) {
      if (notYourTurn()) return { ok: false, error: "not your turn" };
      if (!hasIndex(legal.roads(), edge)) return { ok: false, error: `illegal road at edge ${edge}` };
      return send(ACTION.BUILD_ROAD, Number(edge));
    },

    async roll() {
      if (notYourTurn()) return { ok: false, error: "not your turn" };
      // The THROW_DICE game-action id is NOT in the verified set — in Colonist, rolling is a
      // client-side shortcut (Spacebar). The engine cannot emit a verified roll frame, so this
      // returns unimplemented; a browser adapter should simulate the Spacebar keypress instead.
      return { ...UNIMPL("roll"), hint: "roll via the Colonist client shortcut (Spacebar); no verified game-action id" };
    },

    async end_turn() {
      if (notYourTurn()) return { ok: false, error: "not your turn" };
      return send(ACTION.END_TURN, true);
    },

    async move_robber(hex, victim) {
      if (notYourTurn()) return { ok: false, error: "not your turn" };
      if (!hasIndex(legal.robberHexes(), hex)) return { ok: false, error: `illegal robber hex ${hex}` };
      const res = send(ACTION.MOVE_ROBBER, Number(hex));
      // victim selection is a separate follow-up frame in Colonist's flow; left to the caller/UI
      // when the steal prompt appears. We surface the requested victim in the result for context.
      if (victim != null) res.requestedVictim = Number(victim);
      return res;
    },

    async discard(cards) {
      if (notYourTurn() && state.actionState !== 24) { /* discard can happen off-turn on a 7 */ }
      // cards = { wood, brick, sheep, wheat, ore } counts, OR an array of resource ids.
      const ids = normalizeDiscard(cards);
      if (!ids.length) return { ok: false, error: "discard: no cards specified" };
      // Colonist expects one discard frame per card (payload true per the verified capture).
      let last = { ok: true };
      for (let i = 0; i < ids.length; i++) last = send(ACTION.DISCARD, true);
      return { ...last, action: ACTION.DISCARD, count: ids.length };
    },

    async respond_trade(id, accept) {
      // response codes: accept vs decline. Verified frame shape: { id, response }.
      return send(ACTION.RESPOND_TRADE, { id, response: accept ? 1 : 0 });
    },

    // ---- NOT-YET-REVERSE-ENGINEERED actions (present for completeness; never emit a guess) ----

    async buy_dev_card() { return UNIMPL("buy_dev_card"); },
    async play_dev(/* card, args */) { return UNIMPL("play_dev"); },
    async bank_trade(/* give, get */) { return UNIMPL("bank_trade"); },
    async create_trade(/* offer, want, targets */) { return UNIMPL("create_trade"); },
  };
}

function normalizeDiscard(cards) {
  if (Array.isArray(cards)) return cards.filter((x) => x >= 1 && x <= 5);
  const map = { wood: 1, brick: 2, sheep: 3, wheat: 4, ore: 5 };
  const out = [];
  for (const [name, n] of Object.entries(cards || {})) { const id = map[name]; if (id) for (let i = 0; i < n; i++) out.push(id); }
  return out;
}
