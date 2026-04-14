# Multi-Session Platform Architecture

Current state analysis and proposal for evolving the relay from single-publisher to multi-tenant session-routed platform.

## Current State: Single-Publisher Relay

The relay currently supports exactly one publisher at a time:

```ts
let publisher: Publisher | null = null;   // one global slot
const viewers: Map<string, Viewer>;       // all viewers see the same stream
```

A second publisher is rejected with `4001 "publisher already connected"`. A new publisher only takes over when the previous one goes stale (15s timeout) or disconnects.

### Current Endpoints

| Endpoint | Protocol | Role |
|----------|----------|------|
| `/publish` | WebSocket | iOS app pushes FRLY video + FRAU audio frames |
| `/view` | WebSocket | Browser viewers subscribe to the stream |
| `/` | HTTP | Serves viewer HTML |
| `/stats` | HTTP | JSON metrics (FPS, jitter, bandwidth, latency) |

### Current Features

- Per-viewer quality presets: high (30 FPS), medium (15 FPS), low (8 FPS), mini (4 FPS)
- WASM-backed frame throttling with JS fallback
- Stale connection cleanup: 15s publisher timeout, 30s viewer timeout
- Device identity tracking (deviceId, deviceName, wearableId, wearableType, deviceModel, systemVersion)
- Real-time stats endpoint

---

## Proposed: Multi-Session Platform

The core change is introducing `sessionId` as the routing key. Each session is an isolated channel with its own publisher, viewers, and throttle state. Multiple sessions run concurrently.

### Target Architecture

```
iOS Glasses App (DAT SDK)        iOS Glasses App (DAT SDK)
       |                                |
       v  ws://../publish?s=abc         v  ws://../publish?s=def
  +----------------------------------------------+
  |              Bun Relay Server                |
  |                                              |
  |  Session "abc"      Session "def"            |
  |  +-------------+   +-------------+          |
  |  | Publisher   |   | Publisher   |          |
  |  | Viewer Map  |   | Viewer Map  |          |
  |  | FrameRelay  |   | FrameRelay  |          |
  |  +-------------+   +-------------+          |
  +----------------------------------------------+
       |         |                |         |
       v         v                v         v
  [Browser] [Browser]       [Browser] [Browser]
```

### Data Model

```ts
interface Session {
  id: string;                    // nanoid or UUID
  publisher: Publisher | null;   // one publisher per session
  viewers: Map<string, Viewer>; // viewers scoped to this session
  createdAt: number;
  metadata: SessionMetadata;    // device info, tags, etc.
}

const sessions: Map<string, Session>; // the platform registry
```

### URL Routing

```
Current:
  /publish       -> publisher connects (single slot)
  /view          -> viewer connects (gets the only stream)

Proposed:
  /publish?session=<id>   -> publisher claims a session slot
  /view?session=<id>      -> viewer subscribes to that session
  /sessions               -> GET, lists active sessions with metadata
  /session/<id>           -> GET, serves viewer HTML auto-scoped to that session
  /stats                  -> GET, platform-wide + per-session stats
  /                       -> GET, directory page listing live sessions
```

The viewer HTML is served per-session. The `session` query param is baked into the auto-connect URL so viewers don't need manual configuration.

### Publisher Session Claim

When a publisher connects to `/publish?session=<id>`:

1. No session with that ID exists -> create session, claim publisher slot
2. Session exists, no publisher -> claim publisher slot
3. Session exists, publisher active -> reject with `4001 "publisher already connected"`

Optional future: add a `token` query param to prevent session hijacking.

### Session Lifecycle

```
Created  -> publisher connects to /publish?session=abc123
Active   -> publisher streaming, viewers joining via /view?session=abc123
Idle     -> publisher disconnects, viewers remain (showing last frame or "waiting")
Expired  -> no publisher for N seconds + no viewers -> auto-cleanup
```

Sessions don't die the instant the publisher drops. Viewers stay connected and see a "reconnecting" state. If the publisher reconnects to the same session ID, streaming resumes seamlessly.

### Viewer Discovery

New endpoint `GET /sessions` returns the session directory:

```json
{
  "sessions": [
    {
      "id": "abc123",
      "publisher": {
        "deviceName": "Starlink",
        "wearableType": "Ray-Ban Meta",
        "deviceModel": "iPhone 16 Pro",
        "systemVersion": "18.3"
      },
      "viewers": 3,
      "fps": 28.4,
      "resolution": "1280x720",
      "uptimeMs": 184000
    }
  ]
}
```

The root `/` page changes from a single-stream viewer to a **session directory** with thumbnails, device names, and viewer counts. Clicking a session deep-links to `/session/abc123`.

### Changes Per Package

| Package | Scope | What Changes |
|---------|-------|-------------|
| `hosted/packages/frame-relay-wasm` | None | `FrameRelay` is already stateless-per-instance. Instantiate one per session instead of one globally. |
| `hosted/server` | Major | Replace `let publisher` + global `viewers` with `sessions` map. Route by `session` query param. Add `/sessions` and `/session/:id` endpoints. Per-session stale-cleanup. |
| `hosted/viewer` | Additive | Accept `?session=` param. Add session-chooser UI for directory page. Auto-reconnect stays, scoped to session. |

### What Stays the Same

- FRLY/FRAU wire protocol -- no changes
- Per-viewer quality throttling -- still works, now per-session
- WASM throttle -- instantiate per-session instead of globally
- Audio ring buffer (viewer-side) -- unchanged
- Stale connection cleanup -- same logic, iterates sessions instead of globals

### Migration Path

The refactor is mostly confined to `server.ts`:

1. Wrap current publisher/viewer state in a `Session` object
2. Index sessions by ID in a `Map<string, Session>`
3. Parse `session` from URL query params on `/publish` and `/view`
4. Scope `fanout()` and `fanoutAudio()` to `session.viewers` instead of the global map
5. Add `/sessions` directory endpoint
6. Update viewer HTML to pass `session` param

The crate requires zero changes. The viewer change is additive (session picker + param pass-through).

## Wire Protocol Reference

### Video Frame (FRLY)

29-byte header + JPEG payload:

```
Offset  Size  Field
0       4     Magic bytes "FRLY" (0x46 0x52 0x4C 0x59)
4       8     Sequence number (u64 LE)
12      4     Width (u32 LE)
16      4     Height (u32 LE)
20      1     Quality (u8)
21      8     Timestamp ms (u64 LE)
29      ...   JPEG payload
```

### Audio Frame (FRAU)

29-byte header + PCM payload:

```
Offset  Size  Field
0       4     Magic bytes "FRAU" (0x46 0x52 0x41 0x55)
4       1     Codec type (0 = PCM 16-bit)
5       8     Reserved
13      4     Sample rate (u32 LE)
17      2     Channels (u16 LE)
19      2     Bits per sample (u16 LE)
21      8     Sender timestamp ms (u64 LE)
29      ...   PCM Int16 payload
```
