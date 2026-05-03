# Server Architecture

Session management, recording format, audio tap bus, bidirectional routing, APNs push notifications, guidance orchestrator, frame validation, and all HTTP/WebSocket endpoints on the Bun relay server.

---

## Session Lifecycle

Sessions are created on demand by the first connection (publisher or viewer).

### Creation and Binding

| Query Param | Effect |
|-------------|--------|
| `?session=<id>` | Use specific session ID |
| `?device=<deviceId>` | Bind device to stable session `dev-<first8chars>` |

The `deviceSessionMap` persists across reconnections so the same device always returns to the same session. For viewers and audio taps, omitting `?session=` routes to the `"default"` session for backward compatibility.

### Publisher States

| State | Description |
|-------|-------------|
| Standby | Connected but not streaming. Exempt from frame-based stale detection. WebSocket ping keepalive handles transport liveness. |
| Active | Streaming. Recorder activated on `stream_changed` with `streaming: true`. |

Publishers start in standby. They transition to active when the client sends `{ type: "stream_changed", streaming: true }`. They revert to standby when `streaming: false`.

### Publisher Claim Mutex

Publisher claiming is guarded by a `publisherClaiming` boolean mutex on the session object. If a claim is already in progress, subsequent attempts are rejected with `"publisher claim in progress"`. The mutex is cleared after the claim succeeds or the function returns.

**Claim logic:**
1. If the session has an owner (`ownerId` set) and the connecting user does not match, reject with `"session owned by another user"`.
2. If an existing publisher's WebSocket is still `OPEN`, reject with `"publisher already connected"`.
3. If an existing publisher's WebSocket is not `OPEN` (zombie), force-evict: close with code 4002, finish recorder, clear publisher slot.
4. Set `publisherClaiming = true` for the duration of the claim.
5. Finish any existing recorder before starting a new one (prevents overlap).
6. Evict the publisher from any other session it may still be registered in.
7. Create the new publisher record, set `publisherClaiming = false`.
8. If the connecting user is authenticated and no owner exists yet, set them as the session owner.
9. Unauthenticated publishers cause the session `accessLevel` to be set to `"link"`.

### Stale Detection

Runs every 5 seconds via `setInterval(() => registry.cleanupStale(), 5_000)`.

| Role | Timeout | Action |
|------|---------|--------|
| Publisher (ws not OPEN) | Immediate | Close with 4002, evict, finish recorder |
| Publisher (standby) | Exempt | Frame-based stale eviction skipped entirely; Bun `idleTimeout: 120` handles transport |
| Publisher (active) | 15s no frames | Close with 4002, evict, finish recorder |
| Viewer | 30s no frames | Close with 4003, evict |
| Session (no publisher, no viewers) | 60s (normal) / 300s (device-bound) | Delete session, clean device map, invoke `onSessionDestroy` callback |

Publisher staleness is computed as `min(time since last frame, time since connected)`. For viewers, it is `min(time since last frame, time since connected)`.

### Phantom Session GC

When a viewer disconnects, `removeViewer()` checks whether the session now has zero viewers and no publisher. If so, and the session is not device-bound, it is immediately garbage collected:

```
session.viewers.size === 0 && session.publisher === null && !session.metadata.deviceName && !isDeviceBound
```

Device-bound sessions (those with entries in `deviceSessionMap`) are exempt from phantom GC and rely on the normal 300s session expiry.

### Viewer Eviction

Viewers are evicted in two scenarios:

1. **Stale eviction** -- 30s timeout with no frames received. WebSocket closed with code 4003.
2. **Send failure** -- If `ws.send()` throws during frame fanout, the viewer is immediately removed from the session's viewer map and `viewersRejected` counter is incremented.

---

## Session Data Model

### Session Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique session identifier |
| `publisher` | `Publisher \| null` | Active publisher connection |
| `viewers` | `Map<string, Viewer>` | Connected viewers keyed by viewerId |
| `recorder` | `SessionRecorder \| null` | Recording instance (null when standby) |
| `wasmThrottle` | `any` | WASM FrameRelay instance (lazy-initialized per session) |
| `createdAt` | `number` | Timestamp of session creation |
| `lastActivityAt` | `number` | Updated on every publisher/viewer connect/disconnect |
| `metadata` | `SessionMetadata` | Device info, resolution, owner email |
| `ownerId` | `string \| undefined` | Google user ID of session creator |
| `ownerEmail` | `string \| undefined` | Google email of session creator |
| `accessLevel` | `AccessLevel` | `"public" \| "link" \| "private"` |
| `acl` | `AclEntry[]` | Per-user access control list |
| `publisherClaiming` | `boolean` | Mutex flag for atomic publisher claim |
| `recordingId` | `string \| undefined` | Stable R2 prefix that survives publisher reconnections |
| `activeAppId` | `string \| null` | Currently active AI app |
| `appPipeline` | `AppPipeline \| null` | Runtime pipeline for active app |
| `lastFrame` | `Uint8Array \| null` | Cached latest FRLY frame for instant delivery |
| `linkState` | `string` | `"connected" \| "disconnected" \| "unknown"` |

### Publisher Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `ws` | `ServerWebSocket<WsData>` | WebSocket connection |
| `id` | `string` | Unique publisher UUID |
| `connected` | `number` | Connection timestamp |
| `frameCount` | `number` | Total video frames relayed |
| `totalBytes` | `number` | Total video bytes relayed |
| `audioCount` | `number` | Total audio frames relayed |
| `audioBytes` | `number` | Total audio bytes relayed |
| `audioTaps` | `Map<number, {count, bytes, sampleRate, lastAt}>` | Per-codecType audio stats |
| `timing` | `FrameTiming` | Latency and dropped frame tracking |
| `lastHeader` | `{width, height, quality} \| null` | Last parsed FRLY video header |
| `clientIp` | `string` | Client IP address |
| `deviceId` | `string \| null` | iOS device identifier |
| `deviceName` | `string \| null` | Human-readable device name |
| `wearableId` | `string \| null` | Wearable device identifier |
| `wearableType` | `string \| null` | Wearable type string |
| `deviceModel` | `string \| null` | Device model string |
| `systemVersion` | `string \| null` | iOS system version |
| `appVersion` | `string \| null` | App version |
| `buildNumber` | `string \| null` | Build number |
| `batteryLevel` | `number \| null` | Battery percentage |
| `batteryState` | `string \| null` | Battery state string |
| `lowPowerMode` | `boolean` | Low power mode active |
| `standby` | `boolean` | Whether publisher is in standby state |

### Viewer Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `ws` | `ServerWebSocket<WsData>` | WebSocket connection |
| `connected` | `number` | Connection timestamp |
| `frameCount` | `number` | Frames sent to this viewer |
| `totalBytes` | `number` | Bytes sent to this viewer |
| `timing` | `FrameTiming` | Latency and dropped frame tracking |
| `quality` | `QualityPreset` | Requested quality preset |
| `lastSentAt` | `number` | Timestamp of last frame sent |
| `throttledCount` | `number` | Frames dropped by token bucket |
| `clientIp` | `string` | Client IP address |
| `gitCommit` | `string \| null` | Viewer frontend git commit |
| `buildVersion` | `string \| null` | Viewer frontend build version |
| `bucket` | `TokenBucket` | Token bucket rate limiter for this viewer |

---

## Frame Validation

The server does NO frame validation beyond routing. Frames that fail parsing are silently dropped.

### FRLY Video Validation (via `parseVideoHeader`)

| Check | Requirement |
|-------|-------------|
| Minimum length | >= 36 bytes |
| Magic bytes | `[0x46, 0x52, 0x4C, 0x59]` |
| Version | Must be `1` |
| CRC-16 | Computed over [0:34] must match [34:36] |
| Payload length | Read but NOT validated against buffer size |
| Codec type | Extracted but NOT validated to be 0 or 1 |

### FRAU Audio Validation (via `parseAudioHeader`)

| Check | Requirement |
|-------|-------------|
| Minimum length | >= 36 bytes |
| Magic bytes | `[0x46, 0x52, 0x41, 0x55]` |
| Version | Must be `1` |
| CRC-16 | Computed over [0:34] must match [34:36] |
| codecType | Must be in `[0, 1, 2, 3]` |
| Payload length | Read but NOT validated |

**Fanout path**: Audio frames identified by magic bytes alone bypass the full header parse. FRLY frames that fail `parseHeader()` are silently dropped from fanout.

### No Frame Size Limit

No max payload length check exists anywhere. The implicit limit is WebSocket message size (Bun defaults to 16MB).

---

## Audio Tap Bus

The `AudioTapBus` is a dual-mode pub/sub system for intercepting audio frames.

### Modes

| Mode | Use Case |
|------|----------|
| **Callback** (`onFrame`) | Synchronous dispatch to WebSocket monitoring endpoints. Returns an unsubscribe function. |
| **AsyncIterable** (`subscribe`) | Per-subscriber push queue with Promise-based blocking `next()` |

### Backpressure

Each tap queue has `MAX_TAP_QUEUE_SIZE = 1000`. When exceeded, the oldest frame is dropped (shift + push). Callback subscribers are not subject to backpressure.

### Single Parse Point

`publish(rawFrame, sessionId)` calls `parseFRAU()` once per publish, then dispatches the decoded `AudioFrame` to all taps and callbacks. Invalid FRAU frames are silently skipped.

### AudioFrame Fields

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string \| undefined` | Session this frame belongs to |
| `codecType` | `number` | Audio codec type (0-3) |
| `sequence` | `number` | Frame sequence number |
| `sampleRate` | `number` | Sample rate in Hz |
| `channels` | `number` | Channel count |
| `bitsPerSample` | `number` | Bits per sample |
| `timestampMs` | `number` | Frame timestamp |
| `pcm` | `Uint8Array` | Raw PCM payload |

---

## Recording Format

### Video Recording

- Raw JPEG payloads (FRLY header stripped), concatenated into `Buffer[]`
- Flushed every 10 seconds to S3/R2 as `.mjpeg` files
- Path: `sessions/{recordingId}/video/seg-{NNNN}.mjpeg`
- Per-segment metadata: `frameCount`, `firstTimestampMs`, `lastTimestampMs`, `bytes`
- Actual FPS computed from timestamps (not assumed)

### Audio Recording

- Raw PCM payloads (FRAU header stripped), concatenated into `Buffer[]`
- Flushed every 10 seconds
- Path: `sessions/{recordingId}/audio/chunk-{NNNN}.pcm`
- Per-chunk metadata: `sampleRate`, `channels`, `totalSamples`, `bytes`
- PCM is 16-bit LE, 2 bytes per sample per channel

### Recording Sidecars

The recorder writes three sidecar files alongside video/audio segments:

**1. `annotations.jsonl`** -- Bounding box annotations from AI detection. Each line is a JSON object:

```json
{
  "timestampMs": 1234567890,
  "sessionId": "...",
  "objects": [
    { "y1": 0.1, "x1": 0.2, "y2": 0.5, "x2": 0.6, "label": "object", "confidence": 0.95 }
  ]
}
```

Written immediately (not buffered) via `appendBboxAnnotation()`. Failed writes are logged but do not block.

**2. `guidance.jsonl`** -- AI guidance events (persisted to R2). Each line is a JSON `GuidanceEvent` object. Written using a read-merge-write pattern: existing file is read from R2, new lines appended, then the whole file is written back. Buffer is flushed every 10 seconds in the `tick()` cycle alongside video/audio segments.

**3. `meta.json`** -- Session metadata. Written on first frame activation and on finish:

| Field | Description |
|-------|-------------|
| `sessionId` | Recording session ID |
| `startedAt` | ISO timestamp of recording start |
| `finishedAt` | ISO timestamp (final only) |
| `durationMs` | Duration in milliseconds (final only) |
| `device` | Device info (deviceId, deviceName, deviceModel, wearableId, wearableType, systemVersion) |
| `accessLevel` | Session access level |
| `acl` | Access control list |
| `ownerId` | Session owner user ID |
| `ownerEmail` | Session owner email |
| `recording.segmentsWritten` | Total video segments flushed |
| `recording.audioChunks` | Total audio chunks written |
| `recording.bytesToBucket` | Total bytes written to R2 |

### Recording Resumption

When a publisher reconnects to an existing session that has R2 data, the recorder detects existing `.mjpeg` and `.pcm` files and resumes segment/chunk indexing from the last written file. It also loads the existing `meta.json` for `startedAt` and `bytesToBucket`, and loads the existing `manifest.json` so MP4 export sees the full history.

### No WAV Headers

Raw PCM is stored directly. Sample rate, channels, and bit depth are in the sidecar `manifest.json` for downstream MP4 export.

### Manifest

Written every 10 seconds to `sessions/{recordingId}/manifest.json`:

| Field | Description |
|-------|-------------|
| `sessionId` | Session identifier |
| `actualFps` | Computed from video timestamps (fallback 15) |
| `audioSampleRate` | Dominant sample rate across chunks (most common wins, fallback 48000) |
| `totalFrames` | Total video frames |
| `videoSegments[]` | Per-segment metadata (index, frameCount, firstTimestampMs, lastTimestampMs, bytes) |
| `audioChunks[]` | Per-chunk metadata (index, sampleRate, channels, totalSamples, bytes) |

Capped at `MAX_MANIFEST_ENTRIES = 1000` entries per array. When exceeded, trimmed to the most recent 500 entries.

### Retry/Resilience

Failed writes buffered in `failedVideoParts` / `failedAudioParts` (max `MAX_FAILED_PARTS = 5` each).

- **Video**: On successful write, retries are flushed as `{key}.retry`. If the retry also fails, the data is re-buffered. Oldest failed parts are dropped when buffer exceeds cap.
- **Audio**: Failed writes are buffered. On buffer overflow (5 parts), oldest is dropped with a warning log.
- Failed writes never block the relay pipeline -- all store operations use `.catch()`.

### Activation Guard

Recording only activates on the first video frame (`ensureActive`). Audio arriving before the first video frame is silently discarded. This prevents empty recording shells from audio-only sessions.

---

## Bidirectional Audio Routing

### Publisher -> Server (Upstream)

Binary FRAU frames identified by 4-byte magic check. Server routes to:
1. All viewers via `fanoutAudio()`
2. Session recorder (strips header, stores raw PCM)
3. Audio tap bus subscribers
4. AI orchestrator (if app is active) -- forwards PCM payload only

No rate limiting on audio frames.

### Viewer -> Publisher (Downstream)

Two paths:

**1. Binary WebSocket (FRAU frame, codecType 3):**
- Server checks `isAudioFrame()`, forwards via `sendToPublisher()`
- Does NOT record or fan out to other viewers
- Logs first frame, then every 100th

**2. HTTP POST `/session/<id>/audio-in`:**
- Raw FRAU binary body
- Server validates (magic + min size check `>= AUDIO_HEADER_SIZE`), records, fans out to viewers, AND pushes to publisher
- Returns `{ ok: true, bytes: N }` or 404 if no publisher connected
- Returns 400 if payload too small or not a valid FRAU frame

### AI -> Publisher (Guidance Audio)

The `GuidanceOrchestrator` builds FRAU frames with codecType=3, 16kHz mono 16-bit PCM via `buildAudioFrame()`, sent to publisher via `sendToPublisher()` and fanned out to viewers via `fanoutAudio()`. Also recorded to session recorder.

### AI -> Publisher (Guidance Text)

Guidance text is sent to the publisher as JSON `{ type: "guidance_text", text: "..." }` for client-side TTS. Full guidance events (with bounding boxes) are sent as `{ type: "guidance_event", event: {...} }` for iOS overlay rendering.

---

## Guidance Orchestrator

The `GuidanceOrchestrator` manages per-session AI app state and broadcasts `GuidanceEvent` objects to session viewers.

### Architecture

```
ControlEventBus --> GuidanceOrchestrator --> AIService (Gemini Live, Gemma 4)
                       |                           |
                       |                           +--> Audio push (FRAU codecType 3)
                       |                           +--> Guidance text push (JSON)
                       |                           +--> Bbox annotation recording
                       |                           +--> Guidance event push to publisher
                       |                           +--> Guidance persist to R2 JSONL
                       |
                       +--> Subscriber fanout (viewers, AI telemetry log)
```

### GuidanceEvent Types

| Type | Description |
|------|-------------|
| `guidance.step` | Step-by-step instruction |
| `guidance.alert` | Safety alert |
| `guidance.correction` | Course correction |
| `guidance.identification` | Object identification |
| `guidance.acknowledgment` | Acknowledgment of user action |
| `guidance.transcript` | Speech transcript |
| `guidance.bbox` | Bounding box detection |

### GuidanceEvent Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `GuidanceEventType` | Event type |
| `content` | `string` | Text content |
| `confidence` | `number` | Confidence score |
| `source` | `string` | App ID that generated this |
| `trigger` | `string` | What triggered this event |
| `timestampMs` | `number` | Event timestamp |
| `metadata` | `object` | Optional: stepNumber, severity, objectLabel |
| `boundingBoxes` | `BoundingBox[]` | Optional: detected objects |

### AIStatus Fields

| Field | Type | Description |
|-------|------|-------------|
| `appId` | `string \| null` | Active app ID |
| `status` | `string` | `"idle" \| "activating" \| "active" \| "error" \| "rate_limited"` |
| `activatedAt` | `number \| undefined` | Activation timestamp |
| `triggerCount` | `number` | Total triggers sent |
| `lastResponseMs` | `number \| undefined` | Last AI response latency |
| `retryInSec` | `number \| undefined` | Seconds until next rate-limit retry |
| `retryAttempt` | `number \| undefined` | Current retry attempt (1-based) |

### AITelemetry Fields

| Field | Type | Description |
|-------|------|-------------|
| `triggers` | `number` | Total triggers |
| `guidanceEvents` | `number` | Total guidance events generated |
| `avgLatencyMs` | `number` | Average response latency |
| `lastLatencyMs` | `number \| null` | Most recent response latency |
| `queueDepth` | `number` | Pending frames/audio in queue |
| `uptimeMs` | `number` | Time since app activation |

### Orchestrator Callbacks (set in server.ts)

| Callback | Purpose |
|----------|---------|
| `setAudioPushFn` | Wraps AI audio as FRAU codecType 3, fans out to viewers, pushes to publisher, records |
| `setGuidanceTextPushFn` | Sends guidance text to publisher WebSocket for client-side TTS |
| `setBboxAnnotationFn` | Records bounding box annotations to `annotations.jsonl` |
| `setGuidanceEventPushFn` | Pushes full guidance events to publisher for iOS overlay |
| `setGuidancePersistFn` | Persists guidance events to `guidance.jsonl` via session recorder |

### Session Cleanup

When a session is destroyed (expires or is garbage collected), the registry invokes `orchestrator.cleanup(id)` which tears down AI state, cancels reconnect timers, and removes all per-session maps.

### Event History

Per-session event history is capped at `MAX_EVENT_HISTORY = 100` events in memory. Persisted history is available via the `/session/<id>/guidance/history` endpoint which reads from R2 `guidance.jsonl`.

---

## session_info Broadcast

The `buildSessionInfo()` function generates a payload broadcast to all viewers when:
- A viewer first connects (sent individually)
- Publisher sends a `hello` message (device info now available)
- Publisher status changes (standby, live, dropped)

### Payload Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"session_info"` | Message type identifier |
| `deviceId` | `string \| null` | Publisher device ID |
| `deviceName` | `string \| null` | Publisher device name |
| `deviceModel` | `string \| null` | Publisher device model |
| `wearableType` | `string \| null` | Wearable device type |
| `systemVersion` | `string \| null` | iOS system version |
| `appVersion` | `string \| null` | App version |
| `buildNumber` | `string \| null` | Build number |
| `viewerCount` | `number` | Current connected viewer count |
| `recording` | `boolean` | Whether recording is active |
| `linkState` | `string \| null` | Bluetooth link state |
| `publisherStatus` | `string` | `"standby" \| "live" \| "offline"` |
| `sessionAge` | `number` | Milliseconds since session creation |
| `connectedAt` | `number` | Session creation timestamp |

---

## APNs Push Notification System

The server includes a direct APNs HTTP/2 client (`apns.ts`) for waking iOS devices that are in standby or background.

### Configuration (Environment Variables)

| Variable | Required | Description |
|----------|----------|-------------|
| `APNS_KEY_ID` | Yes | Apple Key ID from developer portal |
| `APNS_TEAM_ID` | Yes | Apple Team ID |
| `APNS_KEY_B64` | Yes | Base64-encoded .p8 key body (preferred) |
| `APNS_KEY_PEM` | Fallback | PEM-formatted .p8 key (has escaping issues) |
| `APNS_BUNDLE_ID` | Yes | App bundle ID (default: `ebowwa.caringmind`) |
| `APNS_PRODUCTION` | No | `"true"` for production, otherwise sandbox |

### JWT Authentication

- Uses ES256 (ECDSA + SHA256) signing with the .p8 private key
- Provider token cached for 50 minutes (Apple max 1 hour)
- Reuses `node:http2` for APNs communication (Bun's fetch does not handle HTTP/2 responses correctly)

### Push Types

| Type | Function | Behavior |
|------|----------|----------|
| Silent push | `sendSilentWake()` | `content-available: 1`, wakes app in background with ~30s execution time |
| Visible push | `sendVisibleWake()` | Shows banner notification user can tap; reliable fallback when silent push is throttled |

Both are sent simultaneously on `/api/wake-device` for maximum reliability.

### Token Validation

If APNs returns `Unregistered` or `BadDeviceToken`, the server automatically clears the stored device token from the database via `dbWriter.enqueue(q.clearDeviceToken(deviceId))`.

### Device Already Connected

If the device already has an active WebSocket connection when wake is requested, the server sends `{ type: "start_stream" }` directly via WebSocket instead of APNs push. Response includes `{ status: "already_connected" }`.

---

## WASM Throttle

The server loads a WASM `FrameRelay` class at startup from `pkg/frame_relay_wasm.js`. If the WASM file is not found or fails to load, the server runs in pure JS mode without frame throttling.

- The WASM class constructor is stored once in the registry (`setFrameRelayClass`)
- Instances are created per-session (lazy)
- Designed for 30 FPS throttle
- The token bucket rate limiter (in `types.ts`) operates independently, using `QualityPreset` settings

The `wasmLoaded()` status is exposed via the `/health` and `/stats` endpoints.

---

## Viewer Token Bucket Rate Limiter

Each viewer gets a `TokenBucket` initialized from their `QualityPreset`. The bucket controls how many frames the viewer receives per second.

| Parameter | Description |
|-----------|-------------|
| `tokens` | Current token count (fractional, consumed per frame) |
| `maxBurst` | Bucket capacity (burst allowance, `max(2, ceil(maxFps * 0.1))`) |
| `refillRate` | Tokens per millisecond (`maxFps / 1000`) |
| `lastRefill` | Timestamp of last refill |

When `bucketTryConsume()` returns false, the frame is silently dropped and `viewer.throttledCount` is incremented. Quality presets are configurable per-viewer via the `config` message.

---

## HTTP Endpoints

### Health and Stats

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Zero-I/O health check. Returns `{ ok, uptimeMs, wasmLoaded, timestamp, gitCommit, buildVersion }` |
| GET | `/stats` | Platform-wide + per-session stats (delegates to `computeStats`) |

### Session Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions` | JSON list of active sessions (with publisher/viewer counts, metadata, uptime) + historical session IDs from R2 |
| GET | `/gallery/api` | JSON feed with metadata + thumbnails for gallery UI. Merges live sessions not yet in R2. Cache-Control: 30s |
| GET | `/apps` | List registered AI apps from AppRegistry |

### Session Data

| Method | Path | Description |
|--------|------|-------------|
| GET | `/session/<id>/thumbnail` | Mid-frame JPEG (cached to R2, Cache-Control: 86400s) |
| GET | `/session/<id>/video.mp4` | MP4 export (proxied from R2 cache or built on demand with `?audio` for audio mux) |
| GET | `/session/<id>/export` | JSON metadata about recorded session |
| GET | `/session/<id>/video/<seg>` | Signed R2 URL redirect to raw video segment (1h TTL) |
| GET | `/session/<id>/audio/<chunk>` | Signed R2 URL redirect to raw audio chunk (1h TTL) |

### Session Control

| Method | Path | Description |
|--------|------|-------------|
| POST | `/session/<id>/audio-in` | Push FRAU audio to publisher. Validates magic + min size, records, fans out, pushes to publisher. Returns `{ ok, bytes }` or 404/400 |

### Guidance and AI

| Method | Path | Description |
|--------|------|-------------|
| GET | `/session/<id>/guidance` | In-memory guidance history, AI status, and telemetry |
| GET | `/session/<id>/guidance/history` | Persisted guidance events from R2 `guidance.jsonl`. Returns `{ events: [...], count: N }` |
| GET | `/telemetry/ai` | Aggregate AI telemetry across all sessions, or per-session with `?session=<id>` |

### APNs Device Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/registered-devices` | List all devices with registered APNs tokens |
| POST | `/api/device-token` | Register APNs device token. Body: `{ deviceId, deviceToken, platform?, bundleId? }`. Immediately flushed to DB |
| POST | `/api/wake-device` | Wake device via APNs push. Body: `{ deviceId?, sessionId? }`. Sends silent + visible push simultaneously |

### Runtime Config

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Runtime config for SPA. Returns `{ noAuth: true, version: { gitCommit, buildVersion } }` |

### Latest Session

| Method | Path | Description |
|--------|------|-------------|
| GET | `/latest/video.mp4` | 302 redirect to most recent session's MP4 export (with `?audio`) |
| GET | `/latest/export` | JSON metadata for most recent session |

### WebSocket Endpoints

| Path | Query Params | Description |
|------|-------------|-------------|
| `/publish` | `?session=<id>` or `?device=<deviceId>` | iOS publisher WebSocket. Publisher starts in standby; transitions to active on `stream_changed` |
| `/view` | `?session=<id>` | Browser viewer WebSocket. Receives cached last frame + session_info on connect |
| `/tap/audio` | `?session=<id>` | Audio tap WebSocket for AI pipeline. Receives binary FRAU frames |
| `/telemetry/ai/log` | `?session=<id>` (optional) | Live AI guidance event log. Subscribes to all sessions if no session param. Sends initial status + history on connect |

---

## CORS Handling

The server does not implement any CORS headers. It relies on being served behind a reverse proxy (Caddy) that handles CORS and serves the SPA frontend. Direct browser access to the API from a different origin will fail without the proxy.

---

## Server Configuration

| Setting | Value | Source |
|---------|-------|--------|
| Bind address | `0.0.0.0` (direct) / `127.0.0.1` (gateway mode) | `RELAY_TRUST_HEADERS` env var |
| Port | Configurable | `RELAY_PORT` env var (default 8080) |
| WebSocket idle timeout | 120 seconds | Bun `idleTimeout: 120` |
| Trusted headers | On/Off | `RELAY_TRUST_HEADERS=1` enables X-Forwarded-For, X-Real-IP, X-Forwarded-Proto |

---

## Background Timers and Intervals

| Timer | Interval | Purpose |
|-------|----------|---------|
| Stale cleanup | 5s | Evict stale publishers (15s), viewers (30s), expired sessions (60s/300s) |
| Session stats flush | 30s | Write per-session stats to SQLite |
| Gallery index refresh | 120s | Rebuild R2 gallery index, prune stale entries |
| Empty shell cleanup | One-time 15s after start | Remove sessions with no data |
| DbWriter flush | 5s | Batch write queued SQLite operations |
| DbWriter counter flush | 60s | Batch write counter increments |
| Recording segment flush | 10s | Flush video/audio/guidance buffers to R2 |

---

## SQLite Shadow Writes

All session lifecycle events are shadow-written to SQLite via `DbWriter` (a batched async queue):

- **Queue**: Write operations are enqueued, not executed immediately
- **Flush**: Queue is flushed every 5 seconds
- **Counters**: Increment-only counters (frames relayed, viewers rejected, etc.) are flushed every 60 seconds
- **Immediate flush**: `flushNow()` for latency-sensitive writes (e.g., APNs token registration)
- **Errors**: Logged but never block the relay pipeline

### Tracked Events

| Event | Query |
|-------|-------|
| Session created | `upsertSession` |
| Session activated | `activateSession` |
| Session ended | `endSession` (duration, frames, bytes, resolution) |
| Viewer connected | `addViewer` |
| Viewer disconnected | `removeViewer` |
| Device upserted | `upsertDevice` |
| Device token registered | `updateDeviceToken` |
| Device token cleared | `clearDeviceToken` |
| Device status updated | `updateDeviceStatus` |
| Session stats updated | `updateSessionStats` |
| Counter incremented | `incrementCounter` (publisher_reconnects, sessions_started, total_frames_relayed, viewers_rejected) |

---

## Graceful Shutdown

On SIGTERM or SIGINT:

1. Stop stale cleanup timer
2. Stop session store background timers (gallery index)
3. Stop guidance orchestrator
4. Finish all active recorders (final flush of video, audio, guidance, manifest, meta)
5. Stop Bun server (`server.stop(true)`)
6. Exit with code 0

Unhandled rejections and uncaught exceptions are logged but do not crash the process.

---

## Publisher JSON Control Messages

The publisher sends JSON messages over its WebSocket to control session state:

| Message Type | Direction | Description |
|-------------|-----------|-------------|
| `hello` | Publisher -> Server | Device info, wearable type, battery, etc. Fields capped at 256 chars. Triggers device binding, session_info broadcast, recorder device info update |
| `stream_changed` | Publisher -> Server | `streaming: true` activates publisher + recorder; `streaming: false` reverts to standby |
| `standby` | Publisher -> Server | Announces standby state (`status: "ready"`) |
| `gesture` | Publisher -> Server | Gesture from iOS. Resolves app by gesture, activates via orchestrator, sends cached frame to AI |
| `activate_app` | Publisher -> Server | Activate an AI app by appId |
| `deactivate_app` | Publisher -> Server | Deactivate current AI app |
| `set_vision_fps` | Publisher -> Server | Set AI vision frame rate (clamped 0.1-5 FPS) |
| `audio_mode_changed` | Publisher -> Server | Acknowledges audio mode change, broadcast to viewers |
| `audio_config` | Publisher -> Server | Responds with current audio config, broadcast to viewers |
| `photo_captured` | Publisher -> Server | Broadcast to viewers |
| `recording_changed` | Publisher -> Server | Broadcast recording state to viewers |
| `publisher_telemetry` | Publisher -> Server | Battery level/state/lowPowerMode, broadcast to viewers |
| `link_state_changed` | Publisher -> Server | Bluetooth link state, broadcast to viewers |
| `publisher_error` | Publisher -> Server | Error from publisher, broadcast to viewers |
| `codec_changed` | Publisher -> Server | Video codec change notification, broadcast to viewers |
| `spoken_text` | Publisher -> Server | Text spoken via TTS, broadcast to viewers |
| `backpressure_ack` | Publisher -> Server | Acknowledges backpressure adjustment |

## Viewer JSON Control Messages

The viewer sends JSON messages to control the session:

| Message Type | Direction | Description |
|-------------|-----------|-------------|
| `hello` | Viewer -> Server | Viewer identity with `gitCommit` and `buildVersion` |
| `stats` | Viewer -> Server | Request platform stats |
| `config` | Viewer -> Server | Set quality preset (`quality` field must match a `QUALITY_PRESETS` key). Recreates token bucket |
| `activate_app` | Viewer -> Server | Activate AI app (same as publisher) |
| `deactivate_app` | Viewer -> Server | Deactivate AI app |
| `trigger_gesture` | Viewer -> Server | Simulate gesture for testing |
| `set_vision_fps` | Viewer -> Server | Set AI vision FPS (clamped 0.1-5) |
| `send_text` | Viewer -> Server | Send text prompt to active AI (capped 1000 chars) |
| `ai_telemetry` | Viewer -> Server | Request AI telemetry |
| `backpressure` | Viewer -> Server | Relay target FPS to publisher (clamped 1-60) |
| `set_audio_mode` | Viewer -> Server | Switch mic source (`phone`, `glasses`, `all`) |
| `set_audio_gain` | Viewer -> Server | Per-source gain control |
| `set_noise_gate` | Viewer -> Server | Per-source noise gate threshold |
| `set_noise_suppression` | Viewer -> Server | Per-source noise suppression toggle |
| `set_audio_mix` | Viewer -> Server | Audio mix control (weights for phone/glasses) |
| `get_audio_config` | Viewer -> Server | Request current audio config from publisher |
| `capture_photo` | Viewer -> Server | Trigger photo capture on publisher |
| `start_recording` / `stop_recording` | Viewer -> Server | Control recording on publisher |
| `start_stream` / `stop_stream` | Viewer -> Server | Control streaming on publisher |
| `speak_text` | Viewer -> Server | Trigger TTS on publisher (capped 500 chars) |
| `set_codec` | Viewer -> Server | Switch video codec (`jpeg`, `h264`) |
