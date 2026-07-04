# Catan 3D — Colonist.io 3D Board (MV3 extension)

Replaces Colonist.io's 2D board with a real-time 3D board rendered in Three.js, driven purely
by intercepted WebSocket traffic. Personal visualization/enhancement tool.

Status: **Gate 1 passed** (live, provably-accurate game-state reconstruction + debug HUD) and
**Gate 2 passing** (a Three.js 3D board that mirrors the live game in real time). Gate 3
(interactions / placing pieces from the 3D view) is not started.

## Repo layout
```
extension/                        unpacked MV3 extension (load this in Chrome)
  manifest.json                   MV3 manifest (two content scripts: MAIN + ISOLATED)
  src/content.js                  isolated-world bootstrap (loads the modules, drives HUD)
  src/protocol/interceptor.js     MAIN-world WebSocket patch (document_start)
  src/protocol/decode.js          MessagePack + Colonist framing codec (the protocol module)
  src/state/gameState.js          type-4 snapshot + type-91 diffs -> full reconstructed state
  src/render/boardGeometry.js     hex-grid math (axial/corner/edge) for 3D + interactions
  src/render/scene.js             Three.js scene (tiles, tokens, pieces, water, lights)
  src/render/materials.js         procedural PBR tile textures + normal maps
  src/render/mount.js             mounts the 3D board over Colonist's live canvas
  src/render/hud.js               on-page debug HUD (toggle Alt+H)
  src/interact/                   Gate-3 interaction scaffolding (forward.js, legal.js)
  vendor/                         bundled three.module.js + OrbitControls (no CDN)
harness/                          Playwright dev harness (drives real Chrome)
NOTES.md                          SOURCE OF TRUTH: protocol schema, coordinates, gate evidence
debug/frames/                     captured WebSocket frame dumps (JSONL)
debug/screenshots/                gate screenshots (HUD/3D vs real board)
```

## Load the extension (your normal Chrome)
1. Open `chrome://extensions` and enable **Developer mode** (top-right toggle).
2. Click **Load unpacked** and select the `extension/` folder.
3. Open https://colonist.io and start a game. The debug HUD appears top-left (toggle **Alt+H**).

> Chrome 137+ blocks the command-line `--load-extension` flag on the stable channel (verified
> broken on Chrome 149). **Load unpacked** from the Extensions page is the supported path and
> works fine. The dev harness therefore injects the same runtime via Playwright's
> `addInitScript` (see below) rather than relying on `--load-extension`.

## Run the harness (development)
Prereqs: Node 22+ and a dedicated Chrome profile logged into Colonist. The harness launches
**real Chrome** (`channel: "chrome"`, non-headless) against a persistent `./.colonist-profile`,
so the login is reused across runs. `.colonist-profile/` is git-ignored — it holds your
session and must never be committed.

```
cd harness
npm install                # installs playwright + @msgpack/msgpack + three

node login-once.js         # ONE TIME: opens Chrome on colonist.io; log in, press Enter to save
node capture.js            # start a bot game and dump every WebSocket frame to debug/frames/
node gate2.js              # start a game, play the opening, mount the 3D board over the live
                           # canvas, and screenshot the 3D mirror vs the real board
```

Other useful scripts in `harness/`:
```
node verify-decode.js      # prove decode.js matches @msgpack/msgpack on captured frames
node analyze.js            # decode a capture into readable JSON (debug/frames/<run>/decoded)
node replay.js             # replay a capture through the state model, print reconstructed board
node validate-live.js      # start a game; checkpoint HUD-vs-board agreement (Gate-1 evidence)
node autoplay.js           # minimal auto-player that drives a bot game (for full-game capture)
```
`node capture.js --no-start` launches and captures without auto-starting a game.

## How it works
- **Interceptor** (`src/protocol/interceptor.js`, MAIN world, `document_start`) monkey-patches
  `window.WebSocket` before Colonist opens its socket, captures both directions, and bridges
  frames to the isolated world via a `postMessage`/CustomEvent bridge.
- **Protocol** (`src/protocol/decode.js`): Colonist speaks **MessagePack**. Incoming frames are
  bare msgpack `{ id, data: { type, payload } }`; outgoing frames are
  `[b0][seq][strlen][channel]` + a msgpack body. All protocol-specific logic is isolated here.
- **State** (`src/state/gameState.js`): applies the type-4 full snapshot, then recursively
  deep-merges type-91 incremental diffs, maintaining the full board + players + turn/phase model
  (null value in a diff = delete key).
- **Render** (`src/render/`): `boardGeometry.js` turns axial hex/corner/edge coordinates into
  3D positions; `scene.js` + `materials.js` build the Three.js diorama (procedural PBR tiles,
  number tokens, settlement/city/road/robber meshes in player colors, water, lights);
  `mount.js` overlays it on Colonist's hidden `#game-canvas` and updates reactively.
- **HUD** (`src/render/hud.js`): renders the reconstructed state live for verification.

See `NOTES.md` for the full discovered schema, coordinate system, enum tables, and gate evidence.

## Known limitations
- **Interactions (Gate 3) not built.** You cannot yet place pieces from the 3D view. Placement
  will use direct WebSocket sends (build actions carry a board index, not a pixel) because
  Colonist's WebGL input requires trusted events that synthetic clicks can't forge. Scaffolding
  lives in `src/interact/`.
- **Resource color↔type not fully pinned.** desert/brick/ore are verified by texture;
  wood/sheep/wheat (types 1/3/4) are read off board screenshots (counts match) and should be
  confirmed side-by-side. Port `type` enum (2:1 resource ports) is still a hypothesis.
- **No end-to-end victory capture.** The auto-player passes turns rather than spending
  resources, so captured games end via a bot's long-horizon victory; reconstruction correctness
  is nonetheless proven across setup, dice, robber, steal, trade, and turn transitions.
- **The dev harness injects the runtime** (Chrome blocks CLI `--load-extension`), and `gate2.js`
  additionally serves `extension/` over a local HTTP server so the page can `import` the
  ES-module 3D scene. The shipped extension loads normally via **Load unpacked** and needs
  neither mechanism.
- **Protocol is reverse-engineered** from the current Colonist build. If Colonist changes its
  wire format, `src/protocol/` is the module to update; treat any NOTES entry marked 🟡
  (hypothesis) as unverified until a fresh capture confirms it.
</content>
</invoke>
