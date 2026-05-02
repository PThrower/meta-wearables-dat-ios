# hosted/web-platform

Vite + vanilla TypeScript SPA. No React, no JSX — all DOM manipulation is imperative TS.

## Commands

```bash
bun install        # install dependencies
vite               # dev server (hot reload)
vite build         # production build → dist/
playwright test    # e2e tests
playwright test --ui  # e2e tests with browser UI
```

## Architecture

### Entry & Routing

`src/main.ts` — bootstraps auth and mounts the router.
`src/router/routes.ts` — route table (path → page module).
`src/router/router.ts` — client-side hash/history router.

### Auth

`src/auth/core.ts` — token storage, refresh, `authFetch` wrapper.
`src/auth.ts` — re-exports for convenience. All API calls use `authFetch` (not raw `fetch`) so tokens are injected automatically.

### Pages

| Directory / File | Page |
|---------|------|
| `pages/workflow/` | Workflow editor (canvas, node palette, config panel, SVG renderer) |
| `pages/dashboard.ts` | Dashboard home |
| `pages/analytics.ts` | Session analytics |
| `pages/devices.ts` | Device management |
| `pages/feeds.ts` | Feeds view |
| `pages/live-gallery.ts` | Live session gallery |

### Live Viewer (`src/live/`)

Modular live viewer split into responsibilities:
- `index.ts` — mount point, wires all modules
- `state.ts` — shared viewer state
- `message-handler.ts` — incoming WS message dispatch
- `mini-editor.ts` / `mini-editor-config.ts` / `mini-editor-palette.ts` — inline workflow editor overlay
- `controls.ts`, `activity-bar.ts`, `bottom-panel.ts`, `status-bar.ts` — UI panels
- `connection-overlay.ts` — connection state overlay

### Video Player (`src/player/`)

- `relay-player.ts` — H.264 playback via `jmuxer`
- `frau-builder.ts` — builds FRAU audio frames from PCM chunks
- `audio-worklet.ts` — AudioWorklet processor for low-latency playback
- `resampler.ts` — PCM resampling

### Core Utilities (`src/core/`)

- `api-client.ts` — typed fetch wrappers for all relay server endpoints. Exports `NodeDefinition` type (fetched from server) and `fetchNodeDefinitions()`.
- `event-bus.ts` — in-page pub/sub for cross-module communication

## Node Definitions: Frontend Mirror

`src/pages/workflow/node-defs.ts` contains `FALLBACK_PALETTE` — a static copy of all node definitions used when `GET /api/node-definitions` fails.

**This must stay in sync with `hosted/server/src/node-definitions.ts`.**

- Primary path: `fetchNodeDefinitions()` fetches from server at runtime. The server's `node-definitions.ts` is the authority.
- Fallback path: `FALLBACK_PALETTE` is used if the fetch fails (offline, unauthenticated, server down).
- When you add a node type to the server, add a matching entry to `FALLBACK_PALETTE`.
- `TYPE_ALIASES` in `node-defs.ts` maps old node type strings to current types — add entries here when renaming a type, never delete old keys.

## Workflow Editor (`src/pages/workflow/`)

| File | Responsibility |
|------|---------------|
| `node-defs.ts` | Palette definition, type aliases, fallback |
| `state.ts` | Editor state (nodes, edges, selection, drag) |
| `interactions.ts` | Mouse/touch event handlers |
| `canvas-controls.ts` | Zoom, pan, viewport |
| `svg-renderer.ts` | Renders workflow DAG as SVG |
| `config-panel.ts` | Per-node config form (driven by `configSchema`) |
| `flow-config-panel.ts` | Per-flow execution mode config |
| `flow-detection.ts` | Frontend Union-Find (mirrors server's) |
| `editor-view.ts` | Top-level editor mount |
| `editor-preview.ts` | Read-only preview mode |
| `node-actions.ts` | Add/remove/duplicate node operations |
| `node-availability.ts` | Grays out nodes based on connected device capabilities |
| `node-descriptions.ts` | Human-readable node descriptions for tooltips |
| `constants.ts` | Canvas grid size, snap values, z-index layers |

## Key Conventions

- No framework — DOM mutations are direct. Use `document.createElement` / `.appendChild` / `.innerHTML` patterns consistently with the surrounding file.
- `authFetch` everywhere — never use raw `fetch` for relay server endpoints.
- Config forms in the workflow editor are generated from `configSchema` arrays — do not hard-code field rendering for specific node types.
- `svg-renderer.ts` uses `subtitle` template strings from node definitions (e.g. `"${model}"`) — it resolves `${key}` against the node's live config at render time.
