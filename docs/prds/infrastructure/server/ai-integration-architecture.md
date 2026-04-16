# AI Integration Architecture

How to tap the existing capture pipeline for AI workloads -- real-time inference, server-side analysis, and batch processing. Updated 2026-04-15 against branch `feat/stream-registry` at commit `24f4821`.

This is a planning document. The `FramePipelineStage` protocol and the relay's fan-out design already provide the extension points. Since the original version of this doc, the server now has `ControlEventBus`, `AudioTapBus` with a WebSocket endpoint, `AppRegistry`, and bidirectional audio -- making event-driven AI engagement the primary architecture.

---

## Current Tap Points

```
iOS Device                                     Server
===========                                    ======

FramePipelineManager
       |
       +---> DisplayStage        (UIImage -> UI)
       +---> RelayStage          (JPEG -> FRLY -> WebSocket)
       |         |                        |
       |         +--> receive loop        +---> viewer fan-out (/view)
       |              |                   +---> audio tap fan-out (/tap/audio)
       |              v                        |
       |         onReceivedAudio               v
       |              |                   AudioTapBus
       |              v                   (parsed FRAU frames)
       |         AudioPlaybackStage             |
       |         (FRAU -> AVAudioEngine)        +---> recording
       |                                         +---> transcription
       +---> RecordingStage  (CMSampleBuffer -> .mov)   +---> AI worker (planned)
       |
       +---> [AVAILABLE]  -- any new FramePipelineStage

AudioEventBus (iOS)                            ControlEventBus (server)
  - codecType 0: phone mic (48kHz)              - gesture events (thumbs_up/down, open_palm, pointing)
  - codecType 1: glasses HFP (16kHz)            - activate_app / deactivate_app
  - codecType 2: TTS PCM (22050Hz)              - app_status
  - codecType 3: viewer push-to-talk            - callback + AsyncIterable subscriptions

                                               AppRegistry (server)
                                                 - primitives: s2s-gemini-live, hand-pose
                                                 - apps: spanish-co-pilot (bound to s2s-gemini-live)
                                                 - systemPrompt, model, voice, visionFps, gestures

AudioTapClient (iOS)                           /session/<id>/audio-in (POST)
  - connects to /tap/audio WebSocket             - pushes FRAU frames to publisher's WebSocket
  - receives JSON audio frames                   - enables server -> iOS audio (guidance, TTS)
  - publishes to AudioEventBus

Five places to intercept for AI:

1. **iOS-Side AI Stage** -- add a new `FramePipelineStage` actor
2. **Server-Side AI Worker** -- add a new consumer alongside viewers in the relay fan-out
3. **Server-Side Event-Driven** -- AI worker subscribes to ControlEventBus + AudioTapBus, receives frames only on trigger
4. **Audio Tap Pipeline** -- AudioTapBus + AudioTapClient for audio-only AI (transcription, voice commands)
5. **Batch from Recordings** -- post-process `.mov` files from the existing `RecordingStage`
```

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
Publisher --> server.ts --> fan-out to viewers (/view)
                          --> fan-out to audio taps (/tap/audio)
                          --> fan-out to AI worker (/analyze, planned)
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

**Input sources (now available):**

The AI worker does not need to watch everything. It can subscribe to event buses:

- `ControlEventBus` -- gesture triggers (thumbs_up, open_palm, pointing) initiate AI engagement
- `AudioTapBus` -- audio frames for transcription / voice command detection
- `AppRegistry` -- app definitions drive systemPrompt, model selection, visionFps, gesture bindings
- Frame fan-out via `/analyze` -- throttled baseline frame stream (e.g., 1fps from app config `visionFps`)

**Output path (now available):**

```
AI Worker --> server.ts --> POST /session/<id>/audio-in --> publisher WebSocket --> iOS
                                                                                        |
                                                                                  RelayStage receive loop
                                                                                        |
                                                                                  onReceivedAudio callback
                                                                                        |
                                                                                  AudioPlaybackStage
                                                                                  (FRAU -> AVAudioEngine)
```

The `/session/<id>/audio-in` endpoint accepts FRAU binary and pushes it to the publisher's WebSocket. The iOS `RelayStage` receive loop detects FRAU magic bytes from the server, dispatches to `onReceivedAudio`, and `AudioPlaybackStage` plays through `AVAudioEngine`. This is the guidance output channel.

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

## Trigger Sources for AI Engagement

The AI worker does NOT process everything all the time (unlike GlassFlow's LiveKit agent model which watches every frame continuously). Instead, the server's event buses provide discrete trigger sources:

### ControlEventBus (Built)

Pub/sub for gesture/control events from the iOS publisher. Supports callback and AsyncIterable subscriptions.

**Event types:**

| Type | Fields | Trigger |
|------|--------|---------|
| `gesture` | `gesture`, `confidence`, `timestampMs` | User performs hand gesture detected on-device |
| `activate_app` | `appId` | User activates an app (e.g., spanish-co-pilot) |
| `deactivate_app` | `appId` | User deactivates an app |
| `app_status` | `appId` | App reports status change |

**Gesture values:** `thumbs_up`, `thumbs_down`, `open_palm`, `pointing`

**Usage pattern:** AI worker subscribes to `ControlEventBus` via `onEvent()` callback. When a gesture arrives (e.g., `pointing`), the worker requests frames at `visionFps` rate from the relay, runs VLM inference with the app's `systemPrompt`, and sends guidance audio back via `/session/<id>/audio-in`.

### AudioTapBus (Built)

Pub/sub for parsed audio frames. The server's `/tap/audio?session=<id>` WebSocket endpoint streams FRAU binary to connected taps.

**Audio frame structure:**
```ts
{ codecType, sequence, sampleRate, channels, bitsPerSample, timestampMs, pcm: Uint8Array }
```

**Usage pattern:** AI worker subscribes to `AudioTapBus` via `subscribe()` AsyncIterable. Buffers audio chunks into 5-30 second segments, runs Whisper for transcription, detects voice commands or conversation context. Combined with gesture triggers for multimodal engagement.

### AIStage Detections (Planned)

On-device `AIStage` (Option 1) can publish detection events to the server:

- Person count change (person entered / left frame)
- Text detected (sign, document)
- Motion anomaly (fall detection)

These become additional trigger sources for the server-side AI worker, following the same `ControlEventBus` pattern.

### App Activation Events

The `AppRegistry` system ties triggers to app definitions:

```json
{
  "id": "spanish-co-pilot",
  "binding": "s2s-gemini-live",
  "systemPrompt": "You are a friendly Spanish language coach...",
  "config": {
    "model": "gemini-3.1-flash-live-preview",
    "voice": "Kore",
    "visionFps": 1,
    "gestures": ["thumbs_up", "thumbs_down", "open_palm", "pointing"]
  }
}
```

When an app is activated:
1. `activate_app` event fires on `ControlEventBus`
2. AI worker loads the app's `systemPrompt` and `config`
3. Worker subscribes to frames at `config.visionFps` rate
4. Worker listens for `config.gestures` via `ControlEventBus`
5. Worker sends guidance audio via `/session/<id>/audio-in` using `config.voice`

### Frame Sampling (Baseline, Throttled)

Even without a trigger, the AI worker can receive frames at a throttled baseline rate:

- Rate controlled by `visionFps` in app config (currently 1fps for spanish-co-pilot)
- Server's relay `should_relay()` already handles per-viewer throttling
- AI worker connects via `/analyze` WebSocket with its own relay config

---

## Likely Architecture for CaringMind

Given CaringMind is assistive/monitoring, the practical split is event-driven:

```
iOS Device                                    Server
========                                      ======

AIStage (lightweight, 4fps)                   ControlEventBus
  - person detection (Vision)                   - gesture triggers from publisher
  - fall/motion anomaly                         - app activation events
  - face proximity alert                        - AIStage detection events (future)
       |                                             |
       v                                             v
  RelayStage -- FRLY/FRAU --> server.ts --> AppRegistry
                                |               |
                                |               +-- resolve app config
                                |               +-- load systemPrompt, model, gestures
                                |
                                +---> viewers (/view)
                                +---> audio taps (/tap/audio)
                                +---> AI worker (/analyze, event-driven)
                                          |
                                          v
                                     AI Worker Service
                                       - subscribes ControlEventBus (gesture triggers)
                                       - subscribes AudioTapBus (voice triggers)
                                       - receives frames at visionFps when app active
                                       - runs VLM with app systemPrompt
                                       - sends guidance audio via /session/<id>/audio-in
                                                 |
                                                 v
                                       /session/<id>/audio-in
                                           POST FRAU binary
                                                 |
                                                 v
                                     Publisher WebSocket receives FRAU
                                                 |
                                                 v
                                     RelayStage receive loop
                                       detects FRAU magic bytes
                                                 |
                                                 v
                                     AudioPlaybackStage
                                       FRAU -> AVAudioEngine
                                       plays through glasses speaker
```

- **On-device:** Fast, privacy-safe alerts (person entered room, fall detected) published as `ControlEvent` to server
- **Server-side:** Event-driven heavy understanding (describe scene on gesture, read text, transcribe conversation)
- **Guidance output:** AI audio sent back through `/audio-in` -> publisher WebSocket -> `AudioPlaybackStage`
- **Shared transport:** Same FRLY/FRAU wire protocols throughout

### Key Difference from GlassFlow

GlassFlow's LiveKit agent model watches every frame continuously -- an "always-on" agent. This architecture is **trigger-driven**:

1. **Worker-initiated:** Gesture on `ControlEventBus` (thumbs_up, pointing) triggers VLM inference
2. **Audio-initiated:** Voice command or conversation context on `AudioTapBus` triggers transcription + response
3. **Detection-initiated:** On-device `AIStage` detects person count change, publishes event, server AI engages
4. **Baseline:** Throttled frame sampling at `visionFps` when an app is active

This reduces GPU costs, bandwidth, and latency compared to "watch everything" approaches.

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

### Event-Driven Architecture

The AI worker subscribes to multiple event sources and activates inference only when triggered:

```ts
// AI Worker process
const controlBus = new ControlEventBus();
const audioBus = new AudioTapBus();

// Subscribe to gesture triggers
controlBus.onEvent((event) => {
  if (event.type === "gesture" && event.gesture === "pointing") {
    // Request current frame, run VLM with app systemPrompt
    triggerVLMInference(event);
  }
  if (event.type === "activate_app") {
    // Load app config, start frame subscription at visionFps
    activateApp(event.appId);
  }
});

// Subscribe to audio for voice triggers
const { stream } = audioBus.subscribe();
for await (const frame of stream) {
  // Buffer, run Whisper, detect voice commands
  processAudioFrame(frame);
}
```

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
+------------------+                   +------------------+
|  Bun Relay       |  ControlEventBus  |  AI Worker       |
|  server.ts       | ----------------> |  (Python/Node)   |
|                  |  AudioTapBus      |                  |
|  Fan out frames  | ----------------> |  Subscribe events|
|  to analyzers    |  FRLY binary      |  Trigger VLM     |
|  alongside       | ----------------> |  Run Whisper     |
|  viewers         |                   |  Send audio back |
+------------------+                   +------------------+
       ^                                        |
       |  POST /session/<id>/audio-in           |
       +----------------------------------------+
              FRAU guidance audio
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

AI inference results get back to the iOS app through the audio-in path:

| Channel | Direction | Use Case |
|---------|-----------|----------|
| `/session/<id>/audio-in` (POST) | Worker -> Server -> iOS | Guidance audio (TTS, FRAU codecType 3) |
| WebSocket message back to relay | Worker -> Server -> Viewer | Scene description overlay in browser |
| `ControlEventBus.publish()` | Worker -> Server | AI detection events (scene change, text found) |
| Database/storage | Worker -> DB | Historical analysis, compliance |

---

## Audio AI: Whisper Transcription

The `AudioTapBus` already parses FRAU audio frames and the `/tap/audio?session=<id>` WebSocket streams them to connected taps. A server-side Whisper worker can:

1. Subscribe to `AudioTapBus` via AsyncIterable
2. Buffer chunks into 5-30 second segments
3. Run Whisper (or faster-whisper) for transcription
4. Return text results via WebSocket message or callback
5. Send spoken guidance back via `/session/<id>/audio-in`

The FRAU wire format already includes timestamps in the same epoch as FRLY video frames, enabling audio/video synchronization for multimodal AI (e.g., "describe what the person is doing while saying X").

### Audio Playback on iOS

The return path is built:

1. AI worker POSTs FRAU audio to `/session/<id>/audio-in`
2. Server pushes to publisher's WebSocket
3. `RelayStage` receive loop detects FRAU magic bytes from server
4. Dispatches to `onReceivedAudio` callback
5. `AudioPlaybackStage` decodes FRAU and plays through `AVAudioEngine`

Viewer push-to-talk is also built: browser captures mic -> FRAU codecType 3 -> relay -> publisher.

---

## Implementation Priority

### What's Already Built

- `ControlEventBus` (server) -- pub/sub for gesture/control events
- `AudioTapBus` (server) -- pub/sub for parsed audio frames
- `/tap/audio?session=<id>` -- WebSocket endpoint streaming FRAU binary to taps
- `AppRegistry` + `config/apps.json` -- app/primitive binding with systemPrompt and config
- `/session/<id>/audio-in` -- POST endpoint for pushing FRAU audio to publisher
- `/apps` -- GET endpoint listing available apps
- `AudioPlaybackStage` (iOS) -- receives FRAU from server, plays through AVAudioEngine
- `AudioTapClient` (iOS) -- connects to /tap/audio WebSocket, publishes to AudioEventBus
- Bidirectional audio: relay <-> iOS through FRAU codecType 3
- Viewer push-to-talk: browser -> relay -> publisher

### Phased Build

1. **Phase 0: Wire existing buses to AI worker** -- Connect a worker process to `ControlEventBus` and `AudioTapBus`, implement `/analyze` WebSocket for frame delivery, send guidance audio through `/session/<id>/audio-in`. No new infrastructure needed.
2. **Phase 1: On-device `AIStage`** -- Vision framework person/face detection (zero server changes, publishes detection events to `ControlEventBus` via relay)
3. **Phase 2: App-driven engagement** -- Use `AppRegistry` to drive systemPrompt, model selection, gesture bindings per app. AI worker loads app config on `activate_app` event.
4. **Phase 3: Audio transcription via Whisper** -- Subscribe `AudioTapBus`, run Whisper, detect voice commands, use as trigger source alongside gestures
5. **Phase 4: Multimodal (vision + audio) context analysis** -- Combine gesture triggers, audio transcription, and frame analysis for contextual understanding

Each phase builds on the previous. The `FramePipelineStage` protocol, relay fan-out design, `ControlEventBus`, `AudioTapBus`, and `AppRegistry` require zero refactoring to support any of these.

---

## Staleness Warning

This document was updated 2026-04-15 against branch `feat/stream-registry` at commit `24f4821`. The following components have been built since the original version (commit `33ea802` on `feat/telemetry-diagnostics`):

- `ControlEventBus`, `AudioTapBus` (server event buses)
- `AppRegistry` + `config/apps.json` (app/primitive binding)
- `/tap/audio`, `/session/<id>/audio-in`, `/apps` endpoints
- `AudioPlaybackStage`, `AudioTapClient` (iOS audio pipeline)
- Bidirectional audio (FRAU codecType 3)

The pipeline architecture, wire protocols, and stage interfaces will change as:

- Multi-session routing evolves (see `docs/multi-session-platform.md`)
- Auth is introduced (see `docs/auth-google-oauth.md`)
- New stages or wire protocol changes are made (see `docs/pipeline-architecture.md`)
- AI worker `/analyze` endpoint is implemented
- On-device `AIStage` detection events are wired to `ControlEventBus`

Before implementing AI integration, re-read the affected files and update this document.
