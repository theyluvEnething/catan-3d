/**
 * test/tracker.test.js — card-counting / hand-belief / dev-log unit tests.
 * Drives GameState with hand-authored snapshots + diffs so every assertion is deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GameState } from "../src/state/gameState.js";
import { Tracker } from "../src/tracker/tracker.js";

// Build a fresh game where WE are color 1, opponents 2 and 3, all empty hands, full bank.
function freshGame() {
  const gs = new GameState({ now: () => 0 });
  gs.applyIncoming({
    id: "130", type: 4,
    payload: {
      playerColor: 1, playOrder: [1, 2, 3],
      gameState: {
        bankState: { resourceCards: { 1: 19, 2: 19, 3: 19, 4: 19, 5: 19 } },
        mechanicDevelopmentCardsState: {
          bankDevelopmentCards: { cards: Array(25).fill(10) },
          players: { 1: { developmentCards: { cards: [] }, developmentCardsUsed: [] }, 2: { developmentCards: { cards: [] }, developmentCardsUsed: [] }, 3: { developmentCards: { cards: [] }, developmentCardsUsed: [] } },
        },
        currentState: { currentTurnPlayerColor: 1, actionState: 1, completedTurns: 20, turnState: 2 },
        playerStates: {
          1: { resourceCards: { cards: [] } },
          2: { resourceCards: { cards: [] } },
          3: { resourceCards: { cards: [] } },
        },
        gameLogState: {},
      },
    },
  });
  return gs;
}

// Apply a diff that (a) sets a new gameLog entry at `idx` and (b) updates the authoritative
// resourceCards for the affected players so hand() can reconcile.
function diff(gs, patch) { gs.applyIncoming({ id: "130", type: 91, payload: { diff: patch } }); }

test("our own hand is read exactly from state (unknownCount 0)", () => {
  const gs = freshGame();
  const tr = new Tracker(gs, { now: () => 0 });
  diff(gs, { playerStates: { 1: { resourceCards: { cards: [1, 1, 2, 4] } } } }); // 2 wood, 1 brick, 1 wheat
  const h = tr.hand(1);
  assert.equal(h.total, 4);
  assert.equal(h.unknownCount, 0);
  assert.deepEqual(h.known, { wood: 2, brick: 1, sheep: 0, wheat: 1, ore: 0 });
});

test("opponent gain from a roll (log type 47) is attributed to known, reconciled to count", () => {
  const gs = freshGame();
  const tr = new Tracker(gs, { now: () => 0 });
  diff(gs, {
    playerStates: { 2: { resourceCards: { cards: [0, 0] } } },     // opponent now has 2 cards (hidden)
    gameLogState: { 0: { text: { type: 47, playerColor: 2, cardsToBroadcast: [1, 4] } } }, // wood + wheat
  });
  const h = tr.hand(2);
  assert.equal(h.total, 2);
  assert.equal(h.unknownCount, 0, "both cards are known from the roll broadcast");
  assert.equal(h.known.wood, 1);
  assert.equal(h.known.wheat, 1);
});

test("a hidden steal (log type 16) raises the thief's total as unknown", () => {
  const gs = freshGame();
  const tr = new Tracker(gs, { now: () => 0 });
  // opponent 2 rolls into a known wood; then WE(1) are unaffected. Opponent 3 steals 1 unknown from 2.
  diff(gs, {
    playerStates: { 2: { resourceCards: { cards: [0] } } },
    gameLogState: { 0: { text: { type: 47, playerColor: 2, cardsToBroadcast: [1] } } },
  });
  diff(gs, {
    playerStates: { 2: { resourceCards: { cards: [] } }, 3: { resourceCards: { cards: [0] } } },
    gameLogState: { 1: { text: { type: 16, playerColorThief: 3, playerColorVictim: 2, cardBacks: [0] } } },
  });
  const thief = tr.hand(3);
  assert.equal(thief.total, 1);
  assert.equal(thief.unknownCount, 1, "stolen card is unknown to us");
  const victim = tr.hand(2);
  assert.equal(victim.total, 0);
});

test("dev buy + play updates devDeckRemaining, devTotals, and devLog", () => {
  const gs = freshGame();
  const tr = new Tracker(gs, { now: () => 0 });
  // opponent 2 buys a dev (deck 25→24, held +1) then plays a knight (held→0, used +knight)
  diff(gs, {
    mechanicDevelopmentCardsState: {
      bankDevelopmentCards: { cards: Array(24).fill(10) },
      players: { 2: { developmentCards: { cards: [11] } } },
    },
  });
  assert.equal(tr.devDeckRemaining, 24);
  diff(gs, {
    mechanicDevelopmentCardsState: {
      players: { 2: { developmentCards: { cards: [] }, developmentCardsUsed: [11] } },
    },
    gameLogState: { 0: { text: { type: 20, playerColor: 2, cardEnum: 11 } } },
  });
  assert.equal(tr.devTotals.knight, 1);
  assert.equal(tr.knightsPlayed(2), 1);
  assert.deepEqual(tr.devLog.map((e) => `${e.color}:${e.devName}`), ["2:knight"]);
});

test("summary() reconciles known+unknown to total for every player", () => {
  const gs = freshGame();
  const tr = new Tracker(gs, { now: () => 0 });
  diff(gs, {
    playerStates: {
      1: { resourceCards: { cards: [1, 2, 3] } },
      2: { resourceCards: { cards: [0, 0, 0, 0] } },
      3: { resourceCards: { cards: [0] } },
    },
    gameLogState: { 0: { text: { type: 47, playerColor: 2, cardsToBroadcast: [1, 1] } } }, // 2 known of 4
  });
  for (const p of tr.summary().players) {
    const k = Object.values(p.known).reduce((a, x) => a + x, 0);
    assert.equal(k + p.unknownCount, p.total, `reconcile failed for P${p.color}`);
  }
});
