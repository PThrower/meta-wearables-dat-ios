# PRD-002: Relay Platform

**Product:** com.mwdat-ios / Relay Server
**Owner:** @ebowwa
**Status:** P0 Complete
**Last Updated:** 2026-04-10
**Depends On:** PRD-001 (iOS Client publishes), PRD-005 (Browser Viewer consumes), PRD-007 (Auth)

---

## Problem

The iOS streaming client (PRD-001) encodes glasses camera frames as JPEG and wraps them in the FRLY binary protocol. These frames need to reach remote viewers with sub-200ms latency, support multiple concurrent sessions from different glasses/operators, and eventually feed AI workers and persistent storage.

The current relay server handles one publisher at a time. A second publisher is rejected. All viewers see the same stream. There is no session isolation, no auth, and no persistence. The server loses all state on restart.

---

## Users

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| **Publisher** | iOS app running on operator's phone | Reliable WebSocket connection; session identity; backpressure signaling |
| **Viewer** | Browser watching a live stream | Low-latency fan-out; quality presets (high/medium/low/mini FPS) |
| **AI Worker** | Server-side inference service | Frame fan-out at controlled FPS; FRLY binary passthrough |
| **Platform Operator** | CaringMind team managing infrastructure | Multi-session monitoring; per-session stats; session lifecycle control |

---

## Current State

**Runtime:** Bun on Hetzner VPS (`caringmind-relay`, fsn1)  
**TLS:** Caddy reverse proxy at `relay.simulationapi.com`  
**Port:** 8080 (configurable via `RELAY_PORT`)

### Endpoints

| Endpoint | Protocol | Role |
|----------|----------|------|
| `/publish` | WebSocket | Single publisher slot (rejects with 4001 if occupied) |
| `/view` | WebSocket | N viewers, fan-out of FRLY/FRAU frames |
| `/` | HTTP GET | Serves `viewer/index.html` |
| `/stats` | HTTP GET | JSON: FPS, bytes, connections |

### Features

- Per-viewer quality presets: high (30fps), medium (15fps), low (8fps), mini (4fps)
- WASM-backed frame throttling (`FrameRelay.should_relay()`) with JS fallback
- Stale connection cleanup: 15s publisher timeout, 30s viewer timeout
- Device identity tracking on publisher connect
- FRLY/FRAU binary passthrough (no transcoding)

### Gaps

1. ~~**Single publisher**~~ -- RESOLVED: `SessionRegistry` with multi-session routing via `?session=<id>`
2. ~~**No session isolation**~~ -- RESOLVED: per-session publisher slot, viewer maps, WASM throttle instances
3. **No auth** -- anyone with the URL can publish or view (see PRD-007 for Google OAuth implementation)
4. ~~**No persistence**~~ -- RESOLVED: `SessionRecorder` writes FRLY/FRAU to S3 bucket (PRD-004)
5. **No AI video worker fan-out** -- `AudioTapBus` handles audio taps; no video analysis WebSocket endpoint yet
6. ~~**No session metadata storage**~~ -- RESOLVED: `meta.json` written on session start/end; device info persisted
7. ~~**Manual deploy**~~ -- RESOLVED: systemd service `caringmind-relay` on Hetzner VPS
8. ~~**Gallery is static**~~ -- PARTIALLY RESOLVED: live bucket queries with 30s TTL cache; unified page replaces separate gallery.html

---

## Requirements

### P0 -- Must Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P0-1 | Multi-session routing by `sessionId` | `/publish?session=<id>` and `/view?session=<id>` route independently; N concurrent sessions |
| P0-2 | Session lifecycle: created -> active -> idle -> expired | Session persists through publisher disconnect; viewers see "reconnecting"; auto-cleanup after configurable idle timeout |
| P0-3 | Per-session WASM throttle instances | Each session gets its own `FrameRelay` instance; viewer quality presets scoped to session |
| P0-4 | Session directory endpoint (`GET /sessions`) | Returns JSON array of active sessions with metadata (device name, wearable type, viewer count, FPS, resolution, uptime) |
| P0-5 | Per-session viewer page (`/session/<id>`) | Serves viewer HTML auto-connected to the correct session; no manual URL entry |
| P0-6 | Directory landing page (`/`) | Lists active sessions with thumbnails, device names, viewer counts; click to open session viewer |
| P0-7 | FRLY/FRAU wire protocol unchanged | Zero breaking changes to the binary format; iOS client upgrade is URL param addition only |

### P1 -- Should Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P1-1 | Session token auth for publishers | `/publish?session=<id>&token=<secret>` prevents session hijacking; token generated on session creation; see PRD-007 for auth implementation |
| P1-2 | Google OAuth viewer auth | Viewers authenticate via Google before accessing any session; see PRD-007 for implementation details |
| P1-3 | AI worker fan-out endpoint (`/analyze?session=<id>`) | Same binary frames forwarded to AI worker WebSocket connections; throttled independently of viewers |
| P1-4 | Per-session stats (`/stats?session=<id>`) | Scoped metrics: publisher FPS, viewer count, bandwidth, jitter, per-viewer quality preset |
| P1-5 | Systemd service + deploy script | ~~`systemctl restart caringmind-relay`~~ RESOLVED: systemd service `caringmind-relay` running on Hetzner VPS |
| P1-6 | Bidirectional audio: push FRAU to iOS client | Relay sends FRAU frames (codecType 3) to publisher's WebSocket; enables server-side TTS, remote expert voice, AI guidance audio; uses existing publish WebSocket connection (no new endpoint) |
| P1-7 | Viewer audio forwarding to publisher | Relay receives binary FRAU frames (codecType 4) from viewer WebSocket (new: currently viewers only send JSON control messages); forwards to session publisher's WebSocket unchanged; when multiple viewers talk simultaneously, relay mixes PCM streams (server-side summation with clipping protection) before forwarding single mixed stream |

### P2 -- Could Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P2-1 | Session recording to S3-compatible bucket (see PRD-004) | Server-side recorder appends JPEG segments to bucket every 10s during live session |
| P2-2 | Session replay from bucket | `GET /recording/<id>` streams stored segments for playback |
| P2-3 | Rate limiting per IP | Prevent resource exhaustion from unauthenticated connections |
| P2-4 | WebSocket compression (`permessage-deflate`) | Reduce bandwidth for text-heavy control messages |
| P2-5 | Horizontal scaling with sticky sessions | Deferred indefinitely -- single VPS sufficient for current scale; revisit when concurrent sessions exceed 50 |

---

## Technical Architecture

### Session Registry

```
Map<string, Session>
       |
  Session {
    id: string
    publisher: Publisher | null
    viewers: Map<string, Viewer>
    analyzers: Map<string, Analyzer>      // P1-3
    recorder: SessionRecorder | null       // P2-1
    relay: FrameRelay                      // WASM instance
    metadata: SessionMetadata
    createdAt: number
    lastActivity: number
  }
```

### Request Routing

```
Client Request
       |
  URL Parse -> extract session param
       |
  +-- /publish?session=abc  -> sessions.get("abc").publisher = ws
  +-- /view?session=abc     -> sessions.get("abc").viewers.set(id, ws)
  +-- /analyze?session=abc  -> sessions.get("abc").analyzers.set(id, ws)
  +-- /sessions             -> JSON directory listing
  +-- /session/abc          -> serve viewer HTML with session=abc baked in
  +-- /stats                -> aggregate + per-session metrics
  +-- /stats?session=abc    -> scoped metrics
```

### Frame Fan-Out (per session)

```
publisher.onmessage(frame)
       |
       +---> for (viewer of session.viewers)
       |       if (viewer.relay.should_relay(now)) viewer.ws.send(frame)
       |
       +---> for (analyzer of session.analyzers)    // P1-3
       |       if (analyzer.relay.should_relay(now)) analyzer.ws.send(frame)
       |
       +---> session.recorder?.append(frame)         // P2-1
```

### Infrastructure

```
[iOS App] --wss://--> [Caddy:443 TLS] --ws://--> [Bun:8080]
                      relay.simulationapi.com       |
                      (auto Let's Encrypt)          +-- Session Registry
                                                    +-- WASM Throttle (per-session)
                                                    +-- Static Viewer HTML
                                                    +-- [S3 Client] --> Hetzner Storage Box
```

### Key Files

| File | Purpose |
|------|---------|
| `relay/server/src/server.ts` | HTTP/WebSocket handler, routing, fan-out |
| `relay/server/src/session-registry.ts` | Session CRUD, stale cleanup |
| `relay/server/src/protocol.ts` | FRLY/FRAU parsing, timing helpers |
| `relay/server/src/session-export.ts` | Gallery data, MP4 export, thumbnails |
| `relay/server/src/session-recorder.ts` | Server-side recording |
| `relay/server/src/types.ts` | Shared TypeScript types |
| `relay/crate/src/lib.rs` | Rust WASM `FrameRelay.should_relay()` |
| `relay/viewer/index.html` | Browser viewer (canvas, A/V sync, ring buffer) |
| `relay/viewer/directory.html` | Session directory listing |
| `relay/viewer/gallery.html` | Creator gallery (stored sessions) |

---

## Wire Protocol (Unchanged)

### FRLY -- Video Frame

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | Magic: `0x46524C59` ("FRLY") |
| 4 | 8 | Sequence number (u64 LE) |
| 12 | 4 | Width (u32 LE) |
| 16 | 4 | Height (u32 LE) |
| 20 | 1 | JPEG quality (u8) |
| 21 | 8 | Timestamp ms (u64 LE) |
| 29 | N | JPEG payload |

### FRAU -- Audio Frame

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | Magic: `0x46524155` ("FRAU") |
| 4 | 1 | Codec type: 0=built-in mic, 1=glasses HFP mic, 2=TTS playback, 3=relay inbound, 4=viewer mic |
| 5 | 8 | Sequence number (u64 LE) |
| 13 | 4 | Sample rate (u32 LE) |
| 17 | 2 | Channels (u16 LE) |
| 19 | 2 | Bits per sample (u16 LE) |
| 21 | 8 | Timestamp ms (u64 LE) |
| 29 | N | PCM payload |

---

## Migration Path

The refactor is confined to `server.ts` and `session-registry.ts`:

1. Wrap current publisher/viewer state in a `Session` object
2. Index sessions by ID in `Map<string, Session>`
3. Parse `session` from URL query params on `/publish` and `/view`
4. Scope `fanout()` and `fanoutAudio()` to `session.viewers`
5. Add `/sessions` directory endpoint
6. Update viewer HTML to accept and pass `session` param
7. Instantiate `FrameRelay` per session instead of globally

**Zero changes** to `relay/crate` (Rust WASM) -- `FrameRelay` is already stateless per instance.  
**Additive change** to viewer HTML -- session picker + param passthrough.  
**iOS client change** -- append `?session=<id>` to the relay URL (P1-1 in PRD-001).

---

## Success Metrics

| Metric | Target | Method |
|--------|--------|--------|
| Concurrent sessions supported | >= 10 on single VPS | Load test with mock publishers |
| Publisher-to-viewer latency | < 200ms p95 | FRLY timestamp delta measured at viewer |
| Session creation latency | < 50ms | Server-side timing |
| Stale session cleanup accuracy | 100% within 2x idle timeout | Monitoring `/stats` |
| Viewer fan-out overhead per additional viewer | < 5ms per frame | Profiling on Bun |

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Memory growth with many concurrent sessions (JPEG buffers) | High | Cap max sessions; per-session memory budget; drop frames for slow viewers |
| WASM instantiation cost per session | Medium | Pool `FrameRelay` instances; lazy init on first frame |
| No auth allows session enumeration and hijacking | Medium | P1-1 (token auth) and P1-2 (Google OAuth) |
| Caddy TLS renewal failure blocks all traffic | Low | Caddy auto-renew is robust; monitor cert expiry |
| Bun process crash loses all session state | Medium | Systemd auto-restart (P1-5); session state is ephemeral by design |
