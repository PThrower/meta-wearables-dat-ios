# PRD-001: iOS Streaming Client

**Product:** com.mwdat-ios / CameraAccess
**Owner:** @ebowwa
**Status:** P0 Complete
**Last Updated:** 2026-04-10
**Depends On:** Meta DAT SDK 0.5.x, PRD-002 (Relay Platform)

---

## Problem

Meta's Device Access Toolkit (DAT) SDK provides raw camera streaming from Ray-Ban Meta glasses over Bluetooth LE. The SDK emits `CMSampleBuffer` frames but provides no pipeline for relay, recording, AI processing, or multi-device audio routing. A developer building on DAT must wire all of this from scratch.

CaringMind needs a production-grade iOS streaming client that:
- Connects to Meta glasses via DAT SDK
- Routes frames through a composable pipeline (display, relay, record, AI)
- Streams audio from phone mic and/or glasses mic to the relay
- Handles session lifecycle (pause/resume/reconnect) without data loss
- Provides real-time telemetry for debugging and quality monitoring

---

## Users

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| **Operator** | Person wearing glasses, running the iOS app | One-tap stream start, reliable connection, battery efficiency |
| **Developer** | CaringMind team building on this client | Composable pipeline stages, MockDeviceKit testing, telemetry |
| **Viewer** | Remote person watching via browser (see PRD-005) | Low-latency feed with audio |

---

## Current State

The `CameraAccess` sample app extends Meta's reference sample with:

- `FramePipelineManager` dispatching `FramePacket` to registered stages
- `DisplayStage` (UIImage for SwiftUI preview)
- `RelayStage` (JPEG encode + FRLY binary over WebSocket)
- `RecordingStage` (AVAssetWriter passthrough to `.mov`)
- `AudioStage` (mic capture + FRAU binary via RelayStage)
- `AudioPlaybackStage` (TTS to glasses -- disabled, conflicts with relay audio)
- `TelemetryService` + `TelemetryHUDView` (session/frame/error metrics)
- `StreamSessionViewModel` orchestrating pipeline lifecycle
- MockDeviceKit integration for hardware-free development
- Unit tests (`CameraAccessTests`) and UI tests (`CameraAccessUITests`)

### Gaps

1. **No production app target** -- everything lives in the sample app target (P1-6)
2. ~~**AudioPlaybackStage conflicts** with relay audio path~~ -- ACTIVE: AVAudioEngine solution designed, write() async fix shipped, testing in progress (see P1-4 below)
3. **No on-device AI stage** -- pipeline supports it but none registered (see PRD-003)
4. ~~**Single relay URL**~~ -- RESOLVED: `?session=<id>` param added
5. **No background streaming** -- app must be foregrounded (P1-3)
6. **No adaptive quality** -- JPEG quality and resolution are static per session (P1-2)
7. **Recording is local-only** -- server-side recording covers this via PRD-004

---

## Requirements

### P0 -- Must Have (Current Sprint)

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P0-1 | Composable frame pipeline with hot-swap stage registration | Stages can be added/removed without restarting the stream session |
| P0-2 | FRLY video relay over WebSocket with configurable endpoint | Operator can set WSS URL in-app; defaults to `wss://relay.simulationapi.com/publish` |
| P0-3 | FRAU audio relay with phone mic, glasses mic, and all-devices modes | Audio input mode selectable in pre-stream setup; PCM 48kHz mono, 20ms chunks |
| P0-4 | Local `.mov` recording via `RecordingStage` | Toggle in stream view; file saved to app sandbox; accessible via Files.app |
| P0-5 | Session lifecycle: start, pause, resume, stop, auto-retry | 3 retries with exponential backoff (1s, 2s, 4s) on transient failures |
| P0-6 | Telemetry HUD (DEBUG builds) | FPS, jitter, frame count, drops, connection state, errors visible as overlay |
| P0-7 | MockDeviceKit testing without physical glasses | Debug menu: pair mock device, configure video feed, simulate lifecycle states |

### P1 -- Should Have (Next Sprint)

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P1-1 | Session ID routing (`?session=<id>`) for multi-session relay | Client sends session ID on WebSocket connect; compatible with PRD-002 |
| P1-2 | Adaptive JPEG quality based on network conditions | Quality scales between 0.3-0.8 based on WebSocket send backpressure |
| P1-3 | Background streaming (audio continues, video pauses) | App enters background: audio relay continues, video relay suspends, recording pauses |
| P1-4 | Photo capture with relay forwarding | Captured photo sent over WebSocket as a tagged FRLY frame (quality 0.95) |
| P1-5 | Device battery level display | Show glasses battery in pre-stream and stream views |
| P1-6 | Production app target (separate from sample) | Xcode target `CaringMind` with own bundle ID, entitlements, and App Store config; CameraAccess remains as dev reference |
| P1-7 | AudioPlaybackStage via AVAudioEngine (active development) | write() produces PCM, player node routes to glasses speaker, same PCM published to AudioEventBus; codecType 2 enabled; see plan `streamed-dreaming-panda.md` |
| P1-8 | Bidirectional audio: receive FRAU from relay (AudioSinkStage) | New `AudioSinkStage` receives FRAU frames (codecType 3 = relay inbound, codecType 4 = viewer mic) from relay WebSocket, decodes PCM, plays via AVAudioEngine; published to AudioEventBus alongside local audio sources; same content stream as outbound FRAU |
| P1-11 | HFP output routing for inbound audio | AVAudioSession configured with `.playAndRecord` + `.allowBluetooth` routes received PCM (codecType 3/4) through glasses speakers via HFP; viewer voice (codecType 4) and AI/TTS (codecType 3) both play on glasses when connected |
| P1-9 | Telemetry reporting to relay (see PRD-014) | `RelayStage` sends structured telemetry JSON every 5s over WebSocket: FPS, jitter, frame count, drops, encoding latency, TTFF, errors, connection state, sdkVersion |
| P1-10 | `sdkVersion` in publisher hello | `sendHello()` includes `"sdkVersion": "0.5.0"` (DAT SDK version from Package.swift dependency); relay stores on Publisher and exposes in stats/export |

### P2 -- Could Have (Backlog)

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P2-1 | On-device AI stage (Vision framework) | Register `AIStage` at 4fps; person/face detection, text recognition (see PRD-003) |
| P2-2 | Recording upload to S3-compatible bucket | Post-session upload of `.mov` to bucket via presigned URL (see PRD-004 P2-6) |
| P2-3 | Multi-device simultaneous streaming | Two glasses connected, two sessions published concurrently |
| P2-4 | Adaptive resolution downscaling | Switch from `.high` to `.medium` when Bluetooth bandwidth is constrained |

---

## Technical Architecture

```
Meta Glasses (Ray-Ban Meta / Meta Ray-Ban Display)
       | Bluetooth LE (DAT SDK 0.5.x)
       v
iOS App (CameraAccess)
       |
  Wearables.configure() -> StreamSession -> videoFramePublisher
       |
  FramePipelineManager (subscribes to videoFramePublisher)
       |
       +---> DisplayStage       -> UIImage -> SwiftUI preview
       +---> RelayStage         -> JPEG encode -> FRLY binary -> WebSocket
       +---> RecordingStage     -> CMSampleBuffer -> AVAssetWriter -> .mov
       +---> AudioStage         -> AVAudioEngine -> FRAU binary -> RelayStage
       +---> [AIStage]          -> CVPixelBuffer -> Vision/CoreML (P2)
       |
  StreamSessionViewModel (orchestrates lifecycle, config, stage wiring)
       |
  SwiftUI Views (MainAppView -> HomeScreenView -> NonStreamView -> StreamView)
```

### Wire Protocols

**FRLY (Video):** 29-byte header (`magic[4] + seq[8] + width[4] + height[4] + quality[1] + timestamp[8]`) + JPEG payload

**FRAU (Audio):** 29-byte header (`magic[4] + codec[1] + seq[8] + sampleRate[4] + channels[2] + bitsPerSample[2] + timestamp[8]`) + PCM 16-bit LE payload

### Key Files

| File | Purpose |
|------|---------|
| `Pipeline/FramePipelineManager.swift` | Frame dispatcher; subscribes to `videoFramePublisher`, builds `FramePacket`, dispatches to stages |
| `Pipeline/FramePipelineTypes.swift` | `FramePacket`, `FramePipelineStage` protocol, `FrameStageConfig` |
| `Pipeline/Stages/RelayStage.swift` | JPEG encode + FRLY WebSocket; receive loop + 5s ping keepalive |
| `Pipeline/Stages/AudioStage.swift` | Mic capture, FRAU encode, routing modes (phone/glasses/all) |
| `Pipeline/Stages/RecordingStage.swift` | AVAssetWriter passthrough to `.mov` |
| `Pipeline/Stages/DisplayStage.swift` | CMSampleBuffer -> UIImage for SwiftUI |
| `ViewModels/StreamSessionViewModel.swift` | Pipeline orchestration, session config, relay URL, retry logic |
| `Telemetry/TelemetryService.swift` | Session/frame/error metrics collection |

---

## UX Flow

```
1. Onboarding (HomeScreenView)
   -> "Connect my glasses" -> Meta AI app OAuth redirect -> callback
   
2. Pre-Stream Setup (NonStreamView)
   -> Device picker (multi-device list)
   -> Resolution selector (High/Medium/Low)
   -> Frame rate selector (24/30)
   -> Relay URL (editable, defaults to wss://relay.simulationapi.com/publish)
   -> "Start streaming"
   
3. Live Streaming (StreamView)
   -> Full-screen video preview
   -> Bottom controls: Stop | Record (toggle) | Relay (toggle) | Photo
   -> Error banner (tap for error log sheet)
   -> Telemetry HUD overlay (DEBUG builds)
```

---

## Success Metrics

| Metric | Target | Method |
|--------|--------|--------|
| Time to first frame (TTFF) | < 3 seconds from "Start streaming" | TelemetryService |
| Frame relay latency (iOS -> server) | < 200ms p95 | FRLY timestamp comparison |
| Stream uptime | > 99% during active session | TelemetryService error/drop rate |
| Battery drain rate | < 15% per hour of streaming | Instrument profiling |
| Crash-free sessions | > 99.5% | Xcode Organizer / telemetry |

---

## Dependencies

| Dependency | Version | Source |
|------------|---------|--------|
| Meta DAT SDK (`meta-wearables-dat-ios`) | 0.5.0 (exact) | SPM from GitHub |
| MWDATCore | 0.5.0 | DAT SDK |
| MWDATCamera | 0.5.0 | DAT SDK |
| MWDATMockDevice | 0.5.0 | DAT SDK |
| iOS deployment target | 16.0+ | Xcode |
| Xcode | 15.0+ | Apple |

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| DAT SDK is pre-1.0; breaking changes in 0.6.x | High | Pin exact version 0.5.0; vendored xcframeworks as fallback |
| Bluetooth bandwidth limits JPEG quality at high FPS | Medium | Adaptive quality (P1-2); recommend medium resolution |
| AudioPlaybackStage + relay audio coexistence | Medium | AVAudioEngine routing solution in progress (P1-7); codecType 2 reserved until resolved |
| Single-publisher relay rejects reconnect during stale timeout | Low | Server stale timeout is 15s; client retries with backoff |
| Meta AI companion app required for registration | Low | MockDeviceKit for dev; document onboarding flow |
