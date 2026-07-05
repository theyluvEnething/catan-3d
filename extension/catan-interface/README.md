# catan-interface

A **standalone, framework-agnostic** JavaScript engine for the [Colonist.io](https://colonist.io)
game interface. It reverse-engineers the wire protocol, reconstructs the full game state from
intercepted traffic, models the board and rules, counts cards, and exposes a clean, normalized
**Observation / Action** API designed for either a human UI or an LLM agent.

- **Zero dependencies. No build step. No bundler.** Pure ES modules.
- **No DOM, no `three`, no `chrome.*`.** Runs identically in a browser and in Node (>=18).
- **Transport-agnostic.** You feed it inbound bytes and give it an outbound `send(bytes)`
  callback; it owns the game channel and sequence counter internally.

> This folder is fully self-contained and can be lifted into its own repository with **zero
> edits** — it carries its own `package.json`, tests, examples, and a bundled capture fixture,
> and imports nothing from outside itself.

---

## Install / use

There is no package to install — it's plain ESM. Copy the folder, or (once published) `npm i`,
then:

```js
import { createEngine, RESOURCE, DEVCARD, ACTION } from "catan-interface";

const engine = createEngine({
  send: (bytes) => transport.transmit(bytes),   // engine encodes; your adapter transmits raw bytes
  now:  () => Date.now(),                        // injectable clock (Node tests pass a fake)
});

transport.onMessage = (bytes) => engine.ingest(bytes); // inbound raw frame (Uint8Array | string)

engine.on("change", (state) => { /* any state update */ });
engine.on("event",  (evt)   => { /* normalized log event */ });
engine.on("desync", (drift) => { /* watchdog drift vs authoritative snapshot */ });
```

`ingest()` accepts a `Uint8Array`/`ArrayBuffer` (binary frame), a `string` (text handshake frame),
or a pre-shaped `{ dir, kind, bytes|b64|text }` object (as a capture harness relays).

### Learning the game channel

Outgoing game frames are `[0x03][0x01][strlen][channel][msgpack {action,payload,sequence}]`. The
engine needs the **channel** (Colonist's per-game `serverId`) and the latest **sequence** before it
can send. It learns them two ways:

1. From the type-1 handshake payload (`engine.ingest` picks up `serverId` automatically), or
2. From Colonist's own outbound frames — decode them and inform the engine:
   ```js
   import { decodeOutgoing } from "catan-interface";
   const d = decodeOutgoing(colonistOutboundBytes);
   engine.setChannel(d.channel);
   engine.setSequence(d.body.sequence);
   ```

---

## The engine object

```js
engine.on(name, fn) / once / off       // events: "change" | "event" | "desync" | "action"
engine.ingest(bytesOrString)           // feed one inbound frame
engine.setChannel(serverId)            // inform the engine of the game channel
engine.setSequence(n)                  // inform the engine of the latest outgoing sequence
engine.sendAction(actionId, payload)   // low-level: encode+transmit one verified game action

engine.getState()                      // the raw reconstructed GameState (see below)
engine.getObservation()                // normalized, LLM-friendly JSON snapshot (schema below)
engine.ready                           // true once a snapshot has been applied
engine.wire                            // { channel, sequence }

engine.legal        // { settlements(), cities(), roads(), robberHexes(), stealTargets(hex), all() }
engine.tracker      // card-counting / hand-belief / dev-log (below)
engine.controller   // turn/phase → interaction context (CONTEXTS.*)
engine.actions      // the tool surface (below)
engine.watchdog     // { report(), onDesync(cb), detach() }

engine.reset()      // clear state
engine.dispose()    // detach everything
```

`getState()` returns the reconstructed `GameState`: `.ready`, `.us` (your colour id), `.playOrder`,
`.gameState` (the live Colonist tree), plus convenience getters `.hexes/.corners/.edges/.ports`,
`.robberTileIndex`, `.dice`, `.currentTurnColor`, `.turnState`, `.actionState`, `.completedTurns`,
`.bank`, `.playerColors`, `.playerState(color)`, and `.buildings()`.

---

## Observation (`getObservation()`)

A stable, documented, engine-internals-free JSON snapshot. Board node/edge ids are Colonist's
`mapState` indices, so an action can reference them directly.

```jsonc
{
  "phase": "main",              // connecting|setup|main|roll|discard|move-robber|idle
  "turn": "P3", "you": "P11", "canAct": false,
  "board": {
    "hexes": [{ "id": 9, "resource": "wheat", "number": 6, "robber": false }],
    "nodes": [{ "id": 22, "owner": "P1", "building": "settlement",
                "port": "3:1", "hexes": [9, 10, 14] }],   // building: settlement|city|null
    "edges": [{ "id": 14, "owner": null, "nodes": [22, 23] }]
  },
  "players": [{
    "id": "P2", "color": 2, "colorName": "blue", "name": "...", "isBot": true, "isYou": false,
    "vpPublic": 4, "resourceCount": 7, "devCount": 2, "knightsPlayed": 1,
    "settlementsLeft": 3, "citiesLeft": 3, "roadsLeft": 11,
    "longestRoadLen": 4, "longestRoad": false, "largestArmy": false
  }],
  "hand":    { "wood": 2, "brick": 1, "sheep": 0, "wheat": 3, "ore": 1 },
  "devHand": ["knight", "victory-point"],
  "legalActions": ["build_road:14", "build_settlement:22", "end_turn"],
  "bank": { "wood": 15, "brick": 18, "sheep": 12, "wheat": 14, "ore": 18 },
  "log": [ "P3 stole 1 from P1", "you got sheep" ]
}
```

`OBSERVATION_SCHEMA` (exported) is the Draft-07 JSON Schema for this shape.

---

## Actions (`engine.actions`) — the tool surface

Each action is `async (args) => { ok, error?, action?, payload?, sequence? }`. It **validates
against `engine.legal` first**, then encodes the verified game frame and transmits it via your
`send` callback. The engine owns channel + sequence.

| Action | Args | Status |
|---|---|---|
| `build_settlement(node)` | node id | ✅ verified (action 15) |
| `build_city(node)` | node id | ✅ verified (action 19) |
| `build_road(edge)` | edge id | ✅ verified (action 11) |
| `move_robber(hex, victim?)` | hex id, optional victim | ✅ verified (action 3) |
| `discard(cards)` | `{wood,brick,...}` or `[resIds]` | ✅ verified (action 2, one frame/card) |
| `end_turn()` | — | ✅ verified (action 6) |
| `respond_trade(id, accept)` | trade id, boolean | ✅ verified (action 50) |
| `roll()` | — | ⛔ unimplemented — Colonist rolls via a client shortcut (Spacebar); no verified game-action id |
| `buy_dev_card()` | — | ⛔ unimplemented — action id not reverse-engineered |
| `play_dev(card, args)` | card name + args | ⛔ unimplemented — action id not reverse-engineered |
| `bank_trade(give, get)` | resource maps | ⛔ unimplemented — action id not reverse-engineered |
| `create_trade(offer, want, targets)` | resource maps + player ids | ⛔ unimplemented — action id not reverse-engineered |

Unimplemented actions are **present** (so the interface is complete/forward-compatible) and return
`{ ok: false, error: "unimplemented: <name> action id not yet reverse-engineered (see NOTES.md)" }`
rather than emitting a guessed action.

**Machine-readable tool definitions** for an LLM agent are exported for free:

```js
import { TOOL_DEFINITIONS, ACTION_SCHEMAS } from "catan-interface";
// TOOL_DEFINITIONS: OpenAI/Anthropic-style [{ type:"function", function:{ name, description, parameters } }]
// ACTION_SCHEMAS[name]: the JSON Schema for that action's args
```

---

## Tracker (`engine.tracker`) — card counting

Models opponent information **honestly** as known / inferred / hidden. The authoritative hand
**size** comes from the state (Colonist publishes every player's hand size); the tracker splits
that into what it can attribute vs. what remains hidden, and reconciles to the true count on every
update so it can't drift.

```js
engine.tracker.hand(playerId)   // { total, known:{wood,brick,sheep,wheat,ore}, unknownCount, estimate:{...} }
engine.tracker.devLog           // [{ color, dev, devName, t }] chronological dev-card plays
engine.tracker.devTotals        // { knight: 2, monopoly: 1, ... } dev cards played (public)
engine.tracker.devDeckRemaining // 25 - bought
engine.tracker.knightsPlayed(playerId)
engine.tracker.eventLog         // normalized [{ t, kind, ... }] (gain/steal/trade/dev-played/...)
engine.tracker.summary()        // compact snapshot of everything above
```

**How beliefs update** (from the verified in-game log vocabulary):

- **Known** — every player's resource-card *count* (public), dev cards bought (count), dev cards
  played (revealed on play), bank counts, and dice-roll production by board position.
- **Inferred** — per-opponent belief: roll → add produced resources to owners; build/buy →
  subtract the (public) cost; trade → public swap; robber steal → 1 unknown card moves (exact if
  you are the giver/receiver); year-of-plenty → +2 known.
- **Hidden** — anything not derivable stays `unknownCount`, with a per-resource `estimate`
  (weighted by the public bank composition as a maximum-entropy prior).

The tracker prefers the decoded state diffs as the primary source and additionally parses
Colonist's in-game message log for extra steal/trade signal, but **never depends on** the text log.

---

## Enums (exported)

`RESOURCE` (`WOOD=1 BRICK=2 SHEEP=3 WHEAT=4 ORE=5`, `HIDDEN=0`), `RESOURCE_NAME`, `RESOURCE_ID`;
`DEVCARD` (`KNIGHT=11 MONOPOLY=12 ROAD_BUILDING=13 VICTORY_POINT=14 YEAR_OF_PLENTY=15`, `HIDDEN=10`),
`DEVCARD_NAME`, `DEVCARD_ID`; `BUILDING` (`SETTLEMENT=1 CITY=2`); `PLAYER_HEX`, `PLAYER_COLOR_NAME`;
`COST` (per-piece resource costs); and `ACTION` (the verified outgoing action ids).

Board geometry helpers are also exported for a renderer that wants to place pieces without a copy:
`hexCenter, hexCorners, cornerHexes, cornerEdges, edgeCorners, cornerPos, cornerPosExact, edgePos, SQRT3`.

---

## Wire protocol (verified)

- Socket: `wss://socket.svr.colonist.io/?version=2` — one socket for lobby + game. Encoding is
  **MessagePack** (hand-rolled here; byte-for-byte validated against `@msgpack/msgpack`).
- Incoming binary: bare msgpack `{ id, data: { type, payload } }`; `id: "130"` is the game stream.
  Type **4** = full snapshot (replace), type **91** = incremental diff (deep-merge, `null` = delete).
- Outgoing game frame: `[0x03][0x01][strlen][channel][msgpack { action, payload, sequence }]`.
- Verified action ids: settlement **15**, road **11**, city **19**, robber **3**, discard **2**,
  end-turn/pass **6**, trade-response **50** (`{id,response}`), add-trade-card **47**.

Open protocol gaps (return `unimplemented`): **buy-dev**, **play-dev**, **bank-trade**,
**create-trade** action ids, and the **roll** game-action id (Colonist uses a client shortcut).

---

## Tests & example

```bash
node --test                        # decode round-trips, state+watchdog, legal rules, tracker, engine API
node examples/replay-node.js       # headless full-game replay (bundled fixture) → Observation + 0 desyncs
node examples/replay-node.js path/to/frames.jsonl   # replay your own capture
```

The `test/fixtures/fullgame.jsonl` capture makes the folder self-testing with no external files.

---

## Architecture

```
catan-interface/
  index.js            the ONLY public entry: createEngine + enums + geometry + schemas
  src/
    protocol/         decode.js (msgpack decoder), encode.js (encoder), frames.js (Colonist framing)
    state/            gameState.js (snapshot+diff apply), watchdog.js (desync), eventBus.js
    domain/           boardGeometry.js, legal.js, controller.js, enums.js
    tracker/          tracker.js (card counting / hand belief / dev log)
    api/              observation.js, actions.js, schema.js
  test/               node --test suites + fixtures/
  examples/           replay-node.js
```

## License

MIT — see [LICENSE](./LICENSE).
