# Wire Format

Binary frame layout for FRLY (video) and FRAU (audio), including CRC-16 integrity and multiplexing.

## FRLY Video Frame (v1)

### Binary Layout

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Magic "FRLY" (4 bytes)                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Version    |               Payload Length (u32 LE)          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                       Sequence Number (u64 LE)                +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   Width (u32 LE)              |   Height ...
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
  ... (u32 LE) |  Codec+Flags  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                       Timestamp ms (u64 LE)                   +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|   Header CRC-16 (u16 LE)     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                         Payload (variable)                    +
|                          JPEG or H.264 NAL units              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### Field Reference

| Offset | Size | Field | Type | Description |
|--------|------|-------|------|-------------|
| `[0:4]` | 4B | Magic | raw bytes | `0x46 0x52 0x4C 0x59` ("FRLY") |
| `[4]` | 1B | Version | u8 | Must be `1` |
| `[5:9]` | 4B | Payload Length | u32 LE | Length of the payload following the header |
| `[9:17]` | 8B | Sequence | u64 LE | Monotonic frame counter (wraps at max) |
| `[17:21]` | 4B | Width | u32 LE | Frame width in pixels |
| `[21:25]` | 4B | Height | u32 LE | Frame height in pixels |
| `[25]` | 1B | Codec+Flags | u8 | Packed codec type and flags (see below) |
| `[26:34]` | 8B | Timestamp | u64 LE | Wall-clock milliseconds since Unix epoch |
| `[34:36]` | 2B | Header CRC-16 | u16 LE | CRC-16/CCITT-FALSE over bytes `[0:34]` |
| `[36:]` | var | Payload | raw bytes | JPEG bytes or H.264 NAL units |

**Total header size: 36 bytes.**

### Byte[25] Codec+Flags Layout

```
 7   6   5   4   3   2   1   0
+---+---+---+---+---+---+---+---+
|  Codec Type  |    Flags       |
+---+---+---+---+---+---+---+---+
  top nibble      bottom nibble
```

#### Video Codec Types (top nibble)

| Value | Codec | Description |
|-------|-------|-------------|
| `0` | JPEG | Every frame is a self-contained keyframe |
| `1` | H.264 | NAL units with periodic keyframes + SPS/PPS |

#### Flags (bottom nibble)

**JPEG codec (type 0):**

| Bits | Field | Range | Description |
|------|-------|-------|-------------|
| `[3:0]` | Quality tier | 0-15 | Mapped from JPEG quality 0.0-1.0 (tier = quality * 16) |

**H.264 codec (type 1):**

| Bit | Flag | Description |
|-----|------|-------------|
| `0` | isKeyframe | This frame is an IDR/keyframe |
| `1` | hasSPSPPS | Payload includes SPS/PPS parameter sets |
| `[3:2]` | reserved | Must be `0` |

### Encoding Example (Swift)

```swift
let codecFlags: UInt8
switch codec {
case .jpeg:
    let tier = UInt8(max(0, min(15, jpegQuality * 16)))
    codecFlags = (codec.rawValue << 4) | (tier & 0x0F)
case .h264:
    var flags: UInt8 = 0
    if isKeyframe { flags |= 0x01 }
    if hasParameterSets { flags |= 0x02 }
    codecFlags = (codec.rawValue << 4) | (flags & 0x0F)
}
```

### Decoding Example (TypeScript)

```typescript
const codecFlags = buf[25];
const codecType = (codecFlags >> 4) & 0x0F;  // 0=JPEG, 1=H.264
const flags = codecFlags & 0x0F;

const isKeyframe = codecType === 1
  ? (flags & 0x01) !== 0
  : true;  // JPEG: every frame is a keyframe

const hasParameterSets = codecType === 1
  ? (flags & 0x02) !== 0
  : false;
```

---

## FRAU Audio Frame (v1)

### Binary Layout

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Magic "FRAU" (4 bytes)                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|    Version    |               Payload Length (u32 LE)          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Codec Type   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                       Sequence Number (u64 LE)                +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|               Sample Rate (u32 LE)            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Channels     | Bits/Sample   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                       Timestamp ms (u64 LE)                   +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|   Header CRC-16 (u16 LE)     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                     PCM Payload (variable)                    +
|                     16-bit signed LE mono PCM                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### Field Reference

| Offset | Size | Field | Type | Description |
|--------|------|-------|------|-------------|
| `[0:4]` | 4B | Magic | raw bytes | `0x46 0x52 0x41 0x55` ("FRAU") |
| `[4]` | 1B | Version | u8 | Must be `1` |
| `[5:9]` | 4B | Payload Length | u32 LE | Length of PCM data |
| `[9]` | 1B | Codec Type | u8 | Audio source identifier (see below) |
| `[10:18]` | 8B | Sequence | u64 LE | Monotonic frame counter |
| `[18:22]` | 4B | Sample Rate | u32 LE | Hardware sample rate in Hz |
| `[22:24]` | 2B | Channels | u16 LE | Channel count (always 1 = mono) |
| `[24:26]` | 2B | Bits/Sample | u16 LE | Always 16 (signed LE) |
| `[26:34]` | 8B | Timestamp | u64 LE | Wall-clock milliseconds since Unix epoch |
| `[34:36]` | 2B | Header CRC-16 | u16 LE | CRC-16/CCITT-FALSE over bytes `[0:34]` |
| `[36:]` | var | PCM Payload | raw bytes | 16-bit signed little-endian mono PCM |

**Total header size: 36 bytes.**

### Audio Codec Types

| codecType | Source | Sample Rate | Direction | Description |
|-----------|--------|-------------|-----------|-------------|
| `0` | Phone built-in mic | 48000 Hz | iOS -> Relay | Hardware mic via AVAudioEngine |
| `1` | Glasses HFP mic | 8000 Hz | iOS -> Relay | Bluetooth HFP, beamformed for wearer voice |
| `2` | TTS playback | ~22050 Hz | iOS -> Relay | AVSpeechSynthesizer PCM output |
| `3` | Relay inbound | 16000 Hz | Relay -> iOS | Server-to-publisher / viewer-to-publisher audio |

---

## CRC-16 Integrity

Both FRLY and FRAU use CRC-16/CCITT-FALSE for header integrity.

### Algorithm Parameters

| Parameter | Value |
|-----------|-------|
| Polynomial | `0x1021` |
| Init | `0xFFFF` |
| Reflect input | No |
| Reflect output | No |
| Final XOR | `0x0000` |
| Coverage | Bytes `[0:34]` (everything before the CRC field) |
| CRC position | Bytes `[34:36]` (u16 LE) |

### Reference Implementation (Swift)

```swift
static func ccittFalse(_ data: Data, offset: Int = 0, length: Int? = nil) -> UInt16 {
    let len = length ?? (data.count - offset)
    var crc: UInt16 = 0xFFFF
    for i in offset..<(offset + len) {
        crc ^= UInt16(data[i]) << 8
        for _ in 0..<8 {
            crc = (crc & 0x8000) != 0 ? (crc << 1) ^ 0x1021 : crc << 1
        }
    }
    return crc
}
```

### Reference Implementation (TypeScript)

```typescript
export function crc16(buf: Uint8Array, offset = 0, length?: number): number {
  const len = length ?? (buf.length - offset);
  let crc = 0xFFFF;
  for (let i = offset; i < offset + len; i++) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}
```

### Validation

Decoders compute CRC-16 over bytes `[0:34]` and compare against the stored value at `[34:36]`. Frames with mismatched CRC are discarded. Payload integrity is provided by the codec itself (JPEG/H.264 markers, PCM framing).

---

## Multiplexing

FRLY and FRAU frames are interleaved on a single WebSocket connection. Classification by magic bytes:

```
buf[0] == 0x46 ('F')  &&  buf[1] == 0x52 ('R')
  buf[2] == 0x4C ('L') -> FRLY (video)
  buf[2] == 0x41 ('A') -> FRAU (audio)
  otherwise            -> unknown, discard
```

### Frame Classification (Rust/WASM)

The WASM implementation checks all 4 bytes of the magic, not just 3:

```rust
const FRAME_UNKNOWN: u8 = 0;
const FRAME_VIDEO: u8  = 1;
const FRAME_AUDIO: u8  = 2;

pub fn classify_frame(buf: &[u8]) -> u8 {
    if buf.len() < 4 { return FRAME_UNKNOWN; }
    match &buf[0..4] {
        b"FRLY" => FRAME_VIDEO,
        b"FRAU" => FRAME_AUDIO,
        _ => FRAME_UNKNOWN,
    }
}
```

### Structural Validation (WASM)

`validate_frame()` checks structure only -- it does NOT verify CRC:

```rust
pub fn validate_frame(buf: &[u8]) -> bool {
    if buf.len() < 4 { return false; }
    match &buf[0..4] {
        m if m == b"FRLY" => buf.len() >= 36,
        m if m == b"FRAU" => buf.len() >= 36,
        _ => false,
    }
}
```

### No Fragmentation

Each WebSocket binary message is exactly one complete frame. There is no fragmentation, no continuation mechanism, and no reassembly buffer. The `payloadLength` field in the header tells the decoder where the frame ends. Truncated frames (buffer shorter than header + payload) are silently discarded.

---

## Cross-Implementation Inconsistencies

### Version Validation

| Implementation | Version Check | Behavior |
|---|---|---|
| Swift `parseFRAU()` / `parseFRLYCodec()` | Rejects != 1 | Returns nil |
| TypeScript `parseVideoHeader()` / `parseAudioHeader()` | Rejects != 1 | Returns null |
| Rust/WASM `decode_frame_prefix()` / `decode_audio_header()` | Reads but does NOT reject | Returns any version value |

The WASM decoder accepts any version silently. Only Swift and TypeScript enforce version 1.

### Payload Length Bounds Checking

| Implementation | Checks payload length against buffer size |
|---|---|
| Swift `parseFRAU()` | Yes: `guard pcmEnd <= data.count` |
| TypeScript `parseAudioHeader()` | No: returns `buf.subarray(AUDIO_HEADER_SIZE)` regardless |
| TypeScript `parseVideoHeader()` | No: returns `payloadLength` from header without validation |

### codecType Validation

| Implementation | Validates codecType range |
|---|---|
| TypeScript `parseAudioHeader()` | Rejects unknown values (must be 0-3) |
| Swift `parseFRAU()` | Reads raw byte, no range check |
| Rust/WASM `decode_audio_header()` | Reads raw byte, no range check |

---

## Intermediate Data Structures

### AudioPacket (Swift, Transport-Agnostic)

The `AudioPacket` struct decouples PCM data from the wire format. Wire protocol encoding (FRAU) is the subscriber's responsibility.

```swift
struct AudioPacket: Sendable {
    let pcmData: Data           // Raw 16-bit LE mono PCM
    let codecType: UInt8        // 0=phone, 1=HFP, 2=TTS, 3=inbound
    let sampleRate: UInt32      // Hardware sample rate in Hz
    let channels: UInt16        // Always 1
    let bitsPerSample: UInt16   // Always 16
    let sequenceNumber: UInt64  // Monotonic from AudioStage
    let timestampMs: UInt64     // Wall-clock ms since epoch
}
```

### RemoteAudioFrame (JSON, /tap/audio endpoint)

Audio frames from the relay gateway's `/tap/audio` WebSocket arrive as JSON (not binary FRAU). PCM is base64-encoded:

```json
{
  "type": "audio",
  "codecType": 0,
  "sequence": 12345,
  "sampleRate": 48000,
  "channels": 1,
  "bitsPerSample": 16,
  "timestampMs": 1700000000123,
  "pcmBase64": "base64-encoded PCM data"
}
```

Validation: `pcmBase64` must be non-empty, base64 decoding must succeed, decoded data must be non-empty. Returns nil on any failure.

### VideoHeader (TypeScript, Parsed)

The TypeScript parser returns a `VideoHeader` with additional convenience fields beyond the raw header:

```typescript
interface VideoHeader {
  version: number;
  payloadLength: number;
  sequence: number;
  width: number;
  height: number;
  codecFlags: number;      // Raw byte[25]
  codecType: number;       // Top nibble: 0=JPEG, 1=H.264
  flags: number;           // Bottom nibble
  isKeyframe: boolean;     // H.264: bit0 check. JPEG: always true
  hasParameterSets: boolean; // H.264: bit1 check. JPEG: always false
  quality: number;         // Raw byte[25] (backward compat alias)
  timestampMs: number;
}
```

### WASM FrameHeader (Rust)

The WASM decoder uses `quality` (raw byte[25]) rather than splitting into codec/flags. Callers must split the nibble themselves:

```rust
struct FrameHeader {
    version: u8,
    payload_length: u32,
    sequence: u64,
    width: u32,
    height: u32,
    quality: u8,             // Raw byte[25] -- not split into codec/flags
    timestamp_ms: u64,
}
```

---

## Swift Builder API

### HeaderBuilder (WireProtocol.HeaderBuilder)

The `WireProtocol` enum provides a fluent `HeaderBuilder` for constructing frames:

```swift
var h = HeaderBuilder(capacity: 36)  // Pre-allocates 36 bytes
h.appendMagic([0x46, 0x52, 0x4C, 0x59])  // Returns Self for chaining
h.appendUInt8(1)                           // version
h.appendUInt32(UInt32(payload.count))      // payloadLen
h.appendUInt64(sequenceNumber)
h.appendUInt32(UInt32(width))
h.appendUInt32(UInt32(height))
h.appendUInt8(codecFlags)                  // byte[25]
h.appendUInt64(UInt64(Date().timeIntervalSince1970 * 1000))
var header = h.finalizeWithCRC()           // Appends CRC-16, returns Data
```

Primitive writers use `withUnsafeBytes(of:)` for LE serialization (Swift is natively little-endian on ARM64).

### Data LE Extraction Helpers

Swift extends `Data` with offset-based LE readers:

```swift
extension Data {
    func extractUInt16(at offset: Int) -> UInt16
    func extractUInt32(at offset: Int) -> UInt32
    func extractUInt64(at offset: Int) -> UInt64
}
```

These copy bytes from the offset into a native-endian value via `withUnsafeMutableBytes`.

---

## WASM Helper Functions

### Video (frame-relay-wasm/src/video.rs)

| Function | Description |
|---|---|
| `is_video_frame(buf)` | Checks first 4 bytes == "FRLY" |
| `decode_frame_prefix(buf)` | Parses 36-byte header, returns `FrameHeader` (no CRC check) |
| `encode_frame_prefix(header)` | Encodes 36-byte header only (no payload) |
| `encode_video_frame(...)` | Encodes complete frame (header + payload) |
| `extract_video_payload(buf)` | Returns bytes after header (empty vec if len <= 36) |
| `verify_video_crc(buf)` | Validates CRC-16 over header |

### Audio (frame-relay-wasm/src/audio.rs)

| Function | Description |
|---|---|
| `is_audio_frame(buf)` | Checks first 4 bytes == "FRAU" |
| `decode_audio_header(buf)` | Parses 36-byte header (no version check) |
| `encode_audio_frame(...)` | Encodes complete FRAU frame |
| `extract_audio_payload(buf)` | Returns bytes after header (empty vec if len <= 36) |
| `verify_audio_crc(buf)` | Validates CRC-16 over header |

### Throttle (frame-relay-wasm/src/throttle.rs)

Quality presets used by the WASM throttle module:

| Preset | Max FPS |
|---|---|
| HIGH | 30 |
| MEDIUM | 15 |
| LOW | 8 |
| MINI | 4 |

The `FrameRelay` struct tracks `frames_received`, `frames_relayed`, `frames_dropped`, and uses `should_relay(now_ms)` as a throttle gate dropping frames if interval < `min_interval_ms`.

---

## Frame Timing (TypeScript)

The relay-protocol package includes a frame timing monitor:

```typescript
interface FrameTiming {
  lastSequence: number;
  lastTimestampMs: number;
  lastReceivedAt: number;
  jitterMs: number;
  fps: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  droppedFrames: number;
}
```

`updateTiming()` computes EMA-based FPS with alpha 0.9/0.1 (heavier smoothing than the iOS encoder's 0.3), tracks jitter, detects dropped frames via sequence gaps, and skips same-tick frames (interval=0) to avoid Infinity FPS.
