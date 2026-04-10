# com.mwdat-ios -- Product Requirements Documents

**Last Updated:** 2026-04-10 (status audit)

---

## System Overview

```
Meta Glasses (Ray-Ban Meta)         HeyCyan / Lensmoo / Vision Pro
       | Bluetooth LE                      | Vendor SDKs
       v                                   v
[PRD-001] iOS Streaming Client      [PRD-006] Enterprise Platform
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
| [PRD-001](PRD-001-ios-streaming-client.md) | iOS Streaming Client | Swift / CameraAccess app | P0 Complete |
| [PRD-002](PRD-002-relay-platform.md) | Relay Platform | Bun / WebSocket server | P0 Complete |
| [PRD-003](PRD-003-on-device-ai-pipeline.md) | On-Device AI Pipeline | Swift / Vision + CoreML | Draft |
| [PRD-004](PRD-004-session-persistence.md) | Session Persistence & Playback | Bun + S3 storage | P0 Complete |
| [PRD-005](PRD-005-browser-viewer-gallery.md) | Browser Viewer & Creator Gallery | HTML / JS viewer | P0 Complete |
| [PRD-006](PRD-006-enterprise-platform.md) | Enterprise AI Smart Glasses Platform | Multi-hardware + CRM + AI guidance | Phase 6 -- Not Active |
| [PRD-007](prd-007.md) | Google OAuth Authentication | Bun + iOS + Browser | In Progress |

## Dependency Graph

```
PRD-001 (iOS Client)
   |
   +---> PRD-002 (Relay Platform)  <--- PRD-005 (Browser Viewer)
   |        |
   |        +---> PRD-004 (Persistence)  <--- PRD-005 (Gallery)
   |        +---> PRD-007 (Google OAuth) ---> P1-1/P1-2 auth gates
   |
   +---> PRD-003 (On-Device AI)
            |
            +---> PRD-004 (AI detection storage)

PRD-006 (Enterprise Platform) -- umbrella PRD, Phase 6
   |
   +---> PRD-001, PRD-002, PRD-003, PRD-004 (foundation layer)
   +---> Hardware Abstraction API (FR-003) -- new
   +---> Enterprise CRM Integration (Salesforce, HubSpot) -- new
   +---> AI Safety & Guardrails -- new
```

- **PRD-001** is the root -- the iOS client publishes frames that everything else consumes
- **PRD-002** is the backbone -- all remote consumption routes through the relay
- **PRD-003** is self-contained on-device but its outputs flow to PRD-002 and PRD-004
- **PRD-004** requires PRD-002 (server-side recording from fan-out)
- **PRD-005** requires PRD-002 (live viewing) and PRD-004 (gallery playback)
- **PRD-006** is the umbrella enterprise PRD -- it builds on all existing PRDs and adds hardware abstraction, CRM integration, and AI safety requirements
- **PRD-007** gates PRD-002 P1-1/P1-2 (auth) and PRD-005 P1-1 (viewer auth)

## Priority Ordering

| Phase | PRDs | Deliverable |
|-------|------|-------------|
| **Phase 1** | PRD-001 P0 + PRD-002 P0 | Multi-session streaming from glasses to browser viewers |
| **Phase 2** | PRD-007 + PRD-002 P1 | Google OAuth auth on all protected routes, session ownership |
| **Phase 3** | PRD-005 P0 + PRD-002 P1 | Session discovery, auto-connect viewer, quality controls |
| **Phase 4** | PRD-004 P1 + PRD-005 P1 | Opus audio transcoding, gallery browsing, MP4 playback |
| **Phase 5** | PRD-003 P0 + PRD-004 P1 | On-device AI stage, detection persistence, AI overlays |
| **Phase 6** | All P2 items | HLS transcoding, Whisper, multi-session grid, advanced features |
| **Phase 7** | PRD-006 P0 | Hardware Abstraction API, CRM integrations, AI safety guardrails |

## Wire Protocols

Both protocols are stable and shared across all PRDs:

**FRLY (Video):** `[4B "FRLY"][8B seq][4B width][4B height][1B quality][8B timestamp][N JPEG]`

**FRAU (Audio):** `[4B "FRAU"][1B codecType][8B seq][4B sampleRate][2B channels][2B bitsPerSample][8B timestamp][N PCM]`

**FRAU codecType values:**
| Value | Label | Source | Sample Rate | Status |
|-------|-------|--------|-------------|--------|
| 0 | Built-in mic | Phone microphone | 48kHz | Active |
| 1 | Glasses HFP mic | Ray-Ban Meta via Bluetooth HFP | 16kHz | Active |
| 2 | TTS playback | AVSpeechSynthesizer.write() PCM | 22050Hz | Reserved (disabled -- conflicts with relay audio, see PRD-001 P1-4) |

## Infrastructure

| Component | Runtime | Location |
|-----------|---------|----------|
| iOS Client | Swift / DAT SDK 0.5 | Operator's iPhone |
| Relay Server | Bun | Hetzner VPS (fsn1), `relay.simulationapi.com` |
| TLS Termination | Caddy | Same VPS, auto Let's Encrypt |
| Object Storage | S3-compatible | Hetzner Storage Box (fsn1) |
| WASM Throttle | Rust -> wasm32 | Loaded by Bun server |
| Secrets | Doppler | All environments |
