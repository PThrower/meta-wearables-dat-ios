# Audio Pipeline

PCM processing chain, audio codec types, event bus, and FRAU wire protocol encoding for real-time audio relay.

---

## Architecture Overview

The audio pipeline is an actor-based pub/sub system that decouples audio capture from audio consumption. Every component runs on its own Swift actor executor -- nothing blocks the main thread.

```
AudioSource (phone mic / glasses HFP)
       |
  AudioStage (actor) -- captures via AVAudioEngine, converts to Int16 PCM
       |
  AudioEventBus (actor) -- AsyncStream pub/sub, bufferingNewest(10)
       |
       +--> AudioRelayStage (actor) -- noise gate / suppression / gain --> FRAU encode --> WebSocket
       |
       +--> AudioTapClient (actor) -- inbound relay frames --> AudioEventBus (codecType 3)
       |
       +--> AudioPlaybackStage (actor) -- TTS via AVSpeechSynthesizer.write() --> AudioEventBus (codecType 2)
```

The pipeline manager for video frames is separate:

```
StreamSession.videoFramePublisher  (or PhoneCameraCapture raw buffer)
       |
  FramePipelineManager (@MainActor) -- single subscriber, dispatches via Task.detached
       |
       +--> each registered FramePipelineStage.processFrame(packet)  [fire-and-forget]
```

Audio stages ignore video frames (no-op `processFrame`). Video stages ignore audio events. They share the `FramePipelineStage` protocol but operate on disjoint data paths.

---

## FramePipelineTypes

Core types shared across the entire pipeline (both video and audio stages).

### FramePacket

```swift
struct FramePacket: @unchecked Sendable {
    let sampleBuffer: CMSampleBuffer
    let timestamp: ContinuousClock.Instant
    let sequenceNumber: UInt64
}
```

Created on `@MainActor` from `VideoFrame.sampleBuffer` or injected directly via `onRawSampleBuffer()` for phone camera capture. The `@unchecked Sendable` conformance is safe because `CMSampleBuffer` is reference-counted with immutable data after creation.

### FrameStageConfig

```swift
struct FrameStageConfig: Sendable {
    let targetFPS: UInt
    let isEnabled: Bool
    static let maxFPS = FrameStageConfig(targetFPS: .max, isEnabled: true)
}
```

Controls per-stage FPS throttling and enabled state. `maxFPS` disables throttling entirely. All audio stages use `FrameStageConfig.maxFPS` since audio flows through `AudioEventBus`, not the frame pipeline.

### FramePipelineStage Protocol

```swift
protocol FramePipelineStage: AnyObject, Sendable {
    nonisolated var stageId: String { get }
    var config: FrameStageConfig { get set }
    func processFrame(_ packet: FramePacket) async
    func start() async
    func stop() async
}
```

Default no-op implementations provided for `start()` and `stop()`. Every stage is a Swift actor, so all mutable state is automatically protected by actor isolation. `stageId` is `nonisolated` because it is a let constant assigned at init.

---

## AudioPacket

```swift
struct AudioPacket: Sendable {
    let pcmData: Data          // Raw Int16 LE mono PCM
    let codecType: UInt8       // 0=phone mic, 1=glasses HFP, 2=TTS, 3=relay inbound
    let sampleRate: UInt32     // Hardware rate (48000, 8000, ~22050, 16000)
    let channels: UInt16       // Always 1 (mono)
    let bitsPerSample: UInt16  // Always 16
    let sequenceNumber: UInt64 // Monotonic, assigned by producer
    let timestampMs: UInt64    // Wall-clock ms since Unix epoch
}
```

Transport-agnostic. FRAU wire protocol encoding is the subscriber's responsibility. Created by `AudioStage` (codecType 0/1), `AudioPlaybackStage` (codecType 2), and `AudioTapClient` (codecType 3).

---

## AudioSource

```swift
enum AudioSource: Sendable {
    case builtInMic      // codecType 0, displayName "Phone Mic"
    case bluetoothHFP    // codecType 1, displayName "Glasses Mic"
}
```

Passed to `AudioStage.init(source:)` at construction time. Determines the `codecType` tagged on every `AudioPacket` published by that stage. Note: AudioSource only covers capture sources (0 and 1). Playback (2) and relay inbound (3) are hardcoded by their respective producers.

---

## AudioEventBus

Actor-based pub/sub using `AsyncStream<AudioPacket>`.

### Subscriber Lifecycle

1. Subscriber calls `subscribe()` -- returns `(UUID, AsyncStream<AudioPacket>)`
2. Subscriber iterates: `for await packet in stream { ... }`
3. Subscriber calls `unsubscribe(id)` when done
4. Bus calls `continuation.finish()` on unsubscribe

### Backpressure Policy

`bufferingNewest(10)` -- the stream keeps only the 10 most recent packets. If a subscriber falls behind (e.g. network congestion), older packets are silently dropped. This is correct for real-time audio: stale samples are worse than missing samples.

### Publishing

`publish(_ packet:)` yields to every registered continuation. If zero subscribers exist, the call is a silent no-op (no buffering, no error).

### Thread Safety

`AudioEventBus` is a Swift actor. All mutations (add/remove subscriber) are serialized. `AudioPacket` is `Sendable`, so crossing the isolation boundary is safe.

---

## AudioStage

Captures microphone audio via `AVAudioEngine`, converts to Int16 PCM mono, wraps in `AudioPacket`, publishes to `AudioEventBus`.

### Configuration

| Parameter | Value |
|-----------|-------|
| Buffer size | 1024 frames |
| Output channels | 1 (mono) |
| Bits per sample | 16 |
| Sample rate | Hardware-native (detected at runtime) |

### Hardware Format Detection

The tap is installed using `inputNode.outputFormat(forBus: 0)` -- the hardware's native format. Requesting a different format at the tap level causes `AVAudioIONodeImpl::SetOutputFormat` to throw an ObjC `NSException` on iOS 18, which crashes as `SIGABRT`. Format conversion happens inside the tap callback instead.

The detected hardware format varies by source:
- Phone mic: typically 48000 Hz Float32
- Glasses HFP: 8000 Hz (narrowband) or 16000 Hz (wideband), may be Float32 or Int16

### iOS 18 Crash Workaround

```swift
// DO NOT do this -- crashes on iOS 18 with NSException:
let convertedFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false)!
inputNode.installTap(onBus: 0, bufferSize: 1024, format: convertedFormat, ...)

// DO this instead -- use hardware format, convert manually:
let hwFormat = inputNode.outputFormat(forBus: 0)
inputNode.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { buffer, _ in
    // Convert Float32 -> Int16 via PCMConvert inside callback
}
```

### Tap Callback

Inside the tap, the callback handles both Float32 and Int16 hardware formats:

1. If `hwFormat.commonFormat == .pcmFormatFloat32` or `.pcmFormatFloat64`: uses `PCMConvert.floatToPCM16()`
2. Else if `int16ChannelData` is available: copies raw bytes directly (`Data(bytes:count:)`)
3. Otherwise: returns without publishing (unknown format)

The converted PCM data is wrapped in `AudioPacket` with `sampleRate` from the hardware format, then published to `AudioEventBus` via `Task { await eventBus.publish(packet) }`.

### Audio Session

`AudioStage` never changes the `AVAudioSession` category. The category must be pre-configured as `.playAndRecord` by `CameraAccessApp` before the stage starts. Changing the category would crash the Bluetooth video stream.

### Audio Interruption Handling

Observes `AVAudioSession.interruptionNotification`:

| Interruption Type | Action |
|-------------------|--------|
| `.began` | Pause the engine (`engine.pause()`), set `isPaused = true` |
| `.ended` with `.shouldResume` | Restart engine (`engine.start()`), clear `isPaused` |
| `.ended` without `.shouldResume` | Log only -- engine stays paused |

### Route Change Handling

Observes `AVAudioSession.routeChangeNotification`. Logs all route change reasons. For `.oldDeviceUnavailable` specifically, detects if the engine was stopped by the OS (glasses disconnected).

### Lifecycle

- `start()`: installs tap, starts engine, registers notification observers
- `stop()`: removes tap, stops engine, removes observers. Does NOT deactivate the audio session (caller handles that).

---

## PCMConvert

Core Float32-to-Int16 conversion used by both `AudioStage` and `AudioPlaybackStage`.

```swift
enum PCMConvert {
    static func floatToPCM16(_ floatData: UnsafePointer<Float>, frameCount: Int) -> Data
}
```

### Conversion Details

1. Clamps float input to [-1.0, 1.0]: `max(-1.0, min(1.0, floatData[i]))`
2. Scales to Int16 range: `Int16(clamped * 32767.0)`
3. Writes as signed 16-bit little-endian

### Clamping Asymmetry

The scale factor is **32767** (not 32768). This means:
- Positive full-scale: `1.0 * 32767 = 32767` (Int16 max)
- Negative full-scale: `-1.0 * 32767 = -32767` (not -32768)

This is asymmetric -- Int16 can represent -32768, but this converter never produces it. The asymmetry is intentional: it avoids the -32768 edge case that can cause overflow in some downstream processing (e.g., certain DSP algorithms treat -32768 as an invalid value because its absolute value exceeds Int16 max).

### Usage

- `AudioStage` tap callback: converts hardware Float32 buffers to Int16 PCM
- `AudioPlaybackStage`: converts TTS Float32 buffers to Int16 PCM

---

## AudioPlaybackStage (TTS)

Generates text-to-speech audio via `AVSpeechSynthesizer`, plays through glasses HFP speaker, and publishes PCM to `AudioEventBus` with codecType 2.

### TTS Parameters

| Parameter | Value |
|-----------|-------|
| Speech rate | 0.5 (AVSpeechUtterance default mid-point) |
| Language | "en-US" |
| Volume | 1.0 |
| Chunk size | 2048 bytes per AudioPacket |

### Dual-Utterance Architecture

For each `speakGuidance(_:)` call, the stage creates **two separate utterances** from the same text:

1. **speakUtterance**: played through the glasses speaker via `synth.speak()` -- local audio output
2. **writeUtterance**: generates PCM via `synth.write()` with a `withCheckedContinuation` that collects all buffers until the synthesis completes (frameLength == 0 signals end)

Both utterances use identical rate and language settings. The dual approach is necessary because `AVSpeechSynthesizer.write()` does not produce audible output -- it only yields PCM buffers.

### PCM Collection

Each buffer from `write()` is deep-copied (`AVAudioPCMBuffer` init + `floatChannelData` memcpy) because the system reuses the buffer reference. Collected buffers are concatenated into a single `Data` via `PCMConvert.floatToPCM16()`.

### Chunked Publishing

The full PCM payload is split into 2048-byte chunks. Each chunk becomes a separate `AudioPacket` with:
- `codecType: 2`
- `sampleRate`: from the first AVAudioFormat buffer
- `channels`: from the first AVAudioFormat buffer
- `bitsPerSample: 16`
- `timestampMs`: base timestamp + `chunkIndex * chunkDurationMs` (interpolated)

### routeToGlasses()

Called before speaking on every `speakGuidance` invocation. Routes audio output to the Bluetooth HFP device:

1. Checks if already on `.bluetoothHFP` output -- if so, returns immediately
2. Searches `AVAudioSession.availableInputs` for a `.bluetoothHFP` port
3. Sets it as `preferredInput` -- this forces output through the glasses speaker

This is necessary because `AVSpeechSynthesizer` does not automatically use the HFP output. Setting the preferred input to the Bluetooth HFP port causes iOS to route output through the same device's HFP speaker channel.

### Synthesizer Reuse

The `AVSpeechSynthesizer` instance is reused across calls (lazily created, stored as `@MainActor` property). Creating a new synthesizer each call resets audio routing internally, which can cause playback glitches.

### Current Speech Interruption

If `synth.isSpeaking` when a new `speakGuidance` arrives, the current speech is stopped immediately (`stopSpeaking(at: .immediate)`) before starting the new one.

---

## AudioTapClient

WebSocket client that connects to the gateway's `/tap/audio` endpoint and receives JSON audio frames. Decodes them to `AudioPacket` and publishes to `AudioEventBus`.

### Architecture

```
Gateway /tap/audio --[WebSocket JSON]--> AudioTapClient
     --> RemoteAudioFrame (Codable) --> AudioPacket --> AudioEventBus --> subscribers
```

### RemoteAudioFrame JSON Contract

```json
{
  "type": "audio",
  "codecType": 3,
  "sequence": 1,
  "sampleRate": 16000,
  "channels": 1,
  "bitsPerSample": 16,
  "timestampMs": 1713700000000,
  "pcmBase64": "<base64-encoded Int16 LE PCM>"
}
```

Parsed by `RemoteAudioFrame: Codable`. Converted to `AudioPacket` via `toAudioPacket()`:
1. Guards against empty `pcmBase64`
2. Decodes base64 to `Data`
3. Guards decoded data is non-empty
4. Returns `AudioPacket` with all fields mapped directly

Frames where `type != "audio"` or where PCM decoding fails are silently dropped.

### Auto-Reconnect

Exponential backoff with parameters:

| Parameter | Value |
|-----------|-------|
| Initial delay | 1 second |
| Backoff factor | 2x per attempt |
| Maximum delay | 30 seconds |
| Trigger | Receive loop exit (error or connection loss) |

Reconnect is disabled by calling `disconnect()` which sets `shouldReconnect = false`.

### Keepalive

Sends WebSocket ping every 5 seconds to prevent proxy/NAT idle disconnects. Failed pings mark the connection as disconnected, triggering the reconnect loop.

### Connection Timeout

5-second connect timeout using `Task.sleep`. If the WebSocket delegate does not fire `onOpen` or `onClose` within 5 seconds, the connection attempt is cancelled.

### URL Construction

`tapURL(for:session:)` strips `/publish` suffix from the base relay URL and constructs `<base>/tap/audio?session=<sessionId>`. If no session is provided, uses `"default"`.

---

## FramePipelineManager

`@MainActor` class that serves as the single subscriber to a `StreamSession`'s `videoFramePublisher`. Extracts `CMSampleBuffer`, wraps in `FramePacket`, dispatches to registered stages.

### Frame Dispatch

```swift
for stage in stages {
    guard stage.config.isEnabled else { continue }
    Task.detached { [stage] in
        await stage.processFrame(packet)
    }
}
```

Each stage receives the same `FramePacket` via `Task.detached`, which correctly hops to each actor's executor. Fire-and-forget -- the manager never awaits stage processing. This ensures one slow stage cannot block others or the main thread.

### onRawSampleBuffer Injection

`onRawSampleBuffer(_:)` bypasses `StreamSession` entirely. Used by `PhoneCameraCapture` to inject raw `CMSampleBuffer` into the same pipeline. Stages cannot distinguish the source -- they receive identical `FramePacket` instances.

### Stage Registration

Stages are added/removed dynamically:
- `register(_ stage:)` -- appends to `stages` array
- `unregister(stageId:)` -- removes by ID
- `attachToStreamSession(_ session:)` -- subscribes to `videoFramePublisher`, invalidates previous token
- `detachFromStreamSession()` -- releases the listener token

### Threading Safety

The manager is `@MainActor` isolated. The `videoFramePublisher` listener callback hops to `@MainActor` explicitly via `Task { @MainActor in ... }`. Stage dispatch uses `Task.detached` which correctly escapes MainActor isolation.

---

## PCM Processing Chain

Applied per audio packet **only for codecType 0** (phone mic) and **codecType 1** (glasses HFP mic). CodecType 2 (TTS) and 3 (relay inbound) bypass all processing and are sent as-is.

```
raw PCM -> noise gate -> noise suppression (EMA) -> gain -> FRAU encode
```

All processing functions are stateless (`static` methods in `PCMAudioProcessing`). EMA noise floor state is maintained in `AudioRelayStage` via `inout` parameter, tracked per codecType.

### 1. Noise Gate

Computes RMS of Int16 PCM samples, normalized to [0.0, 1.0].

| Parameter | Value |
|-----------|-------|
| Threshold | 0.0 (disabled) by default |
| Range | 0.0 (off) to 1.0 |
| Action | Entire frame dropped (not zeroed) if RMS < threshold |
| Effect | Bandwidth savings -- silent frames never hit the wire |

RMS computation: `sqrt(sum((sample / 32768.0)^2) / sampleCount)` -- normalized by dividing each Int16 sample by 32768.0 before squaring.

### 2. Noise Suppression (EMA + Spectral Subtraction)

Minimum-statistics noise floor estimation with spectral subtraction.

| Parameter | Value |
|-----------|-------|
| EMA alpha | 0.95 (very slow adaptation) |
| Floor tracking | Per-codecType independent estimates |
| Method | `cleaned = max(0, |sample| - floorAmplitude)`, preserving sign |
| Floor amplitude | `floor * 32768.0` (normalized to Int16 scale) |
| Bypass | Skipped if floor <= 0.001 (no meaningful noise) |

Floor update logic:
- If current RMS < current floor: `floor = RMS` (tracks minimum)
- Else: `floor = alpha * floor + (1 - alpha) * rms`

#### Noise Floor Reset When Disabled

When `setNoiseSuppression(codecType:enabled:)` is called with `enabled: false`, the noise floor estimate for that codecType is reset to **0.0**. This ensures that if suppression is later re-enabled, the floor re-learns from scratch rather than continuing from a stale estimate that may be inappropriate for changed audio conditions.

```swift
func setNoiseSuppression(codecType: UInt8, enabled: Bool) {
    processingConfig.noiseSuppressionEnabled[codecType] = enabled
    if !enabled { noiseFloorEstimate[codecType] = 0.0 }
}
```

### 3. Gain

| Parameter | Value |
|-----------|-------|
| Range | -20.0 to +20.0 dB per source |
| Default | 0.0 dB (unity gain) |
| Formula | `gainFactor = 10^(gainDb / 20)`, each sample multiplied and clamped to [-32768, 32767] |

Gain is applied after noise suppression. If `gainDb == 0.0`, the entire step is skipped (no data copy).

---

## AudioProcessingConfig

Per-source processing configuration, mutated atomically via actor isolation on `AudioRelayStage`.

```swift
struct AudioProcessingConfig: Sendable {
    var gainDb: [UInt8: Float] = [0: 0.0, 1: 0.0]
    var noiseGateThreshold: [UInt8: Float] = [0: 0.0, 1: 0.0]
    var noiseSuppressionEnabled: [UInt8: Bool] = [0: false, 1: false]
    var mixEnabled: Bool = false
    var mixWeights: [UInt8: Float] = [0: 0.5, 1: 0.5]
}
```

Configured by `StreamSessionViewModel` in response to JSON control messages from viewers. Serialization to JSON uses `toDictionary()` which maps `UInt8` keys to `String` keys.

---

## AudioRelayStage

Subscribes to `AudioEventBus`, applies the PCM processing chain, encodes as FRAU wire protocol, sends over the relay WebSocket via `RelayStage.sendRawData()`.

### EventBus Subscription

```swift
func attachToEventBus(_ bus: AudioEventBus) async {
    let (id, stream) = await bus.subscribe()
    subscriptionId = id
    listenTask = Task { [weak self] in
        for await packet in stream {
            guard let self else { break }
            await self.sendAudio(packet)
        }
    }
}
```

The `listenTask` runs for the lifetime of the subscription. It captures `[weak self]` to allow deallocation if the stage is deallocated while the stream is still active.

### Processing Pipeline (per AudioPacket)

```
1. If codecType 0 or 1:
   a. Noise gate: compute RMS, return early (drop frame) if RMS < threshold
   b. Noise suppression: EMA floor estimation + spectral subtraction
   c. Gain: apply dB multiplier, skip if gainDb == 0.0
2. Build FRAU wire protocol message via WireProtocol.buildFRAU()
3. Send via RelayStage.sendRawData()
4. Diagnostic log every 2 seconds (frames sent, suppressed, pcm size, message size)
```

### FRAU Encoding

Wire protocol encoding is delegated to `WireProtocol.buildFRAU()`.

**FRAU v1 Header Layout (36 bytes):**

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | Magic: `0x46 0x52 0x41 0x55` ("FRAU") |
| 4 | 1 | Version: `0x01` |
| 5 | 4 | Payload length (UInt32 LE) |
| 9 | 1 | codecType (UInt8) |
| 10 | 8 | Sequence number (UInt64 LE) |
| 18 | 4 | Sample rate (UInt32 LE) |
| 22 | 2 | Channels (UInt16 LE) |
| 24 | 2 | Bits per sample (UInt16 LE) |
| 26 | 8 | Timestamp ms (UInt64 LE) |
| 34 | 2 | CRC-16/CCITT-FALSE over bytes [0..33] |
| 36 | ... | PCM payload (Int16 LE samples) |

All multi-byte fields are little-endian. CRC-16/CCITT-FALSE is computed over header bytes [0..33] only (not the payload). Parsing validates both magic bytes and CRC before accepting a frame.

### AudioTransport Protocol

```swift
protocol AudioTransport: AnyObject, Sendable {
    func sendAudio(_ packet: AudioPacket) async
}
```

Decouples audio capture from audio transport/storage. `AudioRelayStage` is the sole implementation today (FRAU over WebSocket). Future implementations could include local recording, Bluetooth direct output, etc.

---

## Audio Codec Type Details

| codecType | Source | Sample Rate | Direction | Capture Method |
|-----------|--------|-------------|-----------|----------------|
| `0` | Phone built-in mic | 48000 Hz | iOS -> Relay | `AVAudioEngine` input tap |
| `1` | Glasses HFP mic | 8000 Hz | iOS -> Relay | `AVAudioEngine` with `.allowBluetooth` routing |
| `2` | TTS playback | ~22050 Hz (device-dependent) | iOS -> Relay | `AVSpeechSynthesizer.write()` PCM in 2048-byte chunks |
| `3` | Relay inbound | 16000 Hz | Relay -> iOS | WebSocket `/tap/audio` (from viewer push-to-talk or AI guidance) |

### Audio Processing Config (Per Source)

Each codecType has independent settings:

| Setting | Type | Default |
|---------|------|---------|
| `gainDb` | Float | 0.0 |
| `noiseGateThreshold` | Float | 0.0 |
| `noiseSuppressionEnabled` | Bool | false |
| `mixEnabled` | Bool | false |
| `mixWeights` | [Float] | [0.5, 0.5] |

---

## Resampling

### WASM Resampler (Rust)

Stateful linear interpolation resampler with cross-chunk phase continuity. Used for:
- 8kHz -> 16kHz (glasses HFP upsampling)
- 16kHz -> 48kHz (mic to AudioContext)
- 48kHz -> 16kHz (browser capture downsampling)

| Property | Value |
|----------|-------|
| Algorithm | Linear interpolation |
| State | `cursor` (fractional position), `frames_seen`, `last_frame` |
| Ratio | `input_rate / output_rate` |
| Cross-chunk continuity | Uses `last_frame` when interpolation position falls before first sample |
| Output clamping | [-32768, 32767] |
| Reset | `reset()` clears all state for stream reconnect |

### Viewer Resampler (TypeScript)

Uses **windowed sinc interpolation with Lanczos window (a = 3)**:

- `lanczos(x, a) = a * sin(PI*x) * sin(PI*x/a) / (PI*x)^2`
- Window size: center +/- 3 input samples (6 samples per output)
- Weights normalized (`sum / weightSum`)
- Input Int16 normalized to Float32 [-1, 1] before interpolation

Push-to-talk path uses naive nearest-neighbor decimation instead (low-latency trade-off for upstream audio).
