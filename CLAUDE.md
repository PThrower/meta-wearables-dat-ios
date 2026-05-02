# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This repo has two independent codebases that talk to each other:

- **`publishers/CameraAccess/`** — iOS SwiftUI app using the Meta Wearables DAT SDK to stream camera frames from Ray-Ban Meta glasses
- **`hosted/`** — Bun/TypeScript relay server, auth gateway, and web viewer frontend

The iOS app streams H.264 video frames over WebSocket to the relay server; the web viewer and AI services connect to the same server.

---

## Commands

### iOS (Xcode)

Open `publishers/CameraAccess/CameraAccess.xcodeproj` in Xcode. There is no command-line build script — use the `build` skill:

```
/build
```

Run unit tests from Xcode: `CameraAccessTests` target. UI tests: `CameraAccessUITests` target.

### Relay Server (`hosted/server/`)

```bash
cd hosted/server
bun run src/server.ts          # production
bun run --watch src/server.ts  # dev with reload
bun test                       # unit tests
```

### Web Platform (`hosted/web-platform/`)

```bash
cd hosted/web-platform
bun install
vite                           # dev server
vite build                     # production build
playwright test                # e2e tests
playwright test --ui           # e2e tests with UI
```

### Gateway (`hosted/gateway/`)

```bash
cd hosted/gateway
bun run src/index.ts
```

### Build Order for Fresh Clone

`relay-protocol` dist is gitignored and must be built before the server:

```bash
cd hosted/packages/relay-protocol && bun install && bun x tsc
cd hosted/server && bun install
```

WASM rebuild (only needed when `hosted/packages/frame-relay-wasm/` changes):

```bash
cd hosted/server && npm run build:wasm   # requires Rust + wasm-bindgen
```

### Database (`hosted/server/`)

```bash
drizzle-kit generate   # generate migration from schema
drizzle-kit migrate    # apply migration
drizzle-kit studio     # local DB browser
```

---

## Architecture

### iOS Pipeline

Frames from the glasses SDK flow through a two-layer pipeline in `FramePipelineManager`:

1. **Pre-broadcast transform** (`FrameTransformStage`) — runs synchronously on `@MainActor` before any observer sees the frame. Handles all `enhance-*` node types (brightness, sharpen, white balance, etc.). Nil when no enhance node is active; zero overhead.

2. **Observer stages** — fan-out via `Task.detached` (all run in parallel):
   - `DisplayStage` — renders to SwiftUI
   - `RelayStage` — JPEG/H.264 encode → WebSocket to server
   - `VisionStage` — Core ML / Vision requests (OCR, face, barcode, etc.)
   - `RecordingStage` — local MP4 recording
   - `YOLOStage`, `ObjectTrackingStage` (OC-SORT), `AudioStage`, etc.

Key files:
- `Pipeline/FramePipelineManager.swift` — orchestrates both layers
- `Pipeline/Stages/FrameTransformStage.swift` — GPU enhance (CIFilter via CIContext)
- `Pipeline/Stages/VisionStage.swift` — Vision/Core ML requests
- `ViewModels/StreamSessionViewModel.swift` — DAT SDK session lifecycle, workflow activation

### Hosted Server (`hosted/server/src/`)

Single-file entry point: `server.ts`. Key subsystems:

- **Session registry** (`session-registry.ts`) — tracks active iOS sessions and viewer WebSockets
- **Workflow activation** (`server.ts` ~line 1212) — receives workflow from web, resolves nodes, dispatches configs to iOS and AI services
- **Guidance orchestrator** (`guidance-orchestrator.ts`) — manages s2s-live/s2s-rest/s2s-e4b AI processors, handles `dependsOn` deferred activation
- **JEPA orchestrator** (`jepa-orchestrator.ts`) — manages JEPA vision models
- **App registry** (`app-registry.ts`) — resolves workflow node types to `AppDefinition` objects
- **Node definitions** (`node-definitions.ts`) — canonical node type list with `activationMode`, `allowedTargets`, config schemas
- **Session export** (`session-export.ts`) — MP4 export via ffmpeg (requires ffmpeg ≥ 6.0)
- **Deepgram STT** (`deepgram-stt-service.ts`), **Gemini Live** (`gemini-live-service.ts`), **Gemma4** (`gemma4-service.ts`)

### Web Platform (`hosted/web-platform/src/`)

Vite + TypeScript SPA. Key pages: workflow editor (`pages/workflow/`), live viewer, session gallery. The workflow editor reads node definitions from `pages/workflow/node-defs.ts` — this is the frontend mirror of the server's `node-definitions.ts` and must stay in sync.

### Deployment

- VPS: `relay.simulationapi.com` (Hetzner), managed by systemd (`caringmind-relay.service`)
- Active branch on VPS: `feat/stream-registry` (not `main`)
- Caddy reverse proxy: `/api/*` and WebSocket routes → Bun `:8080`; SPA served from `hosted/viewer/dist/`
- Secrets in `/root/relay-server/hosted/server/.env` (Doppler: `caringmind-hosted / prd`)

See `hosted/DEPLOYMENT.md` for full VPS layout and service commands.

---

## Key Conventions (non-obvious)

These are captured in `.claude/rules/` and summarized here:

### Server: workflow activation dispatch

When building the activation section of `server.ts`, **always read node config from `processableNodes[i].config`** (raw DB node with user values), never from `appsToActivate[i].config` (resolved `AppConfig` with model/voice settings). See `pipeline-conventions.md` Rule 1.

The two parallel arrays in the activation loop:
- `processableNodes[i]` — raw node, `config` = user-set params (brightness, confidence, etc.)
- `appsToActivate[i]` — resolved `AppDefinition`, `config` = `AppConfig` (model, voice, input, output)

### iOS: buffer allocation

Every frame must get a **fresh `CVPixelBuffer`** — never reuse a buffer across frames. The fan-out to observer stages runs asynchronously, so reuse causes read-write races. Output format must be `kCVPixelFormatType_32BGRA`. Do not use `CVPixelBufferLockBaseAddress` around GPU renders (`CIContext.render`). See `pipeline-conventions.md` Rules 3–6.

### iOS: HFP audio ordering

If a workflow requires glasses microphone (codecType 1), `startAudioSession()` must be called and awaited (~2s) **before** `streamSession.start()`. Starting the stream before HFP is ready causes silent fallback to phone mic with no mid-session switch. See `dat-audio-hfp.md`.

### Node definitions: allowedTargets

`allowedTargets` in both `node-definitions.ts` (server) and `node-defs.ts` (frontend) must include every concrete downstream type. Sentinels `<sink>`, `<trigger>`, `<source>` expand to role-matched types. Adding a new node type requires updating both files. See `pipeline-conventions.md` Rule 7–8.

### iOS mock testing

Use `MockDeviceKit` from `MWDATMockDevice` for tests that don't need hardware. `WearablesViewModel` and `StreamSessionViewModel` support injection of a mock device session.
