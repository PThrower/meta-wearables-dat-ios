# com.mwdat-ios -- Product Requirements Documents

**Last Updated:** 2026-04-10

---

## Three-Layer Model

Everything built so far is plumbing. None of it is the product.

```
Layer 1: INFRASTRUCTURE          Layer 1.5: DEVELOPER API           Layer 2: PRIMITIVES           Layer 3: PRODUCT
Get frames from glasses          Wrap plumbing in consumable code    Build blocks for products      What someone pays for
─────────────────────            ───────────────────────────        ─────────────────────          ──────────────────
PRD-001  iOS Client              PRD-012  Developer API             PRD-008  AI Guidance Loop      (unwritten)
PRD-002  Relay Platform                                             PRD-009  Two-Way Comms
PRD-003  On-Device AI                                              PRD-010  Task State Engine
PRD-004  Session Persistence                                       PRD-011  Alert System
PRD-005  Browser Viewer
PRD-007  Google OAuth
PRD-008+ all need this           Apps import SDK, not               Same concept, one level up
                                  wire protocols
```

- **Layer 1** = How to get frames from glasses to a browser. All P0 complete.
- **Layer 1.5** = Developer API that hides wire protocols, WebSocket handling, auth, and session management behind a clean SDK. Without this, every Layer 2+3 app reinvents FRLY parsing, reconnect logic, and audio routing.
- **Layer 2** = Building blocks that make frames useful. Built using the Developer API.
- **Layer 3** = The actual product -- scenarios that combine primitives into something someone pays for.

**Layer 3 does not exist in any PRD yet.** PRD-006 describes the enterprise vision but has no architecture or scenarios.

### Layer 1 Gap: Bidirectional Audio

Audio is currently one-directional. The relay can tap audio out but cannot push audio back to the iOS client. Viewers can hear the operator but cannot talk back.

```
CURRENT (one-way):
  iOS ──FRAU──> Relay ──FRAU──> Browser viewers
                 │
                 └──/tap/audio──> (read-only tap for AI workers / transcription)

  iOS local TTS: AVSpeechSynthesizer → PCM → AudioEventBus → FRAU → Relay
  (device-generated only, nothing comes back from the server)

MISSING (relay → iOS):
  Relay ──FRAU──> iOS client

  This enables:
  - Server-side TTS / AI speech → played on operator's phone speaker or glasses
  - Remote expert voice → played on operator's device
  - AI guidance audio responses → same content stream

MISSING (viewer → iOS):
  Browser viewer ──FRAU──> Relay ──FRAU──> iOS client ──HFP──> Glasses speakers

  This enables:
  - Remote expert talks to operator through glasses speakers
  - Viewer voice guidance / coaching
  - Multi-party voice communication
```

**All return audio must use the same FRAU content stream** -- not separate channels. The iOS client already knows how to decode FRAU. New codecTypes make sources distinguishable within the same protocol.

**What needs building:**
| Component | What | Where | codecType |
|-----------|------|-------|-----------|
| `AudioSinkStage` | Receives FRAU frames from relay WebSocket, publishes to AudioEventBus, plays via AVAudioEngine | iOS (PRD-001) | 3, 4 |
| Relay audio push | Server sends FRAU frames to publisher's WebSocket (currently only receives from publisher) | Relay (PRD-002) | 3, 4 |
| FRAU codecType 3 | `relay-inbound` -- server-originated audio (TTS, AI guidance) | Wire protocol | 3 |
| FRAU codecType 3 (viewer mic) | Browser viewer microphone audio sent as `relay-inbound` | Wire protocol | 3 |
| Viewer mic capture | `navigator.mediaDevices.getUserMedia()` → PCM 16-bit → FRAU binary (codecType 3) → viewer WebSocket | Browser (PRD-005) | 3 |
| Relay viewer audio forward | Receive binary FRAU from viewer WebSocket, forward to publisher's WebSocket | Relay (PRD-002) | 4 |
| HFP output routing | AVAudioEngine plays received PCM through glasses speakers via `.allowBluetooth` | iOS (PRD-001) | 3, 4 |

**Audio flow for viewer → glasses:**
```
1. Viewer clicks "Push to Talk" (or toggle) in browser
2. navigator.mediaDevices.getUserMedia({ audio: true })
3. MediaStream → ScriptProcessorNode / AudioWorklet → PCM Int16 16kHz
4. Wrap PCM in FRAU binary: [FRAU][codecType=3][seq][16000][1][16][timestamp][PCM]
5. Send binary over existing viewer WebSocket
6. Relay receives binary from viewer WebSocket (new: currently viewers only send JSON)
7. Relay forwards FRAU frame to publisher's WebSocket
8. iOS RelayStage receive loop detects FRAU magic → onReceivedAudio callback
9. AudioSinkStage decodes PCM, plays via AVAudioEngine output node
10. AVAudioSession with .allowBluetooth routes to glasses speakers via HFP
```

**Multi-viewer audio mixing:** When multiple viewers talk simultaneously, the relay must mix PCM streams before forwarding to publisher (server-side summation with clipping protection). Alternatively, forward individual streams and let the iOS client mix (simpler relay, more iOS work).

**Why it's Layer 1:** Without bidirectional audio, every Layer 2 primitive (guidance, comms, alerts) is blocked. The relay can see and hear the operator, but cannot talk back.

### Layer 1.5 Gap: Developer API

Right now, building anything on this platform means understanding FRLY/FRAU binary parsing, WebSocket lifecycle, session routing, auth tokens, and audio routing internals. That's a high bar for an app developer.

A Developer API wraps all of that behind a clean interface so apps are configuration, not protocol work.

```
WITHOUT Developer API:
  App developer must: parse FRLY binary, manage WebSocket reconnect,
  handle FRAU codecType routing, implement auth token refresh,
  understand session lifecycle, build their own frame fan-out

WITH Developer API:
  const session = await MwdatClient.connect({ sessionId: 'abc', token: jwt })
  session.on('frame', (jpeg) => { /* do something */ })
  session.on('detection', (d) => { /* person count, text, etc */ })
  session.audio.speak("Turn left at the next junction")  // TTS to operator
  session.audio.send(pcmBuffer)                          // raw audio to operator
```

**What the Developer API exposes:**

| Surface | Method | What it does |
|---------|--------|--------------|
| **Connection** | `MwdatClient.connect(opts)` | Auth, WebSocket, reconnect, session resolution |
| **Video** | `session.on('frame', cb)` | Decoded JPEG frames, no FRLY parsing needed |
| **Audio in** | `session.on('audio', cb)` | Decoded PCM per source (mic, glasses, relay) |
| **Audio out** | `session.audio.speak(text)` | Server-side TTS → FRAU codecType 3 → iOS client |
| | `session.audio.send(pcm)` | Raw PCM → FRAU codecType 3 → iOS client |
| **AI** | `session.on('detection', cb)` | AIDetection events (person, face, text, barcode) |
| **State** | `session.on('stateChange', cb)` | Session lifecycle events (active, idle, expired) |
| **Recording** | `session.recording.start()` | Server-side recording control |
| | `session.recording.download()` | MP4/presigned URL retrieval |
| **History** | `MwdatClient.listSessions()` | Active + stored sessions with metadata |
| | `MwdatClient.getSession(id)` | Stored session playback |

**SDK surfaces to build:**

| SDK | Language | Consumer | Priority |
|-----|----------|----------|----------|
| `@ebowwa/mwdat-sdk` | TypeScript / Bun | Server-side apps, AI workers, integrations | P0 |
| `@ebowwa/mwdat-swift` | Swift | iOS pipeline stages, custom app behavior | P1 |
| `@ebowwa/mwdat-browser` | TypeScript | Browser apps, custom viewers | P2 |

**Why it's Layer 1.5:** It's not a product feature -- it's the interface that makes product features possible to build. Every Layer 2 and Layer 3 PRD should consume this API instead of touching wire protocols directly. Without it, each app duplicates connection logic, auth, and frame parsing.

## Directory Structure

```
docs/prds/
├── INDEX.md                                    (this file)
├── infrastructure/                             Layer 1: get frames from glasses to screen
│   ├── PRD-001-ios-streaming-client.md         iOS app, pipeline, audio
│   ├── PRD-002-relay-platform.md               Bun relay, sessions, fan-out
│   ├── PRD-003-on-device-ai-pipeline.md        Vision/CoreML detection stage
│   ├── PRD-004-session-persistence.md          S3 recording, gallery, MP4 export
│   ├── PRD-005-browser-viewer-gallery.md       Browser viewer, directory, playback
│   ├── prd-007-google-oauth.md                 Auth for all protected routes
│   └── PRD-014-unified-telemetry-stats.md      Cross-channel telemetry, SDK version tracking
├── platform/                                   Layer 1: relay API surface + pipeline
│   └── PRD-013-platform-api-surface.md         /api/v1, /media, /s/<id>, frame pipeline
├── developer-api/                              Layer 1.5: SDK wrapping Layer 1 internals
│   └── PRD-012-developer-api.md                TypeScript SDK, Swift SDK, Browser SDK
└── goals/                                      Layer 2+3: what to build once infra works
    ├── PRD-006-enterprise-platform.md          Enterprise vision (Phase 10, no architecture)
    ├── PRD-008-ai-guidance-loop.md             Not written
    ├── PRD-009-two-way-comms.md                Not written
    ├── PRD-010-task-state-engine.md            Not written
    └── PRD-011-alert-system.md                 Not written
```

## PRD Index

### Layer 1 -- Infrastructure (plumbing)

| PRD | Title | Surface | Status |
|-----|-------|---------|--------|
| [PRD-001](infrastructure/PRD-001-ios-streaming-client.md) | iOS Streaming Client | Swift / CameraAccess app | P0 Complete |
| [PRD-002](infrastructure/PRD-002-relay-platform.md) | Relay Platform | Bun / WebSocket server | P0 Complete |
| [PRD-003](infrastructure/PRD-003-on-device-ai-pipeline.md) | On-Device AI Pipeline | Swift / Vision + CoreML | Draft |
| [PRD-004](infrastructure/PRD-004-session-persistence.md) | Session Persistence & Playback | Bun + S3 storage | P0 Complete |
| [PRD-005](infrastructure/PRD-005-browser-viewer-gallery.md) | Browser Viewer & Creator Gallery | HTML / JS viewer | P0 Complete |
| [PRD-007](infrastructure/prd-007-google-oauth.md) | Google OAuth Authentication | Bun + iOS + Browser | In Progress |
| [PRD-013](goals/platform/PRD-013-platform-api-surface.md) | Platform API Surface & Pipeline | Relay routing, /api/v1, /media, /s/<id>, frame pipeline | Draft |
| [PRD-014](infrastructure/PRD-014-unified-telemetry-stats.md) | Unified Telemetry & Stats | Cross-channel telemetry, SDK version, /api/v1/stats | Draft |

### Layer 1.5 -- Developer API

| PRD | Title | What it enables | Status |
|-----|-------|-----------------|--------|
| PRD-012 | Developer API & SDKs | Clean interface over wire protocols, auth, sessions, audio; apps are configuration not protocol work | Not Written |

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
   |        |                              |
   |        +---> PRD-004 (Persistence)  <--- PRD-005 (Gallery)
   |        +---> PRD-007 (Google OAuth) ---> P1-1/P1-2 auth gates
   |        +---> PRD-005 P1-8 (viewer mic → FRAU codecType 3 → relay → publisher)
   |        +---> PRD-001 P1-8/P1-11 (AudioSinkStage + HFP output routing)
   |
   +---> PRD-003 (On-Device AI)
            |
            +---> PRD-004 (AI detection storage)

LAYER 1.5: DEVELOPER API (depends on Layer 1)

PRD-012 (Developer API)
   |
   +---> PRD-013 (wraps /api/v1 JSON endpoints)
   +---> PRD-002 (session management, frame fan-out)
   +---> PRD-007 (auth token handling)
   +---> PRD-001 P1-8 (bidirectional audio -- audio.speak(), audio.send())
   +---> PRD-003 (detection event stream)
   +---> PRD-004 (recording control, playback)

LAYER 1: PLATFORM SURFACE (relay routing cleanup)

PRD-013 (Platform API Surface)
   |
   +---> PRD-002 (server.ts refactor, routing dispatch)
   +---> PRD-007 (consistent auth on all /api/v1 routes)
   +---> PRD-012 (stable API for SDK to wrap)

PRD-014 (Unified Telemetry)
   |
   +---> PRD-002 (relay stores telemetry on session/publisher)
   +---> PRD-013 (pipeline StatsStage, /api/v1/stats endpoint)
   +---> PRD-001 (iOS TelemetryService produces structured metrics)

LAYER 2: APPLICATION PRIMITIVES (depends on Layer 1.5 Developer API)

PRD-008 (AI Guidance Loop)
   |
   +---> PRD-012 (session.on('frame'), session.audio.speak())

PRD-009 (Two-Way Comms)
   |
   +---> PRD-012 (session.audio.send(), session.on('audio'))

PRD-010 (Task State Engine)
   |
   +---> PRD-012 (session.on('stateChange'), session.recording)

PRD-011 (Alert System)
   |
   +---> PRD-012 (session.on('detection'))

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
| **Phase 2.5** | PRD-013 P0 | Platform API surface: /api/v1, /media, /s/<id>, remove /latest/ | 1 |
| **Phase 3** | PRD-005 P0 + PRD-002 P1 | Session discovery, auto-connect viewer, quality controls | 1 |
| **Phase 4** | PRD-004 P1 + PRD-005 P1 | Opus transcoding, gallery, MP4 playback | 1 |
| **Phase 5** | PRD-003 P0 + PRD-004 P1 | On-device AI detections, persistence, overlays | 1 |
| **Phase 6** | PRD-001 P1-8 + PRD-002 P1-6 | Bidirectional audio (relay can talk to operator) | 1 |
| **Phase 7** | PRD-012 P0 | Developer API (`@ebowwa/mwdat-sdk` TypeScript) | 1.5 |
| **Phase 8** | PRD-008, PRD-009 | AI guidance loop, two-way comms | 2 |
| **Phase 9** | PRD-010, PRD-011 | Task state engine, alert system | 2 |
| **Phase 10** | All P2 items | HLS, Whisper, multi-session grid, Swift/Browser SDKs | 1+1.5 |
| **Phase 11** | Layer 3 PRDs | Actual product scenarios | 3 |
| **Phase 12** | PRD-006 P0 | Hardware abstraction, CRM, AI safety | 3+ |

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
| 3 | Relay inbound | Server-originated audio (TTS, AI guidance) | TBD | Relay → iOS | Not built |
| 4 | _unused_ | _collapsed into codecType 3_ | — | — | — |

## Infrastructure

| Component | Runtime | Location |
|-----------|---------|----------|
| iOS Client | Swift / DAT SDK 0.5 | Operator's iPhone |
| Relay Server | Bun | Hetzner VPS (fsn1), `relay.simulationapi.com` |
| TLS Termination | Caddy | Same VPS, auto Let's Encrypt |
| Object Storage | S3-compatible | Hetzner Storage Box (fsn1) |
| WASM Throttle | Rust -> wasm32 | Loaded by Bun server |
| Secrets | Doppler | All environments |
