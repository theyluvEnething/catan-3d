# catan-interface

A standalone, framework-agnostic JavaScript engine for the **Colonist.io** game interface.

> Full public API documentation is written in the final stage. This folder is being assembled
> by extraction from the `catan-3d-extension` repo. It is designed to be lifted into its own
> repository with **zero edits** — it carries its own `package.json`, tests, and examples, and
> imports nothing from outside itself.

## What it is

- **Protocol** — the verified MessagePack wire format + Colonist framing (decode/encode/frames).
- **State** — full game-state reconstruction from snapshot + incremental diffs, with a desync
  watchdog against authoritative snapshots.
- **Domain** — board geometry (hex axial coords + adjacency), legal-move rules, turn/phase
  controller, and enums.
- **Tracker** — card counting / hand-belief inference / dev-card log.
- **API** — a normalized, LLM-friendly Observation and a validated Action tool surface.

## Zero dependencies, no build step

Pure ES modules. No DOM, no `three`, no `chrome.*`, no bundler. Runs identically in a browser
and in Node (>=18).

## License

MIT — see [LICENSE](./LICENSE).
