# Video Codecs

Encoder configurations, adaptive quality algorithms, NAL unit formatting, relay telemetry, and wire protocol details for FRLY video frames.

---

## JPEG (Codec Type 0)

### Encoder Configuration

| Property | Value |
|----------|-------|
| Class | `JPEGFrameEncoder` (conforms to `FrameEncoder`) |
| Acceleration | Hardware GPU via `CIContext` (YUV-to-RGB) + `CGImageDestination` (ImageIO C API, no UIKit) |
| CIContext options | `[.useSoftwareRenderer: false]` -- forces GPU-accelerated rendering |
| Quality range | 0.2 (`minQuality`) to 0.8 (`maxQuality`) -- clamped by `clampQuality()` |
| Default quality | 0.5 |
| Keyframes | Every frame is a self-contained keyframe (`isKeyframe: true`) |
| Parameter sets | Never attached (`hasParameterSets: false`) |
| Wire encoding | Quality mapped to 4-bit tier (0-15): `tier = UInt8(quality * 16)` |
| Thread safety | `@unchecked Sendable` -- CIContext is shared, no mutable state races |

### clampQuality() Public API

```swift
func clampQuality(_ value: CGFloat) -> CGFloat
```

Clamps any quality value to the valid `[0.2, 0.8]` range. Called by `RelayStage` during adaptive quality adjustment. This is the single gateway for quality validation -- the encoder never applies unclamped values.

### Encoding Pipeline

1. `CVPixelBuffer` -> `CIImage(cvPixelBuffer:)` -- wraps pixel buffer
2. `CIContext.createCGImage(_:from:)` -- GPU YUV-to-RGB conversion, crops to `[width x height]` rect
3. `CGImageDestinationCreateWithData` with `UTType.jpeg.identifier` -- creates mutable `CFData` destination
4. `CGImageDestinationAddImage` with `kCGImageDestinationLossyCompressionQuality: currentQuality`
5. `CGImageDestinationFinalize` -- produces final JPEG bytes
6. Returns `EncodedFrame` with the JPEG `Data` payload

### destroy()

No-op. The `CIContext` is held as a property but shared across the encoder lifetime -- no teardown required.

---

### Adaptive Quality Algorithm

The JPEG encoder adapts quality based on encode time feedback to maintain target FPS. Quality adaptation is driven by `RelayStage.updateEncodeTime()`, NOT by the encoder itself.

**EMA encode time** (alpha = 0.3):
```
ema = 0.3 * newSample + 0.7 * previousEma
```

**EMA initialization**: The first sample is set directly with no smoothing. `encodeTimeEmaMs` starts as `nil` and on the first call to `updateEncodeTime()`, it is set to the raw `encodeMs` value. Subsequent samples use the EMA formula.

**Frame budget**: `1000 / effectiveTargetFps` ms

| Condition | Action |
|-----------|--------|
| EMA > budget * 1.2 (too slow) | `quality *= 0.95`, then `clampQuality()` |
| EMA < budget * 0.8 (headroom) | `quality *= 1.02`, then `clampQuality()` |
| Result | Clamped to [0.2, 0.8] via `JPEGFrameEncoder.clampQuality()` |

Quality is only adapted when `encoder is? JPEGFrameEncoder` -- H.264 gets encode time tracking but no quality adjustment.

---

## H.264 (Codec Type 1)

### Encoder Configuration

| Property | Value |
|----------|-------|
| Class | `H264FrameEncoder` (conforms to `FrameEncoder`) |
| Framework | VideoToolbox `VTCompressionSession` |
| Profile/Level | `kVTProfileLevel_H264_Baseline_AutoLevel` |
| Real-time | `true` (`kVTCompressionPropertyKey_RealTime`) |
| Average bitrate | 750,000 bps (~750 kbps) (`kVTCompressionPropertyKey_AverageBitRate`) |
| Keyframe interval | 30 frames (`kVTCompressionPropertyKey_MaxKeyFrameInterval`) |
| Expected FPS | 15 (`kVTCompressionPropertyKey_ExpectedFrameRate` -- hint for rate control) |
| Frame reordering | `false` (`kVTCompressionPropertyKey_AllowFrameReordering` -- no B-frames) |
| Power efficiency | `true` (`kVTCompressionPropertyKey_MaximizePowerEfficiency`) |
| Pixel format | `kCVPixelFormatType_420YpCbCr8BiPlanarFullRange` (full-range YUV 4:2:0 biplanar) |
| Bitrate control | Average bit rate mode only (`kVTCompressionPropertyKey_AverageBitRate`). No data rate limit or quality limit is set. The encoder targets 750 kbps average. |
| Thread safety | `@unchecked Sendable` with `NSLock` protecting `_pendingFrame` |

### H264EncoderConfig

```swift
struct H264EncoderConfig: Sendable {
    let bitrate: Int           // Default: 750_000
    let keyframeInterval: Int  // Default: 30
    let expectedFPS: Int       // Default: 15

    static let `default` = H264EncoderConfig(bitrate: 750_000, keyframeInterval: 30, expectedFPS: 15)
}
```

### H264EncoderError Enum

| Case | Trigger |
|------|---------|
| `.sessionCreateFailed(OSStatus)` | `VTCompressionSessionCreate` returned non-`noErr` |
| `.prepareFailed(OSStatus)` | `VTCompressionSessionPrepareToEncodeFrames` returned non-`noErr` |

Both cases carry the `OSStatus` for diagnostics. The error conforms to `LocalizedError` with descriptive messages.

### NSLock Threading Model

The H.264 encoder uses a single `NSLock` to protect the pipeline state:

- **Callback writes**: The `VTCompressionOutputCallback` acquires `lock` before writing to `_pendingFrame`, then releases it.
- **encode() reads**: The `encode()` method acquires `lock` to read and clear `_pendingFrame`, then releases it.
- **Dimension change**: When dimensions change, `lock` is acquired to clear `_pendingFrame` before session recreation.
- **destroy()**: Acquires `lock` to clear `_pendingFrame` during teardown.

The lock is never held during encoding operations (`VTCompressionSessionEncodeFrame`) -- only during the pointer swap of the pending frame reference. This prevents blocking the VideoToolbox callback thread.

### Session Lifecycle

1. **Lazy creation**: Session is created on the first `encode()` call using actual pixel buffer dimensions. `VTCompressionSession` requires valid dimensions at creation time; placeholder dimensions (e.g. 1x1) cause all callbacks to return errors.
2. **Property configuration**: After creation, six properties are set (profile, real-time, bitrate, keyframe interval, expected FPS, frame reordering, power efficiency), then `VTCompressionSessionPrepareToEncodeFrames()` is called.
3. **Dimension change detection**: If `width != lastWidth || height != lastHeight`, the session is invalidated and recreated with the new dimensions. `_pendingFrame` is cleared and `frameCount` is reset to 0.
4. **Encoded dimensions**: Extracted from `CMVideoFormatDescriptionGetDimensions(formatDescription)` on the output `CMSampleBuffer` -- these are the actual encoded dimensions, which may differ from input dimensions after codec alignment.

### 1-Frame Pipeline Delay

The encoder uses a non-blocking pipeline with 1-frame delay:

1. The C-style `VTCompressionOutputCallback` stores the encoded frame in `_pendingFrame` (protected by `NSLock`).
2. `encode()` returns the **previously** stored frame, then submits the current pixel buffer for encoding.
3. For the **first frame** (`frameCount == 0` and `result == nil`), it checks synchronously whether the callback already deposited a frame -- some hardware encoders return synchronously for frame 0.

**PTS construction**: `CMTime(seconds: Double(frameCount) / Double(config.expectedFPS), preferredTimescale: 1000)`

**Duration construction**: `CMTime(seconds: 1.0 / Double(config.expectedFPS), preferredTimescale: 1000)`

For a 15 FPS config: PTS advances by 66.67ms per frame, duration is 66.67ms.

### forceKeyframe() API

```swift
func forceKeyframe()
```

Sets an internal `keyframeRequested` flag. The next call to `encode()` checks three conditions for keyframe generation:

1. `keyframeRequested == true` (explicit request via this API)
2. `frameCount == 0` (first frame of session)
3. `frameCount % config.keyframeInterval == 0` (periodic keyframe)

If any condition is true, `kVTEncodeFrameOptionKey_ForceKeyFrame: true` is passed in `frameProperties` to `VTCompressionSessionEncodeFrame`. The flag is consumed (reset to `false`) after each encode.

This API has a default no-op implementation in the `FrameEncoder` protocol extension, so JPEG encoders ignore it.

### destroy() Cleanup Sequence

```swift
func destroy()
```

Executes the following in order:
1. `VTCompressionSessionInvalidate(session)` -- releases the hardware encoder session
2. `session = nil` -- clears the reference
3. `frameCount = 0` -- resets frame counter
4. `keyframeRequested = false` -- clears any pending keyframe request
5. `lastWidth = 0`, `lastHeight = 0` -- resets dimension tracking (forces session recreation on next encode)
6. `lock.lock()` / `_pendingFrame = nil` / `lock.unlock()` -- clears any buffered pipeline frame

After `destroy()`, the encoder is in the same state as a fresh `init()`.

### NAL Unit Formatting (AVCC to Annex B)

VTCompressionSession outputs in **AVCC format** (4-byte big-endian length prefix per NAL unit). The encoder converts to **Annex B** for wire transmission:

**`convertAVCCToAnnexB(_ avccData: Data) -> Data`**:
1. Read 4-byte big-endian `UInt32` NAL length at current offset
2. Advance offset by 4
3. Guard that `offset + nalLength <= avccData.count` (bounds check)
4. Write start code `0x00 0x00 0x00 0x01`
5. Copy NAL bytes from `avccData[offset..<(offset + Int(nalLength))]`
6. Advance offset by `nalLength`
7. Repeat until fewer than 4 bytes remain

**`extractNALUnits(from:isKeyframe:)`**:
1. Extract raw block buffer data from `CMSampleBuffer`
2. Convert AVCC to Annex B
3. For keyframes only: iterate `CMVideoFormatDescriptionGetH264ParameterSetAtIndex` to extract SPS/PPS parameter sets, each prefixed with `0x00 0x00 0x00 0x01`, then append the converted NAL data
4. Extract actual encoded dimensions from `CMVideoFormatDescriptionGetDimensions(formatDescription)`

**Wire format for H.264 in FRLY payload:**
- Keyframes: `[SPS start code + SPS] [PPS start code + PPS] [IDR start code + IDR slice]`
- P-frames: `[slice start code + slice data]`

### Wire Flags

| Flag | Bit | Description |
|------|-----|-------------|
| `isKeyframe` | 0 (bit 0) | IDR frame |
| `hasSPSPPS` | 1 (bit 1) | Payload includes parameter sets (SPS/PPS prepended) |

Both flags are packed into the bottom nibble of byte[25] in the FRLY header. Set in `WireProtocol.buildVideoFrame()`:
```swift
if isKeyframe { flags |= 0x01 }
if hasParameterSets { flags |= 0x02 }
codecFlags = (codec.rawValue << 4) | (flags & 0x0F)
```

---

## FrameEncoder Protocol

The `FrameEncoder` protocol abstracts encoding so `RelayStage` delegates without knowing the codec:

```swift
protocol FrameEncoder: Sendable {
    var codec: RelayVideoCodec { get }
    func encode(_ pixelBuffer: CVPixelBuffer, width: Int, height: Int) -> EncodedFrame?
    func forceKeyframe()   // Default no-op in protocol extension
    func destroy()
}
```

### RelayVideoCodec Enum

| Raw Value | Case | Display Name |
|-----------|------|--------------|
| 0 | `.jpeg` | "JPEG" |
| 1 | `.h264` | "H.264" |

Conforms to `UInt8`, `CaseIterable`, `Sendable`.

### EncodedFrame Struct

```swift
struct EncodedFrame: Sendable {
    let payload: Data              // Compressed JPEG bytes or H.264 NAL units
    let isKeyframe: Bool           // Self-contained frame (every JPEG, H.264 IDR)
    let hasParameterSets: Bool     // SPS/PPS included (H.264 keyframes only)
    let width: Int                 // Actual encoded width
    let height: Int                // Actual encoded height
}
```

---

## Wire Protocol (FRLY v1)

### FRLY Header Layout (36 bytes)

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 4 | Magic | `0x46 0x52 0x4C 0x59` ("FRLY") |
| 4 | 1 | Version | `1` |
| 5 | 4 | Payload length | `UInt32` LE -- byte count of the payload following the header |
| 9 | 8 | Sequence number | `UInt64` LE -- monotonically increasing frame counter |
| 13 | 4 | Width | `UInt32` LE -- encoded frame width |
| 17 | 4 | Height | `UInt32` LE -- encoded frame height |
| 21 | 1 | Codec + flags | Top nibble: codec type (0=JPEG, 1=H.264). Bottom nibble: codec-specific flags |
| 22 | 8 | Timestamp | `UInt64` LE -- epoch milliseconds at send time |
| 30 | 2 | CRC-16 | CRC-16/CCITT-FALSE over bytes [0..<30] |
| 32+ | N | Payload | JPEG or H.264 Annex B NAL data |

All multi-byte fields are **little-endian**.

### Codec+Flags Byte (offset 21)

**JPEG**:
```
Byte = (0 << 4) | (quality_tier & 0x0F)
quality_tier = UInt8(clamping: quality * 16)  // maps 0.0-1.0 to 0-15
```

**H.264**:
```
Byte = (1 << 4) | (flags & 0x0F)
bit 0: isKeyframe
bit 1: hasSPSPPS
```

### Parsing

`WireProtocol.parseFRLYCodec(_:)` validates:
- Minimum 36 bytes
- Magic bytes match `[0x46, 0x52, 0x4C, 0x59]`
- Extracts codec from top nibble of byte[25], flags from bottom nibble

---

## RelayStage

`RelayStage` is a Swift `actor` that orchestrates encoding, wire protocol framing, WebSocket transport, keepalive, backpressure, reconnection, and telemetry. Runs on its own actor executor -- never blocks the main thread.

### Connection Lifecycle

1. `connect(to:)` creates a `URLSessionWebSocketTask` with a delegate pattern (`RelayWebSocketDelegate`).
2. Connection has a 5-second timeout via `Task.sleep`.
3. On success: sends `sendHello()`, starts receive loop, starts keepalive ping loop.
4. Auto-reconnect on disconnect with exponential backoff (1s initial, 30s max, doubles each attempt).
5. `disconnect()` cancels all tasks, invalidates session, clears state.

### sendHello() Complete Field List

Sent as JSON immediately after WebSocket opens. All actor-isolated values are captured before dispatching to `@MainActor` for `UIDevice` reads:

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `type` | String | Literal `"hello"` | Message type discriminator |
| `deviceId` | String | `UIDevice.current.identifierForVendor?.uuidString` | iOS device vendor UUID (persists per app install) |
| `deviceName` | String | `UIDevice.current.name` | User-assigned device name |
| `deviceModel` | String | `utsname.machine` via `hardwareModelIdentifier()` | Hardware model identifier (e.g. "iPhone14,4") |
| `systemVersion` | String | `UIDevice.current.systemVersion` | iOS version string (e.g. "17.4") |
| `wearableId` | String | `self.wearableId ?? ""` | Connected wearable device ID from DAT SDK |
| `wearableType` | String | `self.wearableType ?? ""` | Connected wearable device type (e.g. "rayban-meta") |
| `appVersion` | String | `Bundle.main.infoDictionary["CFBundleShortVersionString"]` | App version (e.g. "1.2.0") |
| `buildNumber` | String | `Bundle.main.infoDictionary["CFBundleVersion"]` | Build number (e.g. "42") |
| `batteryLevel` | Float | `UIDevice.current.batteryLevel` | Device battery level (0.0-1.0) |
| `batteryState` | String | `UIDevice.current.batteryState` | One of: "unplugged", "charging", "full", "unknown" |
| `lowPowerMode` | Bool | `ProcessInfo.processInfo.isLowPowerModeEnabled` | Whether Low Power Mode is active |
| `videoCodec` | UInt8 | `encoder.codec.rawValue` | Active video codec (0=JPEG, 1=H.264) |

The server stores this on the Publisher object and exposes it via the `/stats` endpoint.

### Inbound FRAU Audio Handling

The receive loop handles binary messages from the server:

1. Binary data is checked with `WireProtocol.parseFRAU(data)` to determine if it is a FRAU audio frame.
2. If it parses as FRAU, `inboundAudioCount` is incremented and the raw `Data` is forwarded to the `onReceivedAudio` callback.
3. The `onReceivedAudio` callback is set by `StreamSessionViewModel` via `setOnReceivedAudio(_:)` before connecting, dispatching to the `AudioEventBus`.
4. Non-FRAU binary data is logged but not processed.

Log throttling for inbound audio: first 3 frames logged unconditionally, then every 100th frame (`inboundAudioCount % 100 == 0`).

### Server Backpressure

When the server sends a JSON message with `type: "backpressure"` and `targetFps`, RelayStage:

1. Stores the value in `serverTargetFps`
2. Resets `lastRelayTime` to `nil` so the new rate takes effect immediately on the next frame
3. Sends a `backpressure-ack` JSON response back to the server:
   ```json
   {
     "type": "backpressure-ack",
     "targetFps": <echoed value>
   }
   ```
4. The ack is sent via `sendJson()` which serializes to a WebSocket text message.

`serverTargetFps` overrides all local FPS calculations when set (see Effective FPS Priority Chain below).

### claimSequence() Guard Logic

```swift
private func claimSequence(_ seq: UInt64) -> UInt64 {
    if seq > sequenceNumber {
        sequenceNumber = seq
    }
    return sequenceNumber
}
```

The guard prevents sequence number regression from failed encodes. Sequence is "peeked" before encoding (`nextSeq = sequenceNumber + 1`) and only "claimed" after successful encode. If encode fails, `sequenceNumber` is not incremented, so the next successful encode reuses the same sequence number. The `>` guard also prevents races if multiple concurrent paths reach `claimSequence`.

### EMA Initialization (First Sample)

`encodeTimeEmaMs` starts as `nil`. The first call to `updateEncodeTime(_:)` sets it directly to the raw encode time with **no smoothing**:

```swift
if let ema = encodeTimeEmaMs {
    encodeTimeEmaMs = encodeTimeAlpha * encodeMs + (1 - encodeTimeAlpha) * ema
} else {
    encodeTimeEmaMs = encodeMs  // First sample: set directly, no smoothing
}
```

This avoids the cold-start problem where a zero-initialized EMA would underweight the first real measurement.

### Log Throttling Constants

| Log Event | Throttle Pattern | Constants |
|-----------|-----------------|-----------|
| Send success stats | Every 50th frame | `framesSent % 50 == 1` |
| Send errors | Every 10th error | `framesFailed % 10 == 1` |
| Pacing drops | Every 500th drop | `framesDroppedByPacing % 500 == 1` |
| Inbound audio | First 3, then every 100th | `count <= 3 \|\| count % 100 == 0` |
| Quality adaptation | On change > 0.01 | `abs(newQuality - oldQuality) > 0.01` |

### getStats() Telemetry -- All 11 Fields

`RelayStage.getStats()` returns a dictionary with these fields for telemetry push to viewers:

| Field | Type | Description |
|-------|------|-------------|
| `framesSent` | `UInt64` | Total frames successfully sent over WebSocket |
| `totalBytesSent` | `UInt64` | Cumulative bytes sent (header + payload) |
| `framesFailed` | `UInt64` | Frames that failed to send (WebSocket errors) |
| `framesDropped` | `UInt64` | Total frames dropped (pacing + backpressure) |
| `framesDroppedByPacing` | `UInt64` | Frames dropped due to time-based throttle exceeding target FPS |
| `framesDroppedByBackpressure` | `UInt64` | Frames dropped due to server backpressure (currently tracked but not incremented separately -- reserved for future use) |
| `encodeTimeEmaMs` | `Double` | Exponential moving average of encode time in milliseconds (0 if no samples yet) |
| `adaptiveQuality` | `CGFloat` | Current JPEG adaptive quality (0.2-0.8) |
| `videoCodec` | `UInt8` | Active codec raw value (0=JPEG, 1=H.264) |
| `latencyMs` | `Double` | WebSocket ping/pong RTT in milliseconds (0 if no measurement yet) |
| `lastFrameSizeBytes` | `Int` | Size in bytes of the most recently sent frame (header + payload) |
| `avgFrameSizeBytes` | `Int` | Average frame size: `totalBytesSent / framesSent` (0 if no frames sent) |

Note: The dictionary contains 12 keys (including `avgFrameSizeBytes` as a computed field). The `framesDroppedByBackpressure` counter is tracked but not currently incremented in the pacing code path -- it is reserved for future server-driven drop counting.

---

## Effective FPS Priority Chain

The publisher computes `effectiveTargetFps` from three sources, in priority order:

1. **Server backpressure** (always wins if set): `serverTargetFps` from `{"type": "backpressure", "targetFps": N}`
2. `min(configured target, hardware cap)`
3. **Configured target** (default from `FrameStageConfig.targetFPS`, falls back to 30 fps)

Where **hardware cap** = `1000 / (encodeTimeEma * 1.1)` -- 10% headroom above theoretical max throughput.

When EMA has no samples (`nil`), the hardware cap is not applied and only the configured target is used. Server backpressure also resets `lastRelayTime` to `nil` so the new rate takes effect immediately without waiting for the next pacing interval.

### Frame Pacing Gate

Frame pacing is time-based (not counter-based). Before each frame:

```
elapsed = now - lastRelayTime
minInterval = 1.0 / effectiveTargetFps
if elapsed < minInterval -> drop frame
```

This produces evenly-spaced output regardless of encode duration variance. Dropped frames increment both `framesDropped` and `framesDroppedByPacing`.

### Encoding Concurrency Guard

A single `isEncoding` boolean prevents unbounded concurrent encodes. If the previous `Task.detached` encode is still running when a new frame arrives, the frame is silently dropped (no counter increment). This prevents memory pressure from queued pixel buffers during slow encode periods.

---

## Keepalive and Latency Measurement

- **Ping interval**: Every 5 seconds via `URLSessionWebSocketTask.sendPing()`
- **Latency measurement**: `lastPingStart` is recorded before each ping. On pong receipt, RTT is computed as `pongTime - pingStart` using `ContinuousClock.Instant` arithmetic.
- **Latency conversion**: `Double(seconds) * 1000.0 + Double(attoseconds) / 1_000_000_000_000_000.0` yields milliseconds.
- **Ping failure**: Marks the connection as disconnected and triggers auto-reconnect.

---

## FRAU (Audio) Wire Protocol

FRAU is the companion audio wire protocol, sharing the same framing pattern as FRLY.

### FRAU Header Layout (36 bytes)

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 4 | Magic | `0x46 0x52 0x41 0x55` ("FRAU") |
| 4 | 1 | Version | `1` |
| 5 | 4 | Payload length | `UInt32` LE |
| 9 | 1 | Codec type | Source identifier (0=phone mic, 1=glasses HFP, 2=TTS) |
| 10 | 8 | Sequence number | `UInt64` LE |
| 18 | 4 | Sample rate | `UInt32` LE (e.g. 48000, 16000, 22050) |
| 22 | 2 | Channels | `UInt16` LE (1 for mono) |
| 24 | 2 | Bits per sample | `UInt16` LE (16 for PCM) |
| 26 | 8 | Timestamp | `UInt64` LE -- epoch milliseconds |
| 34 | 2 | CRC-16 | CRC-16/CCITT-FALSE over bytes [0..<34] |
| 36+ | N | PCM payload | Raw PCM audio data |

### FRAU Parsing

`WireProtocol.parseFRAU(_:)` validates:
- Minimum 36 bytes
- Magic bytes match `[0x46, 0x52, 0x41, 0x55]`
- CRC-16/CCITT-FALSE over bytes [0..<34] matches bytes [34..<36]
- Version byte equals `1`
- Payload length does not exceed remaining data

Returns a tuple with all header fields plus the PCM payload `Data`.

### Inbound FRAU in RelayStage

Server-to-publisher FRAU frames are detected in the receive loop by checking `WireProtocol.parseFRAU(data) != nil`. Matched frames are forwarded to `onReceivedAudio` callback. Log output is throttled: first 3 frames unconditionally, then every 100th frame.
