# com.mwdat-ios -- Product Requirements Documents

**Last Updated:** 2026-04-06

---

## System Overview

```
Meta Glasses (Ray-Ban Meta)
       | Bluetooth LE
       v
[PRD-001] iOS Streaming Client
  Pipeline: Display | Relay | Record | Audio | AI
       |                       |           |
       v                       v           v
[PRD-002] Relay Platform    [PRD-003] On-Device AI
  Multi-session Bun server     Vision/CoreML @ 4fps
  FRLY/FRAU fan-out            AIDetection events
       |           |
       v           v
[PRD-005]       [PRD-004]
Browser          Session Persistence
Viewer &         S3 Bucket Storage
Gallery          Recording & Playback
```

## PRD Index

| PRD | Title | Surface | Status |
|-----|-------|---------|--------|
| [PRD-001](PRD-001-ios-streaming-client.md) | iOS Streaming Client | Swift / CameraAccess app | Draft |
| [PRD-002](PRD-002-relay-platform.md) | Relay Platform | Bun / WebSocket server | Draft |
| [PRD-003](PRD-003-on-device-ai-pipeline.md) | On-Device AI Pipeline | Swift / Vision + CoreML | Draft |
| [PRD-004](PRD-004-session-persistence.md) | Session Persistence & Playback | Bun + S3 storage | Draft |
| [PRD-005](PRD-005-browser-viewer-gallery.md) | Browser Viewer & Creator Gallery | HTML / JS viewer | Draft |

## Dependency Graph

```
PRD-001 (iOS Client)
   |
   +---> PRD-002 (Relay Platform)  <--- PRD-005 (Browser Viewer)
   |        |
   |        +---> PRD-004 (Persistence)  <--- PRD-005 (Gallery)
   |
   +---> PRD-003 (On-Device AI)
            |
            +---> PRD-004 (AI detection storage)
```

- **PRD-001** is the root -- the iOS client publishes frames that everything else consumes
- **PRD-002** is the backbone -- all remote consumption routes through the relay
- **PRD-003** is self-contained on-device but its outputs flow to PRD-002 and PRD-004
- **PRD-004** requires PRD-002 (server-side recording from fan-out)
- **PRD-005** requires PRD-002 (live viewing) and PRD-004 (gallery playback)

## Priority Ordering

| Phase | PRDs | Deliverable |
|-------|------|-------------|
| **Phase 1** | PRD-001 P0 + PRD-002 P0 | Multi-session streaming from glasses to browser viewers |
| **Phase 2** | PRD-005 P0 + PRD-002 P1 | Session discovery, auto-connect viewer, quality controls, auth |
| **Phase 3** | PRD-004 P0 + PRD-005 P1 | Server-side recording to bucket, gallery browsing, playback |
| **Phase 4** | PRD-003 P0 + PRD-004 P1 | On-device AI stage, detection persistence, AI overlays |
| **Phase 5** | All P2 items | HLS transcoding, Whisper, multi-session grid, advanced features |

## Wire Protocols

Both protocols are stable and shared across all PRDs:

**FRLY (Video):** `[4B "FRLY"][8B seq][4B width][4B height][1B quality][8B timestamp][N JPEG]`

**FRAU (Audio):** `[4B "FRAU"][1B codec][8B seq][4B sampleRate][2B channels][2B bitsPerSample][8B timestamp][N PCM]`

## Infrastructure

| Component | Runtime | Location |
|-----------|---------|----------|
| iOS Client | Swift / DAT SDK 0.5 | Operator's iPhone |
| Relay Server | Bun | Hetzner VPS (fsn1), `relay.simulationapi.com` |
| TLS Termination | Caddy | Same VPS, auto Let's Encrypt |
| Object Storage | S3-compatible | Hetzner Storage Box (fsn1) |
| WASM Throttle | Rust -> wasm32 | Loaded by Bun server |
| Secrets | Doppler | All environments |
