# 3rd Annual National Security Hackathon -- Project Plan

**Event:** [Cerebral Valley NatSec Hackathon](https://cerebralvalley.ai/e/3rd-annual-natsec-hackathon)
**Project:** Visual Accounting via Wearable Sensor Platform
**Date:** 2026-04-30

---

## Table of Contents

1. [Problem Statement Analysis](#1-problem-statement-analysis)
2. [Codebase Review](#2-codebase-review)
3. [Visual Accounting -- Core Concept](#3-visual-accounting----core-concept)
4. [Technical Architecture](#4-technical-architecture)
5. [Component Breakdown](#5-component-breakdown)
6. [Build vs Existing Matrix](#6-build-vs-existing-matrix)
7. [Hackathon Pitch](#7-hackathon-pitch)
8. [Risks and Mitigations](#8-risks-and-mitigations)
9. [Demo Scenario](#9-demo-scenario)

---

## 1. Problem Statement Analysis

### PS1: Sensor Analysis and Integration -- FIT: STRONGEST

We already fuse EO (camera) + audio (mic + SoundAnalysis) + location (CoreLocation) into a single actionable picture. The architecture is purpose-built for multi-modal sensor correlation.

| Hackathon Ask | What We Have | Gap |
|--------------|-------------|-----|
| Fuse detections across modalities | VisionStage + AudioClassificationStage + LocationStage + SpeechRecognitionStage all feed into server pipeline | Need a **correlation engine** that links detections across modalities (e.g., "face detected at X,Y + gunshot sound at T + GPS location Z = correlated event") |
| Optimize sensor search strategies | Pipeline is config-driven -- server dynamically activates/deactivates sensors via WS messages | Need a **sensor manager** that auto-adjusts which sensors are active based on mission phase |
| Maintain custody of targets | Confidence smoothing with EMA + spatial tracking (bbox proximity matching) | Need **track persistence** -- maintain target identity across frames/sensors with a track ID |
| Refine confidence iteratively | DetectionThrottle (2s dedup) + ConfidenceSmoother (EMA per key) already exist | Extend to **multi-hypothesis tracking** with probabilistic fusion |

**Best example project fit:** B -- "automatically fuse multiple detection messages from different sensors into a single correlated event, iteratively refining confidence, estimated time, and location as new data arrives"

### PS2: Edge Deployments and Drone Operation -- FIT: MODERATE

The wearable IS the edge device. We lack drone/swarm but the edge inference story is strong.

| Hackathon Ask | What We Have | Gap |
|--------------|-------------|-----|
| Lightweight edge computing | All inference runs on Neural Engine (zero cloud dependency for vision/audio/speech) | Strong fit -- iPhone + glasses IS a battery-powered edge kit |
| Onboard inference | Face, body pose, OCR, barcode, scene, sound, speech -- all on-device | Already exists |
| Portable, austere environments | iPhone + Ray-Bans = dismounted operator kit | Strong fit |
| Single operator tasking | Workflow engine lets one operator configure processing via web UI | Could extend to multi-device coordination |
| No cloud reliance | Core pipeline works without server | Server-dependent for relay and AI orchestration |
| Drone C2 / swarm | Not built | Major gap for this problem statement |

**Best angle:** "Dismounted operator edge sensor kit" -- iPhone + glasses running all inference locally, with intermittent connectivity back to a command post.

### PS3: Mission Command and Control -- FIT: STRONG

Our web platform is already a proto-command dashboard.

| Hackathon Ask | What We Have | Gap |
|--------------|-------------|-----|
| Unified operational picture | Live viewer with video + bounding boxes + AI guidance + sensor data + session metadata | Need map layer with GPS overlay |
| Multiple data sources integrated | Camera, mic, GPS, vision detections, audio events, speech text all in one stream | Already federated |
| Natural language querying | Gemini Live provides real-time voice interaction with the AI about what it sees | Strong fit |
| Entity linking / knowledge graph | Vision detections include thumbnails, coordinates, confidence | Need entity persistence and graph construction |
| Emerging patterns/threats | Scene classification + sound classification + speech = pattern detection | Need anomaly scoring and alerting |
| Accelerate kill chain | Workflow DAG automates: detect -> classify -> alert -> respond | Need formal kill chain stages |

**Best example project fit:** "battlefield command dashboard that integrates live feeds from multiple data sources into a unified operational picture with intuitive visualization and natural language querying"

---

## 2. Codebase Review

### What We've Built

A real-time multi-modal wearable sensor platform (branded "CaringMind") built on Meta Wearables DAT SDK. The system streams live video from Ray-Ban Meta smart glasses to an iOS app, which runs on-device inference and relays everything to a server for AI orchestration and web dashboard display.

### Layer: Edge (iOS + Neural Engine)

| Capability | Framework | Hardware | Rate/Quality |
|-----------|-----------|----------|-------------|
| Glasses camera video | DAT SDK MWDATCamera | -- | Up to 720x1280 @ 30fps |
| Phone camera video | AVFoundation | -- | Native resolution |
| Face detection | VNDetectFaceRectanglesRequest | Neural Engine | Configurable FPS |
| Body pose | VNDetectHumanBodyPoseRequest | Neural Engine | Joint coordinates |
| Person detection | VNDetectHumanRectanglesRequest | Neural Engine | -- |
| OCR / text recognition | VNRecognizeTextRequest | Neural Engine | Multi-language |
| Barcode scanning | VNDetectBarcodesRequest | Neural Engine | QR, EAN13, Code128, DataMatrix, PDF417, Aztec |
| Scene classification | VNClassifyImageRequest | Neural Engine | Top-N labels |
| Sound classification | SNClassifySoundRequest (SoundAnalysis) | Neural Engine | Windowed, Apple trained model |
| Speech-to-text | SFSpeechRecognizer | Neural Engine | On-device (iOS 17+) |
| Frame enhancement | CIFilter chain (CoreImage) | GPU | Brightness, sharpen, night mode, noise reduce, edge detect, white balance |
| GPS / geofence | CoreLocation | Location coprocessor | 4 modes: continuous, significant, visits, geofence |
| Phone mic | AVAudioEngine | -- | 48kHz PCM 16-bit mono |
| Glasses mic | HFP Bluetooth | -- | 8kHz mono (upsampled to 16kHz) |

All on-device ML uses Apple built-in frameworks. Zero custom CoreML models currently.

### Layer: Transport

Three custom binary wire protocols between iOS and relay server:

| Protocol | Purpose | Header | Payload |
|----------|---------|--------|---------|
| **FRLY** | Video | 36 bytes: magic, version, payloadLen, sequence, width, height, codec+flags, timestamp, CRC-16 | JPEG or H.264 |
| **FRAU** | Audio | 36 bytes: magic, version, payloadLen, codec/source byte, sequence, sampleRate, channels, bps, timestamp, CRC-16 | PCM or Opus |
| **FRSE** | Sensor | 36 bytes: magic, version, payloadLen, sensor flags (15 groups), sequence, timestamp, CRC-16 | JSON |

Key transport features:
- CRC-16/CCITT-FALSE integrity checking on all frames
- Adaptive JPEG quality (EMA encode time tracking, quality 0.2-0.8)
- Server backpressure (targetFps throttling)
- Auto-reconnect with exponential backoff (1s to 30s cap)
- 5-second ping keepalive with RTT measurement
- Audio processing chain: noise gate (RMS) -> noise suppression (EMA spectral subtraction) -> gain (-20 to +20 dB) -> optional Opus encoding (16kHz mono 16kbps, ~24x compression)

### Layer: Server

Bun WebSocket relay server (TypeScript, ~3000 lines in server.ts):

| Subsystem | Purpose |
|-----------|---------|
| SessionRegistry | Multi-publisher, multi-viewer session management, state machine (created/standby/active/paused/ended/orphaned/expired) |
| GuidanceOrchestrator | AI guidance routing, per-session activation, dependsOn chains, deferred activations |
| JEPAOrchestrator | JEPA vision model lifecycle (Modal cloud GPU) |
| AppRegistry | Resolves workflow DAGs to executable pipelines |
| SessionRecorder | Records video/audio segments + guidance JSONL to R2/S3 |
| AudioTapBus | Pluggable pub/sub audio dispatch |
| ControlEventBus | Pub/sub for gesture/control events |
| DetectionThrottle | Deduplicates identical AI trigger summaries within 2s window |
| APNs | Silent push for remote device wake |

AI providers (all implement `AIService` interface):
- Gemini Live (bidirectional WS, JPEG + PCM in, PCM + text out)
- Gemma 4 REST API
- Deepgram STT (WebSocket)
- JEPA (Modal serverless GPU)

Database: SQLite via Drizzle ORM, 11 migrations, 16 tables (users, organizations, teams, devices, sessions, workflows, workflow_nodes, workflow_edges, activation_log, etc.)

### Layer: Frontend

Vite SPA with vanilla TypeScript (no React/Vue):

| Page | Purpose |
|------|---------|
| Dashboard (Command Center) | Platform stats, activity feed, AI agent cards |
| Live Streams | Gallery of active sessions with inline video |
| Feeds | All sessions browser with time buckets, inline player |
| Workflows | Full visual DAG editor (SVG-based, palette, config panel, edge validation, flow detection) |
| Gallery | Session recordings with metadata and thumbnails |
| Devices | Fleet management with search, filters |

Live viewer composes:
- RelayPlayer (WebSocket binary frame player, canvas rendering, JMuxer for H.264, AudioWorklet for PCM)
- GuidancePanel (tabbed per workflow/app, model config, AI events, bounding box overlay controls)
- MiniWorkflowEditor (inline workflow editing during live sessions)
- MessageHandler (dispatches 20+ JSON message types from server)

### Layer: Key Patterns

1. **Actor-based pipeline**: Every iOS stage is a Swift actor. `FramePipelineManager` dispatches frames via `Task.detached` fan-out. Thread-safe without locks.

2. **Pre-broadcast transform vs observer**: Enhance filters run synchronously on `@MainActor` BEFORE fan-out. Observer stages run in parallel and cannot modify frames.

3. **Fresh CVPixelBuffer per frame**: GPU rendering always allocates new buffers to prevent read-write races between main actor and async stage actors.

4. **Config-driven dispatch**: Server sends typed config messages (`vision_stage_config`, `enhance_stage_config`, `sensor_stage_config`, `speech_stage_config`) via WebSocket. iOS creates/reconfigures stages dynamically.

5. **Confidence smoothing**: Exponential Moving Average (EMA) per detection key prevents flickering. Spatial matching for face/person/bodyPose (bbox proximity), label matching for scene/barcode/OCR (content string).

6. **Detection throttling**: Deduplicates identical AI trigger summaries within 2-second window.

7. **Categorized parallel activation**: Vision nodes fire-and-forget, enhance/sensor/speech collected into single config messages, AI nodes via `Promise.allSettled`.

### Deployment Architecture

```
[Caddy reverse proxy, TLS] --> relay.simulationapi.com
    |
    +--> localhost:3000 (Gateway - Bun HTTP)
    |       - Serves web-platform SPA from dist/
    |       - Google OAuth authentication
    |       - Proxies API/WebSocket to relay
    |
    +--> localhost:8080 (Relay Server - Bun WebSocket)
            - Frame relay (publisher -> viewer fan-out)
            - AI service orchestration
            - Session management + recording
            - SQLite + R2 object storage
```

CI/CD:
- `deploy.yml`: Push to `feat/stream-registry` triggers SSH deployment to VPS
- `ios-ci.yml`: macOS 15 runner, Xcode 16.3, iPhone 16 Pro simulator, TestFlight upload

---

## 3. Visual Accounting -- Core Concept

**Visual Accounting** uses the live camera feed from smart glasses to automatically detect, track, and count/account for physical objects (playing cards, poker chips, paper money, other small items) in real time.

### Problem

Instead of manually counting or relying on someone telling you what's happening, the glasses camera watches the scene (a table, hands dealing cards, stacking chips, counting cash) and the platform:

1. **Detects** individual items (specific card ranks/suits, chip colors/values, bill denominations)
2. **Assigns persistent unique IDs** to each item even as hands move them around, occlude them, or shuffle them
3. **Tracks** their movement and position over time
4. **Maintains a running total / inventory / accounting** (e.g., "$245 in the pot", "Player 2 has 3 Aces and 2 Kings", "$1,200 moved from stack A to stack B")

This is especially powerful for scenarios involving fast movement and frequent partial occlusions (hands covering cards/chips).

### Technology Stack

- **Detector**: Lightweight model (YOLO11n or RF-DETR Nano) running on-device via CoreML on iOS. Provides bounding boxes for each card/chip/bill.
- **Tracker**: OC-SORT (or BoT-SORT) on top of the detector.
  - These are NOT big neural networks -- they are classical algorithms (Kalman filters + association logic).
  - Extremely lightweight -- runs at hundreds of FPS on iPhone CPU with almost zero overhead.
  - OC-SORT's key strength (Observation-Centric Re-Update) handles the exact problems you get with cards/money: hands briefly hiding items, fast erratic movements, similar-looking objects (identical red chips).
- **On Edge**: Detector on Neural Engine + tracker on CPU -- fully runnable on the iPhone paired with Meta glasses, with very low battery/heat impact.

This gives stable, persistent tracking even when items disappear and reappear, which basic detection alone cannot do well.

### Military Translation

The same technology stack solves all three hackathon problem statements:

| Visual Accounting Concept | Military Equivalent |
|--------------------------|-------------------|
| Detect individual cards/chips | Detect individual vehicles, personnel, equipment |
| Assign persistent IDs through occlusion | Maintain target custody through sensor gaps (PS1) |
| Track movement over time | Track movement patterns, predict future positions |
| Running total / inventory | Force accounting, equipment inventories, resource tracking |
| Hands occluding items | Camouflage, terrain masking, EW jamming (PS1) |
| Similar-looking red chips | Similar-looking vehicles, uniformed personnel |
| Real-time dashboard | Command and control display (PS3) |
| All on iPhone + glasses | Edge deployment from austere environments (PS2) |
| No cloud needed | Disconnected, intermittent, limited bandwidth (DIL) |

---

## 4. Technical Architecture

### Pipeline Integration

```
Glasses Camera (DAT SDK)
  -> FramePipelineManager (@MainActor)
     -> [existing] applyTransform() -- night mode, sharpen for low-light tables
     -> Fan-out via Task.detached:
        |-- DisplayStage          (preview)
        |-- RelayStage            (stream to server)
        |-- [NEW] ObjectTrackingStage  <-- core addition
        |     |-- CoreML YOLO11n  (Neural Engine, ~10ms)
        |     |-- OC-SORT Tracker (CPU, ~0.5ms)
        |     |-- ItemRegistry    (stateful accounting)
        |-- [existing] VisionStage (faces, OCR -- can complement)
```

### ObjectTrackingStage Processing Flow

```
FramePacket arrives
  -> Resize CVPixelBuffer to 640x640
  -> CoreML prediction (YOLO11n -> [x,y,w,h, class, conf] per detection)
  -> OC-SORT update:
      - Hungarian matching (IoU cost matrix between detections and existing tracks)
      - Kalman predict for unmatched tracks (items temporarily occluded)
      - Create new tracks for unmatched detections
      - Re-update on rediscovery (OC-SORT key feature: re-initializes Kalman filter)
  -> ItemRegistry update:
      - Classify new items (card rank/suit, chip value, bill denomination)
      - Assign persistent ID
      - Track position history
      - Update running totals
  -> Output: tracked_objects JSON -> server -> dashboard
```

### Full Stack Data Flow

```
[Existing]                                [New]

Glasses Camera ---|                       CorrelationEngine (Swift actor)
Phone Mic ---------|-- iOS Pipeline ---->  |- Track Store (per-target state)
Glasses Mic -------|       |               |- Event Fusion (multi-sensor correlation)
GPS Location ------|       |               |- Threat Scoring (anomaly detection)
                           v
                    Server Relay
                        |
                        v
                   Web Dashboard
                    |- Map view (GPS + detections)       [new]
                    |- Track timeline                     [new]
                    |- Correlated event feed              [new]
                    |- Running totals / inventory panel   [new]
                    |- Natural language query             [exists via Gemini]
```

---

## 5. Component Breakdown

### 5.1 OC-SORT Tracker in Swift (~400 lines, no external dependency)

| Component | What | Cost |
|-----------|------|------|
| Kalman Filter | 8-state `[x, y, w, h, vx, vy, vw, vh]`, linear predict + update | ~0.01ms per track |
| Hungarian Algorithm | Detection-to-track association via IoU cost matrix | ~0.1ms for 50 tracks |
| Track Lifecycle | `tentative -> confirmed -> lost -> deleted` state machine | Negligible |
| OC-SORT Re-Update | Re-initializes Kalman on rediscovery after occlusion | Fixes hand-covering-card problem |
| Confidence Gating | Only associate above minimum IoU threshold | Prevents ID swaps on identical items |

**Total tracker cost: under 1ms on iPhone CPU for 50+ tracked objects.**

#### Kalman Filter Details

State vector (8 dimensions):
```
[x, y, w, h, vx, vy, vw, vh]
 x, y   = bounding box center
 w, h   = bounding box width, height
 vx, vy = velocity of center
 vw, vh = velocity of dimensions
```

Two operations per frame:
1. **Predict**: Project state forward using constant-velocity model. Used when item is occluded.
2. **Update**: Correct state with new detection measurement. Adjusts Kalman gain based on prediction vs observation discrepancy.

OC-SORT innovation: When a track is rediscovered after occlusion (lost -> found), it performs an "observation-centric re-update" -- adjusting the Kalman filter state to account for the gap, rather than just resuming from the stale prediction.

#### Hungarian Algorithm

Solves the assignment problem: which detection belongs to which existing track?

1. Build cost matrix: IoU between each detection bbox and each predicted track bbox
2. Solve for minimum-cost assignment (Hungarian method)
3. Gated: reject assignments below minimum IoU threshold (default 0.3)
4. Unmatched detections -> new tentative tracks
5. Unmatched tracks -> mark as lost, continue predicting

### 5.2 Detection Model Options

| Model | Params | Latency (NE) | Export | Best For |
|-------|--------|-------------|--------|----------|
| YOLO11n | 3.2M | ~8ms | coremltools | Fast, good enough for cards/chips |
| RF-DETR Nano | ~3M | ~10ms | coremltools | Better small object detection (chips) |
| YOLO11s | 9.4M | ~15ms | coremltools | Higher accuracy if needed |

All run on Neural Engine. The tracker on CPU. Zero contention with existing VisionStage.

#### Model Training Plan

**Option A: COCO pre-trained (fastest to demo)**
- YOLO11n trained on COCO (80 classes including "bottle", "cup", "book", "cell phone")
- Demo with COCO objects on a table
- Zero training time needed
- Good for proving the tracking pipeline works

**Option B: Playing card dataset (medium effort)**
- Fine-tune YOLO11n on [playing card detection dataset](https://universe.roboflow.com/) (Roboflow has several)
- Classes: 52 card types (rank + suit), chip colors (white, red, blue, green, black), bill denominations
- Training: ~1 hour on free Colab T4
- Best for visual impact in demo

**Option C: Custom dataset (highest quality)**
- Capture frames from glasses camera in demo setup
- Label with Roboflow or Label Studio
- Train YOLO11n on custom data
- Handles lighting/angle specific to glasses perspective

### 5.3 ItemRegistry (~200 lines)

Maintains state for all tracked items:

```swift
struct TrackedItem: Sendable {
    let trackId: Int           // OC-SORT assigned ID
    let classId: Int           // YOLO class (card, chip, bill)
    let classLabel: String     // "ace_spades", "red_chip", "$20_bill"
    var value: Double          // Monetary or point value
    var positionHistory: [CGPoint]  // Last N positions
    var lastSeen: Date
    var status: ItemStatus     // active, occluded, removed
    var zone: String?          // "pot", "player1_stack", "dealer"
}

struct AccountingState: Sendable {
    var items: [Int: TrackedItem]  // trackId -> item
    var zoneTotals: [String: Double]  // "pot" -> 245.0
    var movements: [Movement]     // Transfer events
    var totalCount: Int
    var totalValue: Double
}
```

Zone detection: Divide frame into named regions (pot center, player positions). Items assigned to zones based on bbox center. Movement detected when item transitions between zones.

### 5.4 Server Integration

New node type in `node-definitions.ts`:

```typescript
{
  type: "object-tracker",
  label: "Object Tracker",
  subtitle: "YOLO + OC-SORT tracking",
  color: "#E91E63",
  activationMode: "tracking",
  configSchema: [
    { key: "targetClasses", type: "multiselect", options: ["card", "chip", "bill", "person", "vehicle"] },
    { key: "confidenceThreshold", type: "slider", min: 0.1, max: 0.99, default: 0.5 },
    { key: "maxTracks", type: "number", default: 50 },
    { key: "iouThreshold", type: "slider", min: 0.1, max: 0.9, default: 0.3 },
    { key: "trackTimeout", type: "number", default: 30 },  // seconds before lost track deleted
    { key: "enableAccounting", type: "boolean", default: true }
  ]
}
```

New WS message type: `tracking_result`

```typescript
{
  type: "tracking_result",
  sessionId: string,
  timestamp: number,
  tracks: Array<{
    trackId: number,
    classLabel: string,
    confidence: number,
    bbox: [number, number, number, number],  // [x, y, w, h] normalized
    value: number | null,
    zone: string | null,
    state: "active" | "occluded" | "lost"
  }>,
  accounting: {
    zoneTotals: Record<string, number>,
    totalValue: number,
    recentMovements: Array<{ from: string, to: string, value: number }>
  }
}
```

---

## 6. Build vs Existing Matrix

| Component | Status | Effort | Notes |
|-----------|--------|--------|-------|
| Frame pipeline + fan-out | **Done** | 0 | FramePipelineManager, Task.detached |
| Binary wire protocol to server | **Done** (FRLY/FRAU/FRSE) | 0 | CRC-16, adaptive quality |
| Server relay to web dashboard | **Done** | 0 | Multi-viewer fan-out |
| Web dashboard with live video | **Done** | 0 | RelayPlayer, JMuxer, canvas |
| Workflow engine (activate/deactivate) | **Done** | 0 | Visual DAG editor, server dispatch |
| Server-driven config dispatch | **Done** | 0 | Typed WS config messages |
| Confidence smoothing (EMA) | **Done** | 0 | ConfidenceSmoother.swift |
| Detection throttling | **Done** | 0 | DetectionThrottle (2s window) |
| AI orchestration (Gemini Live) | **Done** | 0 | Bidirectional WS, voice interaction |
| **ObjectTrackingStage actor** | **New** | Core | ~300 lines Swift actor |
| **CoreML detection model** | **New** | Core | Train/export YOLO11n or use COCO pre-trained |
| **OC-SORT Swift implementation** | **New** | Core | ~400 lines (Kalman + Hungarian + lifecycle) |
| **ItemRegistry (state + accounting)** | **New** | Medium | ~200 lines |
| **Dashboard tracking overlay** | **New** | Medium | Extend existing BoundingBoxOverlayView |
| **Node definition (server + frontend)** | **New** | Low | ~100 lines each |
| **tracking_result WS message type** | **New** | Low | ~50 lines server handler |

**~70% of the infrastructure already exists.** We are adding the detection model, tracker logic, and a new pipeline stage.

---

## 7. Hackathon Pitch

### Judging Criteria Alignment

| Criterion (Weight) | Our Score | Justification |
|-------------------|-----------|---------------|
| Technical Demo (35%) | High | Live demo: glasses stream video, YOLO detects items, OC-SORT tracks through occlusion, dashboard shows live accounting. Real hardware, real pipeline. |
| Military Impact (30%) | High | Direct analog to multi-INT fusion for dismounted operations. Same math tracks vehicles through sensor gaps as cards through hand occlusion. |
| Solution Creativity (25%) | High | Wearable-based multi-modal tracking is novel. Most solutions use fixed sensors or drones. Edge-first, actor-based pipeline, custom binary protocols. |
| Presentation (10%) | Medium-High | Live demo with real hardware (glasses + iPhone) is compelling. Dashboard showing real-time tracking makes it tangible. |

### Pitch Script (3 minutes)

**Hook (30s):** "Imagine a dismounted operator in an austere environment. They have no satellite, no drone, no fixed sensor. What they have is what they're wearing. We built a platform that turns wearable devices into a real-time multi-modal sensor fusion system."

**Problem (30s):** "The challenge: maintaining custody of targets when sensors are limited, connections are intermittent, and objects disappear behind terrain, camouflage, or adversary countermeasures. Traditional approaches need fixed infrastructure. We don't."

**Solution (60s):** "Our system runs entirely on-edge. Smart glasses stream video to an iPhone. On-device AI detects objects using the Neural Engine. A Kalman-filter-based tracker maintains persistent IDs even through full occlusion. The tracker costs under 1ms of CPU time. The detection model runs at 100+ FPS. Zero cloud dependency for the core loop. When connectivity is available, data relays to a command dashboard with live tracking, running totals, and natural language querying."

**Demo (60s):** Live demo: spread of cards/chips on table. Glasses detect each item, assign IDs. Hands shuffle -- items disappear and reappear with same IDs. Dashboard updates in real-time with counts and values.

### Problem Statement Mapping

The project addresses all three problem statements from a single codebase:

**PS1 -- Sensor Analysis and Integration:** Multi-modal detection (vision + audio + location) fused into correlated events with persistent tracking through occlusion. The OC-SORT tracker maintaining custody through hand-occlusion is mathematically identical to tracking vehicles through sensor gaps.

**PS2 -- Edge Deployments:** Neural Engine detection + CPU tracker on battery-powered iPhone. Zero cloud dependency for the core detection-tracking-accounting loop. The wearable IS the edge sensor kit.

**PS3 -- Mission Command and Control:** Real-time dashboard showing tracked items with IDs, positions, running totals, movement history. Natural language querying via Gemini Live. Workflow engine automates the detect-classify-alert-respond chain.

---

## 8. Risks and Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|-----------|
| No trained model for cards/chips | Demo uses generic objects | Medium | Start with COCO-trained YOLO11n (detects "bottle", "cup", "book"). Demo with those. Fine-tune on poker dataset if time allows. |
| OC-SORT implementation bugs | Tracks lose IDs | Medium | Algorithm is well-documented (~400 lines). Test with recorded video before live demo. Have fallback to simpler IoU tracker. |
| Similar-looking items (identical chips) | ID swaps | Medium | OC-SORT uses IoU + Kalman prediction, not appearance. Items in different positions track correctly. Stack splitting needs velocity-based heuristics. |
| CoreML model integration issues | Can't run on Neural Engine | Low | `coremltools` export from PyTorch is standard. Test model export before hackathon. CPU fallback is fast enough. |
| Glasses connectivity drops during demo | No video | Low | Have recorded video fallback. Phone camera can also feed the pipeline via PhoneCameraCapture stage. |
| Latency budget exceeded | Janky tracking | Low | Total budget: ~8ms detection + ~1ms tracker = ~9ms per frame. At 30fps we have 33ms budget. Plenty of headroom. |

### Fallback Demo Plan

If live glasses demo fails:
1. Switch to phone camera as source (PhoneCameraCapture already exists)
2. Use pre-recorded video of card game
3. Show recorded tracking session playback from gallery

---

## 9. Demo Scenario

### Setup

- Table with playing cards spread face-up, poker chips in stacks, paper bills
- Operator wears Ray-Ban Meta glasses, paired to iPhone
- iPhone runs CameraAccess app with ObjectTrackingStage active
- Laptop shows web dashboard at relay.simulationapi.com

### Demo Flow (5 minutes)

1. **Detection**: Point glasses at table. Dashboard shows each card/chip/bill detected with bounding box and class label.

2. **Tracking**: Slide cards around the table. Dashboard shows each item maintaining its ID despite movement.

3. **Occlusion**: Cover cards with hands, then reveal. Same IDs persist through occlusion. This is the OC-SORT re-update feature.

4. **Accounting**: Dashboard shows running total. Move chips from one stack to another. Dashboard shows "$200 moved from Stack A to Stack B."

5. **Natural Language Query**: Ask Gemini Live "How many aces are on the table?" or "What's the total value in the pot?" System responds with accurate count from tracked state.

6. **Edge Independence**: Disconnect from network. Detection and tracking continue on-device. Reconnect -- dashboard syncs.

### Key Files Reference

**iOS Pipeline:**
- `publishers/CameraAccess/CameraAccess/Pipeline/FramePipelineManager.swift` -- Central orchestrator
- `publishers/CameraAccess/CameraAccess/Pipeline/FramePipelineTypes.swift` -- Stage protocol, FramePacket
- `publishers/CameraAccess/CameraAccess/Pipeline/VisionTypes.swift` -- Detection result types
- `publishers/CameraAccess/CameraAccess/Pipeline/Stages/VisionStage.swift` -- Existing vision processing
- `publishers/CameraAccess/CameraAccess/Pipeline/Stages/RelayStage.swift` -- WebSocket to server
- `publishers/CameraAccess/CameraAccess/Pipeline/ConfidenceSmoother.swift` -- EMA smoothing
- `publishers/CameraAccess/CameraAccess/ViewModels/StreamSessionViewModel.swift` -- Config dispatch

**Server:**
- `hosted/server/src/server.ts` -- Main relay server
- `hosted/server/src/node-definitions.ts` -- Workflow node registry
- `hosted/server/src/guidance-orchestrator.ts` -- AI orchestration
- `hosted/server/src/app-registry.ts` -- Workflow resolution

**Web Platform:**
- `hosted/web-platform/src/live/` -- Live viewer
- `hosted/web-platform/src/pages/workflow/` -- Workflow editor
- `hosted/web-platform/src/pages/workflow/node-defs.ts` -- Frontend node definitions

**Wire Protocols:**
- `hosted/packages/relay-protocol/src/video.ts` -- FRLY
- `hosted/packages/relay-protocol/src/audio.ts` -- FRAU
- `hosted/packages/relay-protocol/src/sensor.ts` -- FRSE
- `publishers/CameraAccess/CameraAccess/Pipeline/WireProtocol.swift` -- iOS wire encoding

**Infrastructure:**
- `hosted/infra/` -- Systemd services + Caddyfile
- `.github/workflows/deploy.yml` -- VPS deployment
- `.github/workflows/ios-ci.yml` -- iOS build + TestFlight
