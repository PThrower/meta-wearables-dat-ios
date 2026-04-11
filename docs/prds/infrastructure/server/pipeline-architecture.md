# Pipeline Architecture

Full pipeline from smart glasses capture through server-side fan-out to browser viewer. Written 2026-04-03 against commit `33ea802` on `feat/telemetry-diagnostics`.

---

## Overview

Two connected but distinct pipeline systems:

1. **iOS Capture Pipeline** -- actor-based fan-out inside the app, dispatching frames from the DAT SDK glasses camera to display, relay, recording, and audio stages
2. **Relay Crate (Rust/WASM)** -- server-side per-viewer FPS throttling compiled to WebAssembly

```
Ray-Ban Meta / Oakley HSTN Glasses
       |
       v  DAT SDK (MWDATCamera)
StreamSession.videoFramePublisher
       |
       v  @MainActor
FramePipelineManager.onVideoFrame()
       |
       |--- Task.detached --> DisplayStage   (UIImage -> UI)
       |--- Task.detached --> RelayStage     (JPEG -> FRLY -> WebSocket)
       |--- Task.detached --> RecordingStage (raw CMSampleBuffer -> .mov)
       |
       v  (separate capture path)
AudioStage (AVAudioEngine mic tap -> FRAU -> RelayStage.sendRawData())
```

---

## iOS Capture Pipeline

Location: `publishers/CameraAccess/CameraAccess/Pipeline/`

### Core Types (`FramePipelineTypes.swift`)

| Type | Role |
|------|------|
| `FramePacket` | Immutable `CMSampleBuffer` + `ContinuousClock.Instant` timestamp + `UInt64` sequence number. `@unchecked Sendable` -- safe to cross actor boundaries. |
| `FrameStageConfig` | Per-stage `targetFPS: UInt` + `isEnabled: Bool`. Defaults to 30fps. `Sendable`. |
| `FramePipelineStage` | Protocol -- `processFrame(_:)`, `start()`, `stop()`. All conformers are Swift **actors**. Requires `AnyObject, Sendable`. |

### Manager (`FramePipelineManager.swift`)

- `@MainActor` class, single subscriber to `StreamSession.videoFramePublisher`
- On each `VideoFrame`: extracts `CMSampleBuffer`, wraps in `FramePacket` with monotonically incrementing sequence number
- **Fire-and-forget dispatch**: `Task.detached` to each registered stage -- never blocks main thread
- Stage registration via `register(_:)` / `unregister(stageId:)`
- Lifecycle: `attachToStreamSession(_:)` / `detachFromStreamSession()` manage the SDK listener token

### ThrottledStage (`ThrottledStage.swift`)

Abstract actor base class providing per-stage FPS throttling.

- Uses `ContinuousClock.Instant` to enforce minimum interval between frames
- Frames arriving faster than `targetFPS` are silently dropped
- Subclasses override `processThrottledFrame(_:)` instead of `processFrame(_:)`
- Default `start()`/`stop()` reset the throttle timestamp

### Stages

#### DisplayStage (`Stages/DisplayStage.swift`)

| Property | Value |
|----------|-------|
| `stageId` | `"display"` |
| Default FPS | max (unthrottled) |
| Thread model | Actor with `@MainActor` callback |

Converts `CMSampleBuffer` -> `CIImage` -> `CGImage` -> `UIImage` using a shared `CIContext` (hardware-accelerated, no software renderer). Calls back to `@MainActor` via closure for UI updates.

#### RelayStage (`Stages/RelayStage.swift`)

| Property | Value |
|----------|-------|
| `stageId` | `"relay"` |
| Default FPS | 15 fps |
| Default JPEG quality | 0.6 |
| Thread model | Actor with `Task.detached` for encoding |

The network output stage. Encodes `CMSampleBuffer` frames as JPEG, wraps in FRLY wire protocol, sends over WebSocket.

**Connection management:**
- `connect(to:)` -- opens `URLSessionWebSocketTask` with 5s connection timeout
- `disconnect()` -- cancels receive loop, keepalive, invalidates session
- `sendHello()` -- sends device identity JSON on connect (deviceId, deviceName, deviceModel, systemVersion, wearableId, wearableType)
- `startReceiveLoop()` -- `URLSessionWebSocketTask` requires active `receive()` loop for protocol handling (pings, close frames)
- `startKeepAlive()` -- 5s ping interval to prevent proxy/NAT idle disconnects

**Backpressure:** `isEncoding` flag prevents frame pileup. If previous JPEG encode is still in-flight, the new frame is dropped. Stats logged every 100 dropped frames.

**Encoding pipeline (off-actor via `Task.detached`):**
1. `CVPixelBuffer` -> `CIImage` -> `CGImage` (CIContext handles YUV->RGB conversion)
2. `CGImage` -> JPEG via `CGImageDestination` (ImageIO C API, no UIKit dependency)
3. Build 29-byte FRLY header + append JPEG payload
4. Send binary via `URLSessionWebSocketTask.send(.data(message))`

**Raw data send:** `sendRawData(_:)` allows other stages (AudioStage) to send pre-built binary over the same WebSocket without going through the video encode path.

#### AudioStage (`Stages/AudioStage.swift`)

| Property | Value |
|----------|-------|
| `stageId` | `"audio"` |
| Sample rate | 48000 Hz |
| Channels | 1 (mono) |
| Bits per sample | 16-bit PCM |
| Buffer size | 960 frames (20ms at 48kHz) |
| Thread model | Actor with AVAudioEngine tap |

Captures microphone audio via `AVAudioEngine`, encodes as PCM 16-bit 48kHz mono, wraps in FRAU wire protocol, sends over the relay WebSocket via `RelayStage.sendRawData()`.

**Important:** Does not process video frames (`processFrame()` is no-op). Has its own capture path via `AVAudioEngine.inputNode.installTap`. Audio session must be pre-configured as `.playAndRecord` by the app delegate -- this stage never changes the category (which would crash the DAT SDK Bluetooth video connection).

**Encoding:** Float32 [-1.0, 1.0] -> Int16 [-32768, 32767] conversion, then builds 29-byte FRAU header + PCM payload.

#### RecordingStage (`Stages/RecordingStage.swift`)

| Property | Value |
|----------|-------|
| `stageId` | `"recording"` |
| Default FPS | 30 fps |
| Output format | .mov (passthrough, no re-encode) |
| Thread model | Actor |

Appends `CMSampleBuffer` frames to `AVAssetWriter` with passthrough output (zero re-encode). Writer input is lazily created from the first frame's `CMFormatDescription`. Recording starts explicitly via `startRecording(to:)` and stops via `stopRecording()` which finalizes the file.

---

## Wire Protocols

### Video Frame (FRLY)

29-byte header + JPEG payload:

```
Offset  Size  Field
0       4     Magic bytes "FRLY" (0x46 0x52 0x4C 0x59)
4       8     Sequence number (u64 LE)
12      4     Width (u32 LE)
16      4     Height (u32 LE)
20      1     Quality (u8, 0-100)
21      8     Timestamp ms (u64 LE, Unix epoch)
29      ...   JPEG payload
```

Built in two places:
- **iOS RelayStage** (`RelayStage.swift:290-316`) -- hand-built `Data` with `withUnsafeBytes` for LE encoding
- **Rust crate** (`lib.rs:96-105`) -- `encode_frame_prefix()` via `Vec<u8>` with `to_le_bytes()`

### Audio Frame (FRAU)

29-byte header + PCM payload:

```
Offset  Size  Field
0       4     Magic bytes "FRAU" (0x46 0x52 0x41 0x55)
4       1     Codec type (0 = PCM 16-bit LE)
5       8     Sequence number (u64 LE)
13      4     Sample rate (u32 LE)
17      2     Channels (u16 LE)
19      2     Bits per sample (u16 LE)
21      8     Timestamp ms (u64 LE, same epoch as FRLY -- used for A/V sync)
29      ...   PCM Int16 LE payload
```

Built in:
- **iOS AudioStage** (`AudioStage.swift:146-175`)

---

## Relay Crate (Rust/WASM)

Location: `hosted/crate/`

Package: `frame-relay-wasm` v0.1.0

### Build

```toml
[lib]
crate-type = ["cdylib", "rlib"]

[profile.release]
opt-level = "s"    # size-optimized
lto = true         # link-time optimization
```

Dependencies: `wasm-bindgen`, `web-sys` (WebSocket types), `js-sys`

### Exports

| Export | Type | Purpose |
|--------|------|---------|
| `FrameHeader` | Struct | Sequence, width, height, quality, timestamp_ms. `#[derive(Clone, Debug)]` |
| `FrameRelay` | Struct | Per-viewer throttle state: received/relayed/dropped counters, FPS gate |
| `FrameRelay::new(max_fps)` | Constructor | Sets `min_interval_ms = 1000 / max_fps` |
| `FrameRelay::should_relay(now_ms)` | Method | Returns `true` if `now_ms - last_frame_time_ms >= min_interval_ms`. Increments counters. |
| `FrameRelay::effective_fps(elapsed_ms)` | Method | `relayed / elapsed * 1000` |
| `FrameRelay::reset()` | Method | Zeroes all counters |
| `encode_frame_prefix(header)` | Function | Builds 29-byte FRLY header from `FrameHeader` |
| `decode_frame_prefix(buf)` | Function | Parses 29-byte FRLY header, returns `Option<FrameHeader>` |

### Server Usage

The Bun server (`hosted/server/src/server.ts`) instantiates one `FrameRelay` **per viewer** with the viewer's chosen quality preset:

| Preset | Max FPS | Min Interval |
|--------|---------|-------------|
| high | 30 | 33ms |
| medium | 15 | 67ms |
| low | 8 | 125ms |
| mini | 4 | 250ms |

When the publisher sends a frame, the server iterates all viewers and calls `relay.should_relay(Date.now())` for each. If `true`, the frame binary is forwarded. If `false`, the frame is silently dropped for that viewer only. Different viewers can see different FPS from the same publisher stream.

Audio frames (FRAU) are fanned out to all viewers without throttling.

### Why Rust/WASM

The throttle logic is simple enough for pure JS, but WASM provides:
- Deterministic performance (no GC pauses during hot fan-out loop)
- Native binary parsing for the FRLY wire protocol
- Tiny binary with `opt-level = "s"` + LTO

---

## End-to-End Data Flow

```
iOS App                                    Bun Server                        Browser
===========                                ===========                        =======

DAT SDK glasses camera stream
       |
       v
StreamSession.videoFramePublisher
       |
       v
FramePipelineManager (@MainActor)
       |
       +---> DisplayStage: CMSampleBuffer -> UIImage -> SwiftUI
       |
       +---> RelayStage: CMSampleBuffer -> JPEG -> FRLY header + payload
       |         |
       |         +---> URLSessionWebSocketTask.send(.data)
       |                   |
       |                   v  ws://host:8080/publish
       |                   |
       |             server.ts receives binary
       |                   |
       |             decode_frame_prefix() -- WASM crate (or JS fallback)
       |                   |
       |             For each viewer:
       |               frameRelay.should_relay(now)
       |                 |
       |             fanout binary to eligible viewers
       |             fanoutAudio to all viewers (no throttle)
       |                   |
       |                   v  ws://host:8080/view
       |                   |
AudioStage              viewer receives binary
  |                           |
  v                           v
AVAudioEngine             Canvas: Blob -> ImageBitmap
mic tap -> int16         AudioContext: ring buffer playback
  |
  v
FRAU header + PCM
  |
  v
RelayStage.sendRawData()
```

---

## Staleness Warning

This document was written against the codebase on `feat/telemetry-diagnostics` at commit `33ea802`. Specific line numbers, stage configurations, and protocol details will change as:

- Multi-session routing is implemented (see `docs/multi-session-platform.md`)
- Auth is introduced (see `docs/auth-google-oauth.md`)
- Additional stages or wire protocol changes are made

Before modifying the pipeline, re-read the affected files and update this document.
