# Universal Wasm Candidates -- Codebase Review

> Review of all logic across the three distributions (`com.mwdat-ios`, `relay/`, `samples/CameraAccess/`) to identify what should become Wasm, what stays native, and what the performance tradeoffs are.

---

## Definitions

| Term | Definition |
|------|-----------|
| **Universal** | Logic that is identical regardless of platform. Pure computation with no hardware or OS dependencies. |
| **Platform-specific** | Logic that requires platform APIs (CoreImage, AVFoundation, ARCore, WebView, etc.). |
| **Wasm candidate** | Universal logic currently duplicated across languages that would benefit from a single `.wasm` binary. |
| **FRLY** | Frame Relay wire protocol for video. 29-byte header + JPEG payload. |
| **FRAU** | Frame Relay Audio wire protocol. 29-byte header + PCM payload. |
| **EMA** | Exponential Moving Average. A smoothing algorithm where `ema = ema * alpha + sample * (1 - alpha)`. Used for FPS and jitter calculations. |

---

## Current Implementations by Language

### FRLY Video Protocol (29-byte header)

```
[4B "FRLY"][8B sequence LE][4B width LE][4B height LE][1B quality][8B timestamp_ms LE][JPEG payload]
```

| Location | Language | Lines | What it does |
|----------|----------|-------|-------------|
| `relay/crate/src/lib.rs:88-124` | Rust/Wasm | ~37 | `encode_frame_prefix()` + `decode_frame_prefix()` with `FrameHeader` struct |
| `relay/server/src/server.ts:316-327` | TypeScript | ~12 | `parseHeader()` with DataView |
| `samples/.../RelayStage.swift` | Swift | ~30 | Manual byte-by-byte construction with `Data` |
| `relay/viewer/index.html:348-356` | JavaScript | ~9 | DataView parsing inline |

**Status:** Implemented in Rust/Wasm. Not yet called from Swift (Swift builds headers manually). No protocol version field. No CRC/checksum.

### FRAU Audio Protocol (29-byte header)

```
[4B "FRAU"][1B codecType][8B reserved][4B sampleRate LE][2B channels LE][2B bitsPerSample LE][8B timestamp_ms LE][PCM payload]
```

| Location | Language | Lines | What it does |
|----------|----------|-------|-------------|
| `relay/server/src/server.ts:619` | TypeScript | ~5 | Magic byte detection only |
| `relay/viewer/index.html:324-344` | JavaScript | ~20 | Full decode: codec, sampleRate, channels, bitsPerSample, timestamp |
| `samples/.../AudioStage.swift:139-180` | Swift | ~42 | Full encode: builds 29-byte header + PCM payload |

**Status:** NOT in Rust/Wasm. Three separate implementations. Bytes 5-12 (between codecType and sampleRate) appear to be a sequence field in Swift but are never parsed by TypeScript/JavaScript. This inconsistency needs resolution.

### Frame Throttle Logic

Three independent implementations with different semantics:

**Rust (Wasm) -- `relay/crate/src/lib.rs:57-66`:**
```rust
pub fn should_relay(&mut self, now_ms: u64) -> bool {
    self.frames_received += 1;
    if self.min_interval_ms > 0 && now_ms - self.last_frame_time_ms < self.min_interval_ms {
        self.frames_dropped += 1;
        return false;
    }
    self.last_frame_time_ms = now_ms;
    self.frames_relayed += 1;
    true
}
```
Single global gate. One `min_interval_ms`. Returns bool.

**TypeScript -- `relay/server/src/server.ts:345-365`:**
```typescript
const preset = QUALITY_PRESETS[viewer.quality];
const elapsed = viewer.lastSentAt > 0 ? now - viewer.lastSentAt : preset.minIntervalMs;
if (elapsed < preset.minIntervalMs) { viewer.throttledCount++; continue; }
```
Per-viewer throttle with quality presets (high=30fps, medium=15fps, low=8fps, mini=4fps).

**Swift -- `samples/.../ThrottledStage.swift:45-57`:**
```swift
private func throttledProcess(_ packet: FramePacket) {
    guard config.isEnabled else { return }
    if let last = lastProcessedTimestamp {
        let elapsed = packet.timestamp - last
        if elapsed < minimumInterval { return }
    }
    lastProcessedTimestamp = packet.timestamp
    processThrottledFrame(packet)
}
```
Uses `ContinuousClock.Instant` and `Duration` (Swift 5.9+). Per-stage throttle.

**Status:** Three implementations, same concept, different APIs. Prime candidate for Wasm unification.

### Timing / Telemetry

**TypeScript only -- `relay/server/src/server.ts:47-56, 286-314`:**

```typescript
interface FrameTiming {
  lastSequence: number;
  lastTimestampMs: number;
  lastReceivedAt: number;
  jitterMs: number;       // EMA of absolute deviation from mean interval
  fps: number;            // rolling EMA: fps * 0.9 + instantFps * 0.1
  minIntervalMs: number;
  maxIntervalMs: number;
  droppedFrames: number;  // accumulated sequence gaps
}
```

`updateTiming()` performs:
- **FPS**: EMA with 0.9/0.1 weighting. Skips zero-interval frames to avoid `Infinity` poisoning.
- **Jitter**: EMA of `|interval - meanInterval|` where mean = `(min + max) / 2`.
- **Dropped frames**: `sequence - lastSequence - 1` gap accumulation.
- **Min/max interval**: Track extremes for range calculation.

**Status:** Not in Rust/Wasm. The Rust crate only has raw counters (`frames_received`, `frames_relayed`, `frames_dropped`). No FPS calculation, no jitter, no EMA. Pure math -- ideal Wasm candidate.

### Quality Presets

**TypeScript only -- `relay/server/src/server.ts:34-41`:**

```typescript
const QUALITY_PRESETS = {
  high:   { maxFps: 30, minIntervalMs: 33,  label: "High (30 FPS)" },
  medium: { maxFps: 15, minIntervalMs: 67,  label: "Medium (15 FPS)" },
  low:    { maxFps: 8,  minIntervalMs: 125, label: "Low (8 FPS)" },
  mini:   { maxFps: 4,  minIntervalMs: 250, label: "Mini (4 FPS)" },
};
```

**Status:** Configuration data. Low priority for Wasm -- could be shared JSON or FlatBuffer config.

### Audio Processing (Viewer Side)

**JavaScript only -- `relay/viewer/index.html:134-254`:**

| Component | Implementation |
|-----------|---------------|
| Ring buffer | `Float32Array(96000)` with read/write pointers, 2s at 48kHz |
| Pre-buffering | 60ms (`48000 * 0.06` samples) before starting output |
| Resampling | Linear interpolation between adjacent samples for rate mismatch |
| Underrun handling | Reset prebuffer state when ring empties mid-playback |
| A/V sync | `videoClockBase` maps sender timestamps to `AudioContext.currentTime` |

Resampling math (linear interpolation):
```javascript
const srcPos = i / ratio;
const idx0 = Math.floor(srcPos);
const idx1 = Math.min(idx0 + 1, inSamples - 1);
const frac = srcPos - idx0;
const sample = s0 + (s1 - s0) * frac;
```

**Status:** Not in Rust/Wasm. Pure DSP math. The `ScriptProcessorNode` used for playback is deprecated in favor of `AudioWorklet`. Migration to AudioWorklet + Wasm is the correct modern path and would also yield meaningful performance improvement (48kHz = 48,000 samples/second of float multiply+add).

---

## Pipeline Stages (Swift)

| Stage | File | What it does | Platform-specific? |
|-------|------|-------------|-------------------|
| `FramePipelineManager` | `Pipeline/FramePipelineManager.swift` | Subscribes to `videoFramePublisher`, dispatches to stages | Yes -- DAT SDK `VideoFrame` |
| `DisplayStage` | `Pipeline/Stages/DisplayStage.swift` | CVPixelBuffer -> CIImage -> CGImage -> UIImage | **Yes** -- CoreImage, UIKit |
| `RecordingStage` | `Pipeline/Stages/RecordingStage.swift` | CMSampleBuffer -> AVAssetWriter (.mov passthrough) | **Yes** -- AVFoundation |
| `AudioStage` | `Pipeline/Stages/AudioStage.swift` | Mic capture -> PCM 16-bit -> FRAU wire protocol | **Half** -- capture is iOS-only, FRAU encoding is universal |
| `RelayStage` | `Pipeline/Stages/RelayStage.swift` | CVPixelBuffer -> JPEG -> FRLY wire protocol -> WebSocket | **Half** -- JPEG encode is iOS-only, FRLY + WS are universal |
| `ThrottledStage` | `Pipeline/Stages/ThrottledStage.swift` | FPS gate based on `ContinuousClock.Instant` | **No** -- pure logic |

### Data Flow

```
Meta Ray-Ban Glasses
       | (BLE/WiFi raw frames)
       v
DAT SDK (MWDATCamera)
       | VideoFrame
       v
FramePipelineManager (MainActor, single subscriber)
       | CMSampleBuffer -> FramePacket
       v
   +---+---+---+---+---+
   |   |   |   |   |   |
   v   v   v   v   v   v
Display Recording Audio Relay Throttle
Stage    Stage    Stage  Stage  Stage
                         |
                    JPEG encode
                    FRLY header
                    WebSocket send
                         |
                         v
                   Relay Server (Bun)
                    /     |     \
                   /      |      \
            Viewer 1  Viewer 2  Viewer N
            (HTML/JS)  (HTML/JS) (HTML/JS)
```

---

## Performance Analysis

### Methodology

Performance estimates based on:
- Wasm benchmarks: 80-95% of native for compute, 3-5x faster than JavaScript for numeric math
- Bridge overhead: ~0.01ms per Wasm call (WasmKit on iOS, WasmEdge on Android)
- Current Bun/TypeScript performance: V8 JIT provides competitive performance for simple operations

### Per-Module Performance

#### FRLY/FRAU Encode/Decode (~30 bytes, 30fps)

| Implementation | Time per frame | Time per second (30fps) |
|---------------|---------------|----------------------|
| TypeScript (DataView) | ~0.05ms | ~1.5ms |
| Wasm (Rust) | ~0.01ms | ~0.3ms |
| Swift (native) | ~0.005ms | ~0.15ms |

**Verdict:** All are instant at 30fps. No user-perceptible difference. The value is in unification (one impl instead of 4), not speed.

#### Frame Throttle (1 time comparison, 30fps)

| Implementation | Time per check |
|---------------|---------------|
| All (TS, Rust, Swift) | <1 microsecond |

**Verdict:** Identical across all implementations. A single subtraction and comparison. Unification value only.

#### Timing/Telemetry (EMA, ~10 arithmetic ops, 30fps)

| Implementation | Time per update | Notes |
|---------------|----------------|-------|
| TypeScript (server) | ~0.02ms | Runs per frame per viewer |
| Wasm (Rust) | ~0.005ms | 3-5x faster for numeric |
| Swift (native) | ~0.002ms | Fastest |

**Verdict:** Negligible difference at current scale. Would matter at 100+ concurrent viewers where `updateTiming()` runs per-viewer per-frame.

#### Audio Resampling (48kHz = 48,000 samples/sec)

| Implementation | Time per 20ms chunk | CPU % at 48kHz |
|---------------|---------------------|----------------|
| JavaScript (ScriptProcessorNode) | ~0.3ms | ~1.5% |
| Wasm (AudioWorklet) | ~0.05ms | ~0.25% |

**Verdict:** This is the only current module where Wasm provides a materially meaningful performance improvement. The `ScriptProcessorNode` is also deprecated -- AudioWorklet + Wasm is the correct modern architecture.

#### Ring Buffer (pointer arithmetic, 48kHz)

| Implementation | Overhead |
|---------------|----------|
| JavaScript (Float32Array) | Low |
| Wasm (linear memory) | Near-zero |

**Verdict:** Marginal improvement. The ring buffer is fast in both implementations.

### Bridge Overhead (The Hidden Cost)

Each call from host to Wasm has a boundary crossing cost:

| Host | Bridge cost per call |
|------|---------------------|
| Bun (JavaScript) | ~0.01ms |
| Swift (WasmKit) | ~0.01ms |
| Kotlin (WasmEdge) | ~0.01ms |

At 30fps with one call per frame: 0.3ms/second overhead. Negligible.

**But** if each frame requires 5 separate Wasm calls (decode header, update timing, check throttle, process frame, encode result): 1.5ms/second. Still acceptable, but requires batching thought.

**Rule:** Batch operations into fewer Wasm calls. One `process_frame(offset, len)` call is better than five granular calls.

### Where Wasm Is Worse

| Concern | Impact | Mitigation |
|---------|--------|-----------|
| Bridge overhead per call | ~0.01ms each | Batch operations |
| Debugging complexity | Linear memory inspection vs source-level | Source maps, WasmKit debugging |
| Iteration speed | +15s compile cycle vs instant TS reload | Acceptable for stable protocol logic |
| ML inference vs CoreML | ~10-20% slower than native CoreML/NNAPI | Acceptable for lightweight models; use CoreML/NNAPI for heavy models |
| No SIMD on iOS WasmKit | WasmKit has limited SIMD support | AOT compile or use native path for SIMD-heavy code |

---

## Classification: Universal vs Platform-Specific

### Clearly Universal (Should Be Wasm)

| Logic | Current Implementations | Lines Per Impl | Priority |
|-------|------------------------|----------------|----------|
| FRLY encode/decode | Rust, TS, Swift, JS | ~30 | Done in Rust, needs Swift integration |
| FRAU encode/decode | TS, JS, Swift (manual) | ~40 | **Missing from Rust crate** |
| Frame throttle (global + per-viewer) | Rust (simple), TS (per-viewer), Swift (clock) | ~20 | **Fragmented -- 3 impls** |
| Timing/telemetry (EMA FPS, jitter, drops) | TS only | ~30 | **Missing from Rust crate** |
| Audio resampling (linear interpolation) | JS only | ~15 | **Missing from Rust crate** |
| Ring buffer management | JS only | ~25 | **Missing from Rust crate** |

### Stays Platform-Specific

| Logic | Reason | iOS API | Android XR API |
|-------|--------|---------|----------------|
| Camera capture | Hardware API access | DAT SDK `StreamSession` | ARCore `Camera` |
| Pixel format conversion | GPU framework | CoreImage `CIContext` | Android `Bitmap` |
| JPEG encoding | Platform image APIs | `CGImageDestination` | `Bitmap.compress()` |
| Video recording | OS media framework | `AVAssetWriter` | `MediaMuxer` |
| Microphone capture | Audio hardware | `AVAudioEngine` | `AudioRecord` |
| WebSocket I/O | Platform networking | `URLSessionWebSocketTask` | `OkHttp WebSocket` |
| UI rendering | Platform UI | SwiftUI | Jetpack Compose |
| Object storage | I/O bound, host-managed | S3 SDK | S3 SDK |
| Bluetooth (DAT SDK) | Closed platform SDK | MWDATCore/MWDATCamera | N/A |

### New Modules (Not Yet Built)

| Module | Purpose | Why Wasm |
|--------|---------|----------|
| Vision preprocess | Resize, normalize, color convert incoming frames | Same math on every platform |
| Object detection | Lightweight model inference (YOLO-nano, MobileNet-SSD) | Same weights, same ops |
| Privacy filter | Face blur, license plate redaction before relay | Same algorithm everywhere |
| Scene classification | Label scenes for context/metadata | Same model everywhere |
| FlatBuffer schema | Zero-copy data contract between host and module | Shared schema, generated per language |

---

## Current Architecture vs Target Architecture

### Current (Fragmented)

```
iOS App (Swift)                    Server (TypeScript/Bun)         Viewer (JavaScript)
+-----------------------+          +-----------------------+       +------------------+
| RelayStage            |          | parseHeader() (TS)    |       | parseHeader() JS |
|  - FRLY encode (Swift)|          | parseFRAU (TS)        |       | parseFRAU (JS)   |
| AudioStage            |          | fanout() throttle(TS) |       | resample (JS)    |
|  - FRAU encode (Swift)|          | updateTiming() (TS)   |       | ring buffer (JS) |
| ThrottledStage        |          | QUALITY_PRESETS (TS)  |       | A/V sync (JS)    |
|  - FPS gate (Swift)   |          | SessionRecorder (TS)  |       | HUD (JS)         |
+-----------------------+          +-----------------------+       +------------------+

FRLY: 4 implementations (Rust, TS, Swift, JS)
FRAU: 3 implementations (TS, JS, Swift) -- not in Rust
Throttle: 3 implementations (Rust, TS, Swift)
Telemetry: 1 implementation (TS)
Audio DSP: 1 implementation (JS)
```

### Target (Unified Wasm Core)

```
iOS App (Swift)          Android XR (Kotlin)      Server (TS/Bun)      Viewer (JS)
+------------------+    +------------------+     +----------------+   +-------------+
| Platform layer   |    | Platform layer   |     | Host glue (TS) |   | Host glue   |
|  - Camera (DAT)  |    |  - Camera (ARC)  |     |  - WebSocket   |   |  - Canvas   |
|  - JPEG (CoreImg)|    |  - JPEG (Bitmap) |     |  - S3 storage  |   |  - AudioCtx |
|  - WS (URLSess.) |    |  - WS (OkHttp)   |     |  - SessionMgr  |   |  - HUD      |
+--------+---------+    +--------+---------+     +-------+--------+   +------+------+
         |                       |                        |                   |
         +-----------+-----------+-----------+------------+-------------------+
                                 |
                     +-----------+-----------+
                     |   .wasm Core Module   |
                     |                       |
                     |  FRLY encode/decode   |
                     |  FRAU encode/decode   |
                     |  Frame throttle       |
                     |  Timing/telemetry     |
                     |  Audio resampling     |
                     |  Ring buffer          |
                     |  Quality presets      |
                     +-----------+-----------+
                                 |
                     +-----------+-----------+
                     |  .wasm Vision Module  |
                     |  (future, separate)   |
                     |                       |
                     |  Frame preprocess     |
                     |  Object detection     |
                     |  Scene classification |
                     |  Privacy filter       |
                     +-----------------------+

FRLY: 1 implementation (Rust/Wasm)
FRAU: 1 implementation (Rust/Wasm)
Throttle: 1 implementation (Rust/Wasm)
Telemetry: 1 implementation (Rust/Wasm)
Audio DSP: 1 implementation (Rust/Wasm)
```

---

## Recommended Build Order

### Phase 1: Extend the Rust Crate (Highest Impact, Lowest Risk)

The existing `relay/crate/src/lib.rs` becomes the universal protocol+telemetry module.

**1a. Add FRAU protocol:**
```
AudioHeader struct { codec_type, sequence, sample_rate, channels, bits_per_sample, timestamp_ms }
encode_audio_prefix(header) -> Vec<u8>
decode_audio_prefix(buf) -> Option<AudioHeader>
```

**1b. Add timing/telemetry:**
```
FrameTracker struct {
  last_sequence, last_timestamp_ms, last_received_at,
  jitter_ms, fps (EMA), min_interval_ms, max_interval_ms, dropped_frames
}
update_timing(tracker, sequence, timestamp_ms)
format_timing(tracker) -> TimingSnapshot
```

**1c. Add per-viewer throttle:**
```
QualityPreset enum { High(30), Medium(15), Low(8), Mini(4) }
ViewerThrottle struct { quality, last_sent_at, throttled_count }
should_send_to_viewer(throttle, now_ms) -> bool
```

**1d. Add audio utilities:**
```
RingBuffer struct { buffer, write_pos, read_pos, fill, capacity }
ring_push(buffer, samples)
ring_drain(buffer, count) -> Vec<f32>
resample_linear(input, input_rate, output_rate) -> Vec<f32>
```

**Estimated work:** ~200-300 lines of Rust. Produces one `.wasm` binary (~20-50KB optimized).

### Phase 2: FlatBuffer Schema (Foundation for Vision Modules)

Define the data contract between host and Wasm:

```
frame_schema.fbs:
  FrameData  (metadata + pixel_data)
  FrameResult (objects, scene_description, processing_time_ms)
  AudioChunk  (metadata + pcm_data)
  TimingSnapshot (fps, jitter, intervals, drops)
```

Generate for Swift, Kotlin, Rust, TypeScript. This becomes the versioned interface contract.

### Phase 3: Vision Modules (Future, Separate `.wasm` Binaries)

Each vision operation is a separate `.wasm` module following the wasmVision processor pattern:

```
preprocess.wasm  -- resize, normalize, color convert
detect.wasm      -- object detection (YOLO-nano or MobileNet-SSD)
classify.wasm    -- scene classification
privacy.wasm     -- face blur, plate redaction
```

Each uses the FlatBuffer schema from Phase 2 for zero-copy data exchange.

---

## Existing Code Reference

| File | Role |
|------|------|
| `relay/crate/src/lib.rs` | Current Rust/Wasm crate (FRLY + throttle) |
| `relay/crate/Cargo.toml` | Crate config (cdylib, wasm-bindgen, opt-level "s", LTO) |
| `relay/server/src/server.ts` | Bun server: FRLY/FRAU parsing, fanout, timing, recording |
| `relay/viewer/index.html` | Browser viewer: FRLY/FRAU decode, ring buffer, resampling, A/V sync |
| `samples/.../Pipeline/FramePipelineManager.swift` | Frame dispatch to stages |
| `samples/.../Pipeline/FramePipelineTypes.swift` | `FramePacket`, `FrameStageConfig`, `FramePipelineStage` protocol |
| `samples/.../Pipeline/Stages/RelayStage.swift` | JPEG encode, FRLY construction, WebSocket relay |
| `samples/.../Pipeline/Stages/AudioStage.swift` | Mic capture, FRAU construction |
| `samples/.../Pipeline/Stages/DisplayStage.swift` | CVPixelBuffer -> UIImage |
| `samples/.../Pipeline/Stages/RecordingStage.swift` | CMSampleBuffer -> AVAssetWriter |
| `samples/.../Pipeline/ThrottledStage.swift` | FPS throttle base class |
