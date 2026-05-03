# FRLY Binary Streaming Protocol

**Version:** 1
**Last Updated:** 2026-04-22
**Status:** Production

## Overview

FRLY (Frame ReLaY) is a binary wire protocol for real-time streaming of encoded video and audio frames over WebSocket. It is the transport layer for the caringmind-frame-relay system, carrying live camera feeds from Meta Ray-Ban glasses through an iOS app to a Bun relay server and browser viewers.

The protocol multiplexes two frame types on a single WebSocket connection using 4-byte magic headers:

| Magic | Type | ASCII | Purpose |
|-------|------|-------|---------|
| `0x46 0x52 0x4C 0x59` | Video | "FRLY" | JPEG or H.264 encoded video frames |
| `0x46 0x52 0x41 0x55` | Audio | "FRAU" | PCM audio frames |

Both frame types share the same header size (36 bytes) and CRC-16 integrity scheme. Binary frames are sent as WebSocket binary messages. Control signals are sent as WebSocket text (JSON) messages.

**Key design properties:**

- No frame fragmentation -- each WebSocket message is one complete frame
- No version negotiation -- version byte is a hard requirement (must be 1)
- No application-level encryption -- relies on TLS in transit
- No protocol-level compression beyond the video/audio codecs
- Single publisher per session, unlimited viewers
- Implemented across 4 languages: Swift (iOS), TypeScript (server + relay-protocol), Rust/WASM (performance-critical), TypeScript (web viewer)

## Documentation

| File | Topic | Lines |
|------|-------|-------|
| [wire-format.md](wire-format.md) | FRLY + FRAU binary layouts, byte[25] packing, CRC-16, multiplexing, cross-implementation inconsistencies, intermediate data structures, builder APIs | ~490 |
| [control-messages.md](control-messages.md) | All JSON message types (publisher, viewer, server), hello schemas, backpressure, session_info broadcast, ~22 HTTP API endpoints, error codes | ~1200 |
| [connection-lifecycle.md](connection-lifecycle.md) | Connect/stream/disconnect, close codes, ping/pong, auto-reconnect, hello field list, inbound audio, telemetry push, claim guard | ~560 |
| [video-codecs.md](video-codecs.md) | JPEG + H.264 encoder configs, adaptive quality, NAL formatting, Annex B, H264 threading, telemetry stats, EMA init | ~490 |
| [audio-pipeline.md](audio-pipeline.md) | PCM chain, AudioEventBus, AudioStage, AudioPlaybackStage (TTS), AudioTapClient, FramePipelineManager, noise gate/suppression/gain | ~590 |
| [congestion-control.md](congestion-control.md) | AIMD backpressure, server token bucket, effective FPS priority chain, publisher adaptive quality | ~110 |
| [server-architecture.md](server-architecture.md) | Session lifecycle, publisher claim mutex, recording format + sidecars, audio tap bus, bidirectional routing, APNs push, guidance orchestrator, frame validation, phantom GC | ~730 |
| [viewer-decoding.md](viewer-decoding.md) | WebCodecs vs MSE paths, avcC layout, codec string derivation, AIMD constants, bandwidth estimation, ring buffer, bounding boxes, push-to-talk | ~540 |
| [implementation-reference.md](implementation-reference.md) | Source files, test files, legacy 29-byte format, byte[25] discrepancy note | ~110 |

**Total: ~4,900 lines across 9 files.**

## Data Flow

```
[Meta Ray-Ban Glasses]
      |  BLE + L2CAP/QUIC (video via DAT SDK)
      |  HFP (audio: mic in, speaker out)
      v
[iOS App: CameraAccess]
      |
      |  Video: CMSampleBuffer -> FramePipelineManager -> encode -> FRLY header + CRC + payload
      |  Audio: AVAudioEngine -> PCM -> AudioEventBus -> process -> FRAU header + CRC + PCM
      |  TTS: AVSpeechSynthesizer.write() -> PCM -> AudioEventBus (codecType 2)
      |
      |  wss://relay.simulationapi.com/publish
      v
[Caddy:443] -- TLS termination --> [Bun Relay Server:8080]
                                        |
                                        |  Fan-out raw binary to viewers
                                        |  Parse FRAU for recording/transcription
                                        |  Audio tap bus for monitoring/AI
                                        |  Guidance orchestrator -> publisher (codecType 3)
                                        |  APNs push notifications to offline viewers
                                        |  Session recording: MJPEG + PCM + sidecars -> S3/R2
                                        |
                                        v
                                 [Browser Viewer]
                                        |
                                        |  Classify magic bytes
                                        |  FRLY -> decode -> render (WebCodecs or MSE/jMuxer -> canvas)
                                        |  FRAU -> resample -> ring buffer -> play (Web Audio API)
                                        |  Bounding box overlays on canvas
                                        |
                                        |  Bidirectional: mic capture -> FRAU -> WebSocket
                                        v
                                 [Relay Server] -> [iOS App] (codecType 3, inbound audio)
```

## Implementation Languages

| Language | Component | Key Files |
|----------|-----------|-----------|
| Swift | iOS publisher | `Pipeline/WireProtocol.swift`, `Pipeline/Stages/RelayStage.swift`, `Pipeline/Stages/H264FrameEncoder.swift` |
| TypeScript | Relay server | `server/src/server.ts`, `server/src/session-recorder.ts`, `server/src/session-registry.ts` |
| TypeScript | relay-protocol npm | `relay-protocol/src/video.ts`, `relay-protocol/src/audio.ts`, `relay-protocol/src/crc16.ts` |
| Rust | WASM decoder | `frame-relay-wasm/src/video.rs`, `frame-relay-wasm/src/audio.rs`, `frame-relay-wasm/src/mux.rs` |
| TypeScript | Web viewer | `web-platform/src/player/relay-player.ts`, `web-platform/src/player/resampler.ts` |
