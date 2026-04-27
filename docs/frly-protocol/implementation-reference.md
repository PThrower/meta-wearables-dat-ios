# Implementation Reference

Source files, test files, and legacy format documentation.

---

## Source Files

### iOS (Swift)

| File | Role |
|------|------|
| `Pipeline/WireProtocol.swift` | FRLY/FRAU encode + decode, `HeaderBuilder` with LE serialization |
| `Pipeline/CRC16.swift` | CRC-16/CCITT-FALSE checksum |
| `Pipeline/FrameEncoder.swift` | `RelayVideoCodec` enum + `FrameEncoder` protocol + `EncodedFrame` struct |
| `Pipeline/AudioPacket.swift` | Transport-agnostic PCM packet struct |
| `Pipeline/AudioSource.swift` | codecType enum (builtInMic=0, bluetoothHFP=1) |
| `Pipeline/AudioEventBus.swift` | AsyncStream pub/sub, bufferingNewest(10) |
| `Pipeline/AudioTransport.swift` | Protocol interface for audio consumers |
| `Pipeline/AudioProcessingConfig.swift` | Per-source audio config |
| `Pipeline/PCMAudioProcessing.swift` | Stateless noise gate, suppression, gain functions |
| `Pipeline/PCMConvert.swift` | Float32 -> Int16 conversion |
| `Pipeline/RemoteAudioFrame.swift` | JSON audio frame from server |
| `Pipeline/Stages/RelayStage.swift` | Connect, encode, send, reconnect, ping/pong, pacing |
| `Pipeline/Stages/JPEGFrameEncoder.swift` | JPEG encoder (CIContext + CGImageDestination) |
| `Pipeline/Stages/H264FrameEncoder.swift` | H.264 encoder (VTCompressionSession), AVCC->Annex B |
| `Pipeline/Stages/AudioStage.swift` | AVAudioEngine mic capture |
| `Pipeline/Stages/AudioRelayStage.swift` | AudioEventBus subscriber, processing, FRAU encode |
| `Pipeline/Stages/AudioPlaybackStage.swift` | TTS PCM generation (codecType=2) |
| `Pipeline/Stages/AudioTapClient.swift` | Receives JSON audio frames from `/tap/audio` |

### Relay Protocol (TypeScript npm package)

| File | Role |
|------|------|
| `relay-protocol/src/constants.ts` | Magic bytes, header sizes, codec types, CRC offset |
| `relay-protocol/src/types.ts` | Shared TypeScript interfaces |
| `relay-protocol/src/video.ts` | `parseVideoHeader()`, `buildVideoFrame()`, `isVideoFrame()` |
| `relay-protocol/src/audio.ts` | `parseAudioHeader()`, `buildAudioFrame()`, `isAudioFrame()` |
| `relay-protocol/src/crc16.ts` | CRC-16/CCITT-FALSE implementation |
| `relay-protocol/src/backpressure.ts` | Backpressure message type guards and validators |
| `relay-protocol/src/quality.ts` | Quality preset definitions (high/medium/low/mini) |
| `relay-protocol/src/index.ts` | Package barrel export |

### Server (TypeScript, Bun)

| File | Role |
|------|------|
| `server/src/server.ts` | Bun WebSocket relay server, publisher/viewer endpoints |
| `server/src/protocol.ts` | Re-exports from `@ebowwa/relay-protocol` |
| `server/src/audio-tap.ts` | `AudioTapBus` -- dual-mode pub/sub for audio interception |
| `server/src/session-recorder.ts` | MJPEG + PCM recording, manifest, S3/R2 upload |
| `server/src/session-registry.ts` | Session lifecycle, publisher claim, stale cleanup |
| `server/src/types.ts` | Server types, token bucket rate limiter |

### WASM (Rust)

| File | Role |
|------|------|
| `frame-relay-wasm/src/lib.rs` | CRC-16/CCITT-FALSE shared implementation |
| `frame-relay-wasm/src/video.rs` | FRLY encode + decode + CRC verification |
| `frame-relay-wasm/src/audio.rs` | FRAU encode + decode + linear interpolation resampler |
| `frame-relay-wasm/src/mux.rs` | `classify_frame()` by magic bytes |

### Web Viewer (TypeScript)

| File | Role |
|------|------|
| `web-platform/src/player/relay-player.ts` | Main viewer class, FRLY/FRAU decode, A/V sync |
| `web-platform/src/player/frau-builder.ts` | Build FRAU frames from viewer mic capture |
| `web-platform/src/player/resampler.ts` | Windowed sinc Lanczos resampler |
| `web-platform/src/player/audio-worklet.ts` | Ring buffer + AudioWorklet processor |

---

## Test Files

| File | Coverage |
|------|----------|
| `CameraAccessTests/FRLYWireProtocolTests.swift` | FRLY binary layout, round-trip, cross-protocol validation |
| `CameraAccessTests/FRAUWireProtocolTests.swift` | FRAU binary layout, CRC validation |
| `CameraAccessTests/PCMConversionTests.swift` | Float32 to Int16 PCM conversion |
| `CameraAccessTests/MultiSourceAudioTests.swift` | Multi-codecType audio routing |
| `server/test/protocol.test.ts` | Server-side FRLY/FRAU round-trip |
| `server/test/helpers.ts` | Test frame builders |

---

## Legacy 29-Byte Format

The original FRLY protocol used a 29-byte header without version, payload length, or CRC:

| Offset | Size | Field |
|--------|------|-------|
| `[0:4]` | 4B | Magic "FRLY" |
| `[4:12]` | 8B | Sequence (u64 LE) |
| `[12:16]` | 4B | Width (u32 LE) |
| `[16:20]` | 4B | Height (u32 LE) |
| `[20]` | 1B | JPEG quality 0-100 |
| `[21:29]` | 8B | Timestamp ms (u64 LE) |
| `[29:]` | var | JPEG payload |

This format is no longer used in production but remains in test code for backward compatibility.

### Discrepancy Note

The Swift `WireProtocol.buildFRLY` (legacy JPEG-only path) encodes quality as `UInt8(quality * 100)`, giving range 0-100 in byte[25]. The codec-aware `buildVideoFrame` encodes byte[25] as `(codec << 4) | flags`. These two paths produce incompatible byte[25] encodings. The WASM decoder reads byte[25] as a raw quality value, meaning it only correctly interprets frames from the legacy `buildFRLY` path.
