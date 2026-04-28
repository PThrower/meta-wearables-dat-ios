# Pipeline Node Conventions

Lessons from implementing enhance nodes (brightness, sharpen, white balance, noise reduce, edge detect, night mode). Covers server dispatch, iOS pipeline, frontend workflow editor, and the bugs we shipped and fixed.

---

## Architecture: Pre-Broadcast Transform vs Observer Stage

Two kinds of pipeline stages:

**Observer stages** (VisionStage, DisplayStage, RelayStage, RecordingStage):
- Conform to `FramePipelineStage` protocol
- Registered in `FramePipelineManager.stages` array
- Receive frames via `Task.detached` fan-out (all run in parallel)
- Cannot modify the frame — they read the same `FramePacket`

**Pre-broadcast transforms** (FrameTransformStage):
- NOT a `FramePipelineStage` — it's a synchronous pre-processor
- Held in `FramePipelineManager.transformStage` property
- Runs inline on `@MainActor` BEFORE the fan-out to observer stages
- All observer stages see the transformed frame
- Config-driven: server sends one `enhance_stage_config` message, iOS creates/reconfigures the transform

```
SDK frame arrives
  → applyTransform(sampleBuffer) → new CVPixelBuffer (GPU, <3ms)
  → New FramePacket with transformed buffer
  → Fan-out to all observer stages (display, relay, recording, vision)
```

Zero overhead when transformStage is nil or disabled.

---

## Rule 1: Server Dispatch — Always Use Raw Node Config

The activation loop in `server.ts` has two parallel arrays:
- `processableNodes[i]` — raw workflow nodes from DB, `config` has user-set values (brightness, confidence, language, etc.)
- `appsToActivate[i]` — resolved `AppDefinition` objects, `config` is `AppConfig` (model, voice, input, output, lifecycle)

**When sending config to iOS, always read from `processableNodes[i]`.**

```typescript
// CORRECT — raw node config with user's values
params: (processableNodes[i].config ?? {}) as Record<string, number>
nodeType: processableNodes[i].type

// WRONG — resolved AppConfig with model/voice/input/output
params: (appsToActivate[i].config ?? {}) as Record<string, number>
```

Bug history: enhance nodes originally used `appsToActivate[i].config`. User's brightness/contrast values never reached the device — iOS always got the AppConfig (model, voice, input, output, lifecycle) and fell through to defaults.

---

## Rule 2: Server Dispatch — Categorized Parallel Activation

Nodes are categorized by `activationMode` and dispatched in parallel:

| Category | Dispatch | Awaits? |
|----------|----------|---------|
| vision | Fire-and-forget WS config to iOS | No |
| enhance | Collected into single `enhance_stage_config` WS message | No |
| ai (s2s-*, deepgram) | `Promise.allSettled` → `orchestrator.activateWithConfig()` | Yes (parallel) |
| jepa | `Promise.allSettled` → `jepaOrchestrator.activate()` | Yes (parallel) |

Sequential chains (processor A → processor B) are handled by the `dependsOn` mechanism inside `GuidanceOrchestrator.activateWithConfig()` — if B depends on A and A hasn't produced output, B is deferred. When A produces output, `activatePendingDependents` fires B. This works correctly even when all nodes start in parallel.

The `body.sessionId` is `string | undefined` but guarded by an early return. Store in `const sid = body.sessionId` before the dispatch section — `.map()` closures lose TypeScript narrowing from the guard.

---

## Rule 3: iOS Buffer Allocation — Fresh Buffer Per Frame

The pipeline fans out to stages via `Task.detached`:
```swift
for stage in stages {
    Task.detached { [stage] in
        await stage.processFrame(packet)
    }
}
```

Stages run asynchronously on their own actors. The main actor moves to the next frame immediately. **Any code that creates a new `CVPixelBuffer` must allocate a fresh one per frame** — never reuse a single buffer. Reuse causes a read-write race: main actor renders frame N+1 into the buffer while VisionStage is still reading frame N for OCR.

Bug history: `FrameTransformStage` originally had an `ensureOutputBuffer()` method that reused a single CVPixelBuffer if dimensions matched. This caused OCR to produce no results when enhance was active — the buffer was being overwritten mid-read.

---

## Rule 4: Pixel Format — Use BGRA for Transform Output

Output `CVPixelBuffer` must be `kCVPixelFormatType_32BGRA`:
- `CIContext.render()` — native format, no RGB-to-YCbCr conversion
- `DisplayStage` — CIImage → CGImage → UIImage
- `VisionStage` — `VNImageRequestHandler` handles BGRA natively
- `RelayStage` — JPEG encoding from BGRA
- `RecordingStage` — H.264 encoding from BGRA

Do NOT use `kCVPixelFormatType_420YpCbCr8BiPlanarFullRange`. It requires color space conversion, can cause silent CIContext.render failures, and the YUV output is not the native pipeline format.

---

## Rule 5: Format Description — Derive From Output Buffer

When wrapping an enhanced `CVPixelBuffer` in a new `CMSampleBuffer`:

```swift
// CORRECT — format description matches the enhanced buffer
var formatDescription: CMVideoFormatDescription?
CMVideoFormatDescriptionCreateForImageBuffer(
    allocator: kCFAllocatorDefault,
    imageBuffer: enhanced,
    formatDescriptionOut: &formatDescription
)

// WRONG — original format may describe a different pixel format
CMSampleBufferGetFormatDescription(sampleBuffer)!
```

Bug history: reused the original CMSampleBuffer's format description (which described the camera's native format, possibly H.264 or NV12) for the enhanced BGRA buffer. This created a lying CMSampleBuffer — downstream hardware-accelerated paths could produce corrupt output or fail silently.

---

## Rule 6: No CVPixelBufferLock Around GPU Render

`CIContext.render(_:to:bounds:colorSpace:)` writes to IOSurface-backed memory via GPU. `CVPixelBufferLockBaseAddress` creates a CPU-side mapping that is never written to by the GPU, producing stale/zero data for CPU-based readers.

```swift
// WRONG — creates stale CPU mapping
CVPixelBufferLockBaseAddress(outBuffer, [])
defer { CVPixelBufferUnlockBaseAddress(outBuffer, []) }
ciContext.render(ciImage, to: outBuffer, ...)

// CORRECT — GPU writes to IOSurface directly
ciContext.render(ciImage, to: outBuffer, ...)
```

---

## Rule 7: allowedTargets Must Include All Valid Downstream Types

`allowedTargets` controls which edges the workflow editor allows. It must list every concrete node type the source can connect TO, plus sentinel values for role-based matching.

Sentinel expansion:
- `<sink>` → matches any node with `role: "sink"` (overlays, tones, phone-speaker, glasses-speaker, debug-sink)
- `<trigger>` → matches any node with `role: "trigger"` (jepa-trigger, timer-trigger, conditional)
- `<source>` → matches any node with `role: "source"` (camera-source, phone-mic-source, glasses-mic-source, gesture-source)

For enhance nodes, allowedTargets must include:
- All vision types: `vision-face-detect`, `vision-barcode-scan`, `vision-ocr`, `vision-scene-classify`, `vision-person-detect`
- All other enhance types: `enhance-brightness`, `enhance-sharpen`, `enhance-white-balance`, `enhance-noise-reduce`, `enhance-edge-detect`, `enhance-night-mode`
- AI processors: `s2s-live`, `s2s-rest`, `s2s-e4b`, `jepa-vision`
- Sinks: `overlays` + `<sink>`
- Triggers: `<trigger>`

Bug history: enhance nodes originally only had AI processors + sinks + triggers in allowedTargets. Couldn't connect enhance-brightness → vision-ocr in the editor. Fixed by adding all vision and enhance types.

---

## Rule 8: Frontend node-defs.ts Must Mirror Server node-definitions.ts

Two separate files define nodes:
- `hosted/server/src/node-definitions.ts` — server-side definitions (API, activation dispatch)
- `hosted/web-platform/src/pages/workflow/node-defs.ts` — frontend FALLBACK_PALETTE (editor palette, edge validation)

Both must have matching `allowedTargets` arrays. If you add a type to one, add it to the other. Mismatch causes edges to work in one context but fail in another.

---

## Rule 9: Parallel Execution Is Fan-Out, Not a Setting

Nodes that fan out from the same source run in parallel automatically. No special "parallel mode" is needed within a single flow:

```
Camera ──→ Overlays      (step 1)
      ──→ OCR            (step 1)   ← all three run simultaneously
      ──→ Brightness     (step 1)
```

Sequential execution only occurs when processor B has an incoming edge from processor A (B depends on A's output). The SVG renderer shows topological depth as step numbers on edges — same step number = parallel.

`FlowExecutionMode` (parallel/sequential/event-driven) controls ordering between **disconnected flows** (separate subgraphs), not within a single flow.

---

## Node Type Audit (as of 2026-04-28)

| Type | activationMode | Dispatch | Config Source | Creates Buffers | Status |
|------|---------------|----------|---------------|-----------------|--------|
| vision-face-detect | vision | WS config to iOS | `processableNodes[i].config` | No | Clean |
| vision-barcode-scan | vision | WS config to iOS | `processableNodes[i].config` | No | Clean |
| vision-ocr | vision | WS config to iOS | `processableNodes[i].config` | No | Clean |
| vision-scene-classify | vision | WS config to iOS | `processableNodes[i].config` | No | Clean |
| vision-person-detect | vision | WS config to iOS | `processableNodes[i].config` | No | Clean |
| enhance-brightness | enhance | WS config to iOS | `processableNodes[i].config` | Yes (per-frame BGRA) | Fixed |
| enhance-sharpen | enhance | WS config to iOS | `processableNodes[i].config` | Yes (per-frame BGRA) | Fixed |
| enhance-white-balance | enhance | WS config to iOS | `processableNodes[i].config` | Yes (per-frame BGRA) | Fixed |
| enhance-noise-reduce | enhance | WS config to iOS | `processableNodes[i].config` | Yes (per-frame BGRA) | Fixed |
| enhance-edge-detect | enhance | WS config to iOS | `processableNodes[i].config` | Yes (per-frame BGRA) | Fixed |
| enhance-night-mode | enhance | WS config to iOS | `processableNodes[i].config` | Yes (per-frame BGRA) | Fixed |
| jepa-vision | jepa | `jepaOrchestrator.activate()` | `app.config.jepa` | No (server GPU) | Clean |
| s2s-live | ai | `orchestrator.activateWithConfig()` | AppConfig (correct) | No | Clean |
| s2s-rest | ai | `orchestrator.activateWithConfig()` | AppConfig (correct) | No | Clean |
| s2s-e4b | ai | `orchestrator.activateWithConfig()` | AppConfig (correct) | No | Clean |
| deepgram-stt | stt | `orchestrator.activateWithConfig()` | AppConfig (correct) | No | Clean |
| camera-source | null | Not activated | N/A (source) | No | Clean |
| overlays/tones/speakers | null | `workflow_config` WS | Raw node config | No | Clean |
| jepa-trigger | null | Not activated | N/A (structural) | No | Clean |
| timer-trigger | null | Not activated | N/A (structural) | No | Clean |
| conditional | null | Not activated | N/A (structural) | No | Clean |
| local-tts | null | `workflow_config` WS | Raw node config | No | Clean |

## Key Files

- Server dispatch: `hosted/server/src/server.ts` (activation endpoint ~line 1212)
- Server node definitions: `hosted/server/src/node-definitions.ts`
- Pipeline resolution: `hosted/server/src/app-registry.ts` (`resolveWorkflowToPipeline`)
- Orchestrator: `hosted/server/src/guidance-orchestrator.ts` (dependsOn, deferred activations)
- Flow detection: `hosted/server/src/flow-detection.ts` (Union-Find)
- Frontend node defs: `hosted/web-platform/src/pages/workflow/node-defs.ts`
- iOS pipeline manager: `publishers/CameraAccess/CameraAccess/Pipeline/FramePipelineManager.swift`
- iOS transform stage: `publishers/CameraAccess/CameraAccess/Pipeline/Stages/FrameTransformStage.swift`
- iOS enhance types: `publishers/CameraAccess/CameraAccess/Pipeline/EnhanceTypes.swift`
- iOS vision stage: `publishers/CameraAccess/CameraAccess/Pipeline/Stages/VisionStage.swift`
- iOS ViewModel: `publishers/CameraAccess/CameraAccess/ViewModels/StreamSessionViewModel.swift`
