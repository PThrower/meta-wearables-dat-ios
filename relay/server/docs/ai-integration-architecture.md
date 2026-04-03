# AI Integration Architecture

How to tap the existing capture pipeline for AI workloads -- real-time inference, server-side analysis, and batch processing. Written 2026-04-03 against commit `33ea802` on `feat/telemetry-diagnostics`.

This is a planning document. No code changes required to support any of these -- the `FramePipelineStage` protocol and the relay's fan-out design already provide the extension points.

---

## Current Tap Points

```
FramePipelineManager
       |
       +---> DisplayStage    (UIImage -> UI)
       +---> RelayStage      (JPEG -> FRLY -> WebSocket)
       +---> RecordingStage  (CMSampleBuffer -> .mov)
       |
       +---> [AVAILABLE]     -- any new FramePipelineStage
```

Three places to intercept frames for AI:

1. **iOS-Side AI Stage** -- add a new `FramePipelineStage` actor
2. **Server-Side AI Worker** -- add a new consumer alongside viewers in the relay fan-out
3. **Batch from Recordings** -- post-process `.mov` files from the existing `RecordingStage`

---

## Option 1: iOS-Side AI Stage (On-Device)

Add an `AIStage: FramePipelineStage` actor. Gets the same `FramePacket` (raw `CMSampleBuffer`) as every other stage.

```swift
actor AIStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "ai"
    var config = FrameStageConfig(targetFPS: 4)  // 4fps is enough for most CV tasks

    func processFrame(_ packet: FramePacket) async {
        // CMSampleBuffer -> CVPixelBuffer -> VNImageRequestHandler
        // CoreML / Vision framework inference
    }
}
```

**Good for:** Person detection, motion detection, barcode/QR, lightweight classification

**Limits:** iPhone GPU, battery, 4-8 fps realistic ceiling for non-trivial models

**Framework options:**
- `Vision` -- Apple's built-in face detection, object tracking, text recognition, barcode scanning
- `CoreML` -- custom models converted from TensorFlow/PyTorch via `coremltools`
- `CreateML` -- train lightweight models on-device from labeled data

**Throttling:** The `FrameStageConfig(targetFPS: 4)` means AI only processes every 250ms. The camera can still stream at 30fps to the relay -- the stage just drops frames it doesn't need.

---

## Option 2: Server-Side AI Worker

The server already has every frame as raw binary. Add a new consumer alongside viewers:

```
Publisher --> server.ts --> fanout to viewers
                          --> fanout to AI worker (WebSocket or HTTP)
```

The server forwards frames to a dedicated AI service (GPU box, cloud endpoint). Same FRLY binary -- the worker just needs to strip the 29-byte header and run inference on the JPEG.

**Good for:** Heavy models (LLM vision, detailed scene description, OCR), no battery impact on phone

**Limits:** Network latency (50-200ms to server + inference time), bandwidth cost per frame

**Server endpoint options:**

| Approach | Description |
|----------|-------------|
| `WS /analyze` | New WebSocket endpoint, server fans out frames like viewers but to AI service |
| HTTP POST | Server forwards JPEG payload to REST endpoint on AI worker |
| gRPC stream | High-performance binary streaming to AI worker |
| Message queue | Server publishes to Redis/NATS queue, AI workers consume asynchronously |

**Wire format:** AI worker receives the same FRLY binary the server already parses:
```
[4B "FRLY"][8B seq][4B w][4B h][1B quality][8B ts][JPEG payload]
```
Strip 29-byte header, decode JPEG, run inference. The `decode_frame_prefix()` function in the WASM crate already handles this.

---

## Option 3: Batch from Recordings

The existing `RecordingStage` writes `.mov` files. Post-process them.

**Good for:** Training data, periodic analysis, anything non-real-time

**Limits:** Not live, requires storage + separate pipeline

**Workflow:**
1. `RecordingStage` captures `.mov` to local storage or cloud
2. Offline job extracts frames at desired interval
3. Run batch inference (training, evaluation, compliance review)

---

## Comparison: Where Does Inference Run?

| Factor | On-Device (CoreML) | Server-Side (Worker) | Batch (Recording) |
|--------|--------------------|----------------------|--------------------|
| Latency | 10-50ms | 100-500ms | Minutes/hours |
| Model size | <100MB | Unlimited | Unlimited |
| Battery impact | High | None | None |
| Bandwidth | None | High (JPEG stream) | None (local file) |
| Privacy | Stays on device | Leaves device | Stays local |
| Real-time | Yes | Yes (with latency) | No |

---

## Likely Architecture for CaringMind

Given CaringMind is assistive/monitoring, the practical split is:

```
iOS Device                                    Server
========                                      ======

AIStage (lightweight, 4fps)                   AI Worker Service
  - person detection (Vision)                   - scene description (VLM)
  - fall/motion anomaly                         - text/OCR (documents, signs)
  - face proximity alert                        - audio transcription (Whisper)
                                                - contextual analysis
       |                                             ^
       v                                             |
  RelayStage -- FRLY/FRAU --> server.ts -- forward frames --->
                                |
                                +---> viewers (existing)
                                +---> AI worker (new)
```

- **On-device:** Fast, privacy-safe alerts (person entered room, fall detected)
- **Server-side:** Heavy understanding (describe the scene, read text, transcribe conversation)
- **Shared transport:** Same FRLY wire protocol, server just adds another fan-out target

---

## On-Device AI Stage: Detailed Design

### Actor Model

```swift
actor AIStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "ai"
    var config: FrameStageConfig

    // Vision requests -- created once, reused across frames
    private let personDetectionRequest: VNDetectHumanRectanglesRequest
    private let faceDetectionRequest: VNDetectFaceRectanglesRequest
    private let textRecognitionRequest: VNRecognizeTextRequest

    // Callbacks
    private let onDetection: @Sendable (AIDetection) async -> Void

    init(config: FrameStageConfig = FrameStageConfig(targetFPS: 4),
         onDetection: @escaping @Sendable (AIDetection) async -> Void) {
        self.config = config
        self.onDetection = onDetection
        self.personDetectionRequest = VNDetectHumanRectanglesRequest()
        self.faceDetectionRequest = VNDetectFaceRectanglesRequest()
        self.textRecognitionRequest = VNRecognizeTextRequest()
    }

    nonisolated func processFrame(_ packet: FramePacket) async {
        await analyzeFrame(packet)
    }

    private func analyzeFrame(_ packet: FramePacket) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(packet.sampleBuffer) else { return }

        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])

        do {
            try handler.perform([
                personDetectionRequest,
                faceDetectionRequest,
                textRecognitionRequest
            ])

            let detection = AIDetection(
                persons: personDetectionRequest.results?.count ?? 0,
                faces: faceDetectionRequest.results?.count ?? 0,
                text: textRecognitionRequest.results?.first?.topCandidates(1).first?.string,
                timestamp: packet.timestamp
            )

            Task { await onDetection(detection) }
        } catch {
            NSLog("[AIStage] Vision request failed: \(error)")
        }
    }
}
```

### Integration

```swift
// In the view model or pipeline setup:
let aiStage = AIStage(targetFPS: 4) { detection in
    // Push to UI, trigger alerts, send to server
    NSLog("[AI] persons=\(detection.persons) faces=\(detection.faces)")
}
pipelineManager.register(aiStage)
```

No changes to `FramePipelineManager`, `FramePipelineStage`, or any existing stage. Register and go.

---

## Server-Side AI Worker: Detailed Design

### New Endpoint

Add `WS /analyze?session=<id>` to the relay server. Functions identically to `/view` but fans out to an AI service instead of a browser viewer:

```ts
// In server.ts fetch() handler:
if (url.pathname === "/analyze") {
  const session = /* resolve session */;
  // Same fan-out as /view, but tagged as "analyzer" role
  // Server forwards every frame (or throttled subset) to the AI worker
}
```

### AI Worker Service (Separate Process)

```
+------------------+     FRLY binary     +------------------+
|  Bun Relay       | --------------------> |  AI Worker       |
|  server.ts       |  WS /analyze         |  (Python/Node)   |
|                  |                      |                  |
|  Fan out frames  |                      |  Strip header    |
|  to analyzers    |                      |  Decode JPEG     |
|  alongside       |                      |  Run inference   |
|  viewers         |                      |  Return results  |
+------------------+                      +------------------+
                                                |
                                                v
                                          Results storage
                                          (DB, queue, WebSocket
                                           back to relay)
```

### Frame Forwarding

The server already has the fan-out loop. Adding an analyzer is adding another branch:

```ts
// Current:
for (const [id, viewer] of session.viewers) {
  if (viewer.relay.should_relay(Date.now())) {
    viewer.ws.send(frame);
  }
}

// With AI worker:
for (const [id, analyzer] of session.analyzers) {
  // AI workers get every frame or a throttled subset
  if (analyzer.relay.should_relay(Date.now())) {
    analyzer.ws.send(frame);
  }
}
```

### Result Channel

AI inference results need to get back to someone -- the iOS app, viewers, or a storage layer. Options:

| Channel | Direction | Use Case |
|---------|-----------|----------|
| WebSocket message back to relay | Worker -> Server -> iOS | Real-time alerts (person detected, text read) |
| HTTP callback to relay | Worker -> Server | Asynchronous results |
| Direct to viewer via server | Worker -> Server -> Viewer | Scene description overlay in browser |
| Database/storage | Worker -> DB | Historical analysis, compliance |

---

## Audio AI: Whisper Transcription

The `AudioStage` already captures 48kHz mono PCM and sends it as FRAU frames. A server-side Whisper worker can:

1. Receive FRAU audio frames over `/analyze` (or a dedicated `/analyze-audio` endpoint)
2. Buffer chunks into 5-30 second segments
3. Run Whisper (or faster-whisper) for transcription
4. Return text results via WebSocket message or callback

The FRAU wire format already includes timestamps in the same epoch as FRLY video frames, enabling audio/video synchronization for multimodal AI (e.g., "describe what the person is doing while saying X").

---

## Implementation Priority

Not prioritized for current sprint. When ready, the sequence would be:

1. **Phase 1:** On-device `AIStage` with Vision framework person/face detection (zero server changes, zero new dependencies)
2. **Phase 2:** Server-side `/analyze` endpoint + separate AI worker process for heavy inference
3. **Phase 3:** Audio transcription via Whisper on AI worker
4. **Phase 4:** Multimodal (vision + audio) context analysis

Each phase builds on the previous. The `FramePipelineStage` protocol and relay fan-out design require zero refactoring to support any of these.

---

## Staleness Warning

This document was written against the codebase on `feat/telemetry-diagnostics` at commit `33ea802`. The pipeline architecture, wire protocols, and stage interfaces will change as:

- Multi-session routing is implemented (see `docs/multi-session-platform.md`)
- Auth is introduced (see `docs/auth-google-oauth.md`)
- New stages or wire protocol changes are made (see `docs/pipeline-architecture.md`)

Before implementing AI integration, re-read the affected files and update this document.
