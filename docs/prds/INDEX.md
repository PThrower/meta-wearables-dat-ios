# com.mwdat-ios -- Product Requirements Documents

**Last Updated:** 2026-04-10

---

## Three-Layer Model

Everything built so far is plumbing. None of it is the product.

```
Layer 1: INFRASTRUCTURE                    Layer 2: APPLICATION PRIMITIVES          Layer 3: PRODUCT
Get frames from glasses to screen          Building blocks for products              What someone pays for
─────────────────────────────              ─────────────────────────────             ──────────────────────
PRD-001  iOS Streaming Client              PRD-008  AI Guidance Loop                 (unwritten)
PRD-002  Relay Platform                    PRD-009  Two-Way Comms
PRD-003  On-Device AI Pipeline             PRD-010  Task State Engine
PRD-004  Session Persistence               PRD-011  Alert System
PRD-005  Browser Viewer & Gallery
PRD-007  Google OAuth

"Get frames out of glasses"               "Reason about frames, talk back,          "Worker completes assembly
                                           track state, raise alerts"               hands-free with AI coaching"
```

- **Layer 1** = How to get frames from glasses to a browser. All P0 complete.
- **Layer 2** = Building blocks that make frames useful. Still plumbing, just one level up.
- **Layer 3** = The actual product -- scenarios that combine primitives into something someone pays for.

**Layer 3 does not exist in any PRD yet.** PRD-006 describes the enterprise vision but has no architecture or scenarios.

### Layer 1 Gap: Bidirectional Audio

Audio is currently one-directional. The relay can tap audio out but cannot push audio back to the iOS client.

```
CURRENT (one-way):
  iOS ──FRAU──> Relay ──FRAU──> Browser viewers
                 │
                 └──/tap/audio──> (read-only tap for AI workers / transcription)

  iOS local TTS: AVSpeechSynthesizer → PCM → AudioEventBus → FRAU → Relay
  (device-generated only, nothing comes back from the server)

MISSING:
  Relay ──FRAU──> iOS client

  This enables:
  - Server-side TTS / AI speech → played on operator's phone speaker or glasses
  - Remote expert voice → played on operator's device
  - AI guidance audio responses → same content stream
```

**The return audio must use the same FRAU content stream** -- not a separate channel. The iOS client already knows how to decode FRAU. A new `codecType` (3 = relay inbound) or reusing existing codecType with direction metadata makes it part of the same protocol.

**What needs building:**
| Component | What | Where |
|-----------|------|-------|
| `AudioSinkStage` | Receives FRAU frames from relay WebSocket, publishes to AudioEventBus, plays via AVAudioEngine | iOS (PRD-001) |
| Relay audio push | Server sends FRAU frames to publisher's WebSocket (currently only receives from publisher) | Relay (PRD-002) |
| FRAU codecType 3 | `relay-inbound` -- audio originating from server, destined for iOS client | Wire protocol |

**Why it's Layer 1:** Without bidirectional audio, every Layer 2 primitive (guidance, comms, alerts) is blocked. The relay can see and hear the operator, but cannot talk back.

## Directory Structure

```
docs/prds/
├── INDEX.md                                    (this file)
├── infrastructure(plumbing)/                   Layer 1: get frames from glasses to screen
│   ├── PRD-001-ios-streaming-client.md         iOS app, pipeline, audio
│   ├── PRD-002-relay-platform.md               Bun relay, sessions, fan-out
│   ├── PRD-003-on-device-ai-pipeline.md        Vision/CoreML detection stage
│   ├── PRD-004-session-persistence.md          S3 recording, gallery, MP4 export
│   ├── PRD-005-browser-viewer-gallery.md       Browser viewer, directory, playback
│   └── prd-007-google-oauth.md                 Auth for all protected routes
└── goals/                                      Layer 2+3: what to build once infra works
    ├── PRD-006-enterprise-platform.md          Enterprise vision (Phase 9, no architecture)
    ├── PRD-008-ai-guidance-loop.md             Not written
    ├── PRD-009-two-way-comms.md                Not written
    ├── PRD-010-task-state-engine.md            Not written
    └── PRD-011-alert-system.md                 Not written
```

## PRD Index

### Layer 1 -- Infrastructure (plumbing)

| PRD | Title | Surface | Status |
|-----|-------|---------|--------|
| [PRD-001](infrastructure%28plumbing%29/PRD-001-ios-streaming-client.md) | iOS Streaming Client | Swift / CameraAccess app | P0 Complete |
| [PRD-002](infrastructure%28plumbing%29/PRD-002-relay-platform.md) | Relay Platform | Bun / WebSocket server | P0 Complete |
| [PRD-003](infrastructure%28plumbing%29/PRD-003-on-device-ai-pipeline.md) | On-Device AI Pipeline | Swift / Vision + CoreML | Draft |
| [PRD-004](infrastructure%28plumbing%29/PRD-004-session-persistence.md) | Session Persistence & Playback | Bun + S3 storage | P0 Complete |
| [PRD-005](infrastructure%28plumbing%29/PRD-005-browser-viewer-gallery.md) | Browser Viewer & Creator Gallery | HTML / JS viewer | P0 Complete |
| [PRD-007](infrastructure%28plumbing%29/prd-007-google-oauth.md) | Google OAuth Authentication | Bun + iOS + Browser | In Progress |

### Layer 2 -- Application Primitives (higher-level plumbing, still not the product)

| PRD | Title | What it enables | Status |
|-----|-------|-----------------|--------|
| PRD-008 | AI Guidance Loop | Camera sees -> AI reasons -> operator hears guidance | Not Written |
| PRD-009 | Two-Way Comms | Remote expert sees feed, talks back to operator | Not Written |
| PRD-010 | Task State Engine | Procedure tracking, current step, what's next | Not Written |
| PRD-011 | Alert System | Wrong part, safety violation, restricted zone | Not Written |

### Layer 3 -- Product (the actual things someone pays for)

Nothing written yet. These are the scenarios that combine Layer 1 + Layer 2 primitives into products.

Examples of what Layer 3 looks like:
- "Worker completes assembly procedure hands-free with AI coaching"
- "Remote expert walks a field worker through equipment repair"
- "Quality audit of completed work with AI verification"
- "New worker trains on a procedure with step-by-step AI guidance"

These combine primitives: guidance (008) + comms (009) + task state (010) + alerts (011).

### Layer 3+ -- Enterprise

| PRD | Title | Surface | Status |
|-----|-------|---------|--------|
| [PRD-006](goals/PRD-006-enterprise-platform.md) | Enterprise AI Smart Glasses Platform | Multi-hardware + CRM + AI guidance | Phase 9 -- Not Active |

## Dependency Graph

```
LAYER 1: INFRASTRUCTURE

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

LAYER 2: APPLICATION PRIMITIVES (depends on Layer 1)

PRD-008 (AI Guidance Loop)
   |
   +---> PRD-003 (detections as input)
   +---> PRD-001 (audio playback to operator)
   +---> PRD-002 (AI worker fan-out)

PRD-009 (Two-Way Comms)
   |
   +---> PRD-001 (AudioPlaybackStage)
   +---> PRD-002 (relay audio tap)
   +---> PRD-005 (viewer sees feed)

PRD-010 (Task State Engine)
   |
   +---> PRD-008 (guidance triggers state transitions)
   +---> PRD-004 (task state persistence)

PRD-011 (Alert System)
   |
   +---> PRD-003 (detections trigger alerts)
   +---> PRD-008 (alerts interrupt guidance)

LAYER 3: PRODUCT (depends on Layers 1+2)
  (no PRDs yet -- scenarios combining primitives)

LAYER 3+: ENTERPRISE

PRD-006 (Enterprise Platform) -- umbrella, Phase 9
   |
   +---> All Layer 1 PRDs (infrastructure)
   +---> All Layer 2 PRDs (primitives)
   +---> Layer 3 products (scenarios)
   +---> Hardware Abstraction API
   +---> CRM Integration
```

## Priority Ordering

| Phase | PRDs | Deliverable | Layer |
|-------|------|-------------|-------|
| **Phase 1** | PRD-001 P0 + PRD-002 P0 | Multi-session streaming from glasses to browser | 1 |
| **Phase 2** | PRD-007 + PRD-002 P1 | Google OAuth on all protected routes | 1 |
| **Phase 3** | PRD-005 P0 + PRD-002 P1 | Session discovery, auto-connect viewer, quality controls | 1 |
| **Phase 4** | PRD-004 P1 + PRD-005 P1 | Opus transcoding, gallery, MP4 playback | 1 |
| **Phase 5** | PRD-003 P0 + PRD-004 P1 | On-device AI detections, persistence, overlays | 1 |
| **Phase 6** | PRD-008, PRD-009 | AI guidance loop, two-way comms | 2 |
| **Phase 7** | PRD-010, PRD-011 | Task state engine, alert system | 2 |
| **Phase 8** | All P2 items | HLS, Whisper, multi-session grid | 1 |
| **Phase 9** | Layer 3 PRDs | Actual product scenarios | 3 |
| **Phase 10** | PRD-006 P0 | Hardware abstraction, CRM, AI safety | 3+ |

## Wire Protocols

Both protocols are stable and shared across all PRDs:

**FRLY (Video):** `[4B "FRLY"][8B seq][4B width][4B height][1B quality][8B timestamp][N JPEG]`

**FRAU (Audio):** `[4B "FRAU"][1B codecType][8B seq][4B sampleRate][2B channels][2B bitsPerSample][8B timestamp][N PCM]`

**FRAU codecType values:**
| Value | Label | Source | Sample Rate | Direction | Status |
|-------|-------|--------|-------------|-----------|--------|
| 0 | Built-in mic | Phone microphone | 48kHz | iOS → Relay | Active |
| 1 | Glasses HFP mic | Ray-Ban Meta via Bluetooth HFP | 16kHz | iOS → Relay | Active |
| 2 | TTS playback | AVSpeechSynthesizer.write() PCM | 22050Hz | iOS → Relay | Reserved (see PRD-001 P1-7) |
| 3 | Relay inbound | Server-originated audio (TTS, remote expert, AI guidance) | TBD | Relay → iOS | Not built |

## Infrastructure

| Component | Runtime | Location |
|-----------|---------|----------|
| iOS Client | Swift / DAT SDK 0.5 | Operator's iPhone |
| Relay Server | Bun | Hetzner VPS (fsn1), `relay.simulationapi.com` |
| TLS Termination | Caddy | Same VPS, auto Let's Encrypt |
| Object Storage | S3-compatible | Hetzner Storage Box (fsn1) |
| WASM Throttle | Rust -> wasm32 | Loaded by Bun server |
| Secrets | Doppler | All environments |
