# hosted/server

Bun/TypeScript relay server. Entry point: `src/server.ts`.

## Commands

```bash
bun run src/server.ts          # production
bun run --watch src/server.ts  # dev with hot reload
bun test                       # unit tests (Jest-compatible via Bun)
drizzle-kit generate           # generate migration from schema change
drizzle-kit migrate            # apply pending migrations
drizzle-kit studio             # local DB browser
```

## Architecture

### Entry & Routing

`server.ts` registers all HTTP and WebSocket routes. It is large — key landmark line numbers:
- ~1212: `POST /workflows/:id/activate` — delegates to `workflow-activation.ts`
- WebSocket upgrade handler near the top

Workflow activation is extracted to `workflow-activation.ts` (`handleWorkflowActivation`). Do not put new activation logic back into `server.ts`.

### Key Subsystems

| File | Purpose |
|------|---------|
| `session-registry.ts` | Tracks active sessions (publisher WS + viewer WS list). One session per `?session=` param; `"default"` for legacy clients. |
| `node-definitions.ts` | **Single source of truth** for all node types. Backend validates edges, resolves pipelines, and dispatches configs from this. Frontend reads it via `GET /api/node-definitions`. |
| `app-registry.ts` | Loads `config/apps.json`, resolves workflow node types → `AppDefinition` objects. |
| `workflow-activation.ts` | Activation dispatch: categorizes nodes by `activationMode`, sends iOS config WS messages, fires AI/JEPA orchestrators. |
| `workflow-dispatch.ts` | WS message builders for iOS: `workflow_config`, `enhance_stage_config`, vision config. |
| `guidance-orchestrator.ts` | Manages s2s-live / s2s-rest / s2s-e4b. Handles `dependsOn` deferred activation. |
| `jepa-orchestrator.ts` | Manages JEPA vision models via Modal or mobile providers. |
| `reid-orchestrator.ts` | ReID appearance embedding service. |
| `palantir-orchestrator.ts` | Palantir AIP/Ontology integration. |
| `flow-detection.ts` | Union-Find algorithm to split a workflow DAG into independent flows. |
| `session-export.ts` | MP4 export via `ffmpeg` (requires ffmpeg ≥ 6.0). |
| `db/schema.ts` | Drizzle schema. Single source of truth for DB shape. |
| `db/queries.ts` | All DB read queries. |
| `db/db-writer.ts` | Async write queue — all mutations go through this, never write directly. |

### Config Files

- `config/apps.json` — primitive + app definitions. Binding target for `node-definitions.ts` entries. Adding a new node type = new entry in `node-definitions.ts` + new primitive/app in `apps.json`.

### WASM

`pkg/` contains the compiled frame-relay WASM module (do not edit). Rebuild only when `hosted/packages/frame-relay-wasm/` source changes: `npm run build:wasm` (requires Rust + wasm-bindgen).

## Critical Conventions

### Activation dispatch: always use raw node config

The activation loop has two parallel arrays:
- `processableNodes[i]` — raw DB node, `config` = user-set values (brightness, confidence, language, etc.)
- `appsToActivate[i]` — resolved `AppDefinition`, `config` = `AppConfig` (model, voice, input, output)

**When sending config to iOS: always read from `processableNodes[i].config`**, never from `appsToActivate[i].config`. See `pipeline-conventions.md` Rule 1.

### sessionId narrowing

`body.sessionId` is `string | undefined`, guarded by an early return. Store it in `const sid = body.sessionId` before any `.map()` — closures lose TypeScript narrowing from the guard.

### node-definitions.ts is the authority

Never duplicate node type logic in `server.ts` or `app-registry.ts`. All edge validation, role lookups, and allowed-target checks derive from `NODE_DEF_MAP`. If you add a node type, add it to `node-definitions.ts` only — everything else regenerates from it.

## Tests

Tests live in `test/`. Run with `bun test`. Integration tests hit a real SQLite DB — do not mock the DB layer.

Key test files:
- `session-registry.test.ts` — session lifecycle, publisher/viewer routing
- `workflow.test.ts` — activation dispatch, edge validation
- `session-export.test.ts` — ffmpeg export paths
- `audio-tap*.test.ts` — audio pipeline wiring
