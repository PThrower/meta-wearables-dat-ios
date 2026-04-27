# FRLY Protocol: JSON Control Messages & HTTP API

Binary frames carry media data (FRLY for video, FRAU for audio). Control signaling uses WebSocket text frames with JSON payloads. The server also exposes a REST API for session management, export, push notifications, and telemetry.

---

## Table of Contents

1. [Publisher Hello](#publisher-hello)
2. [Viewer Hello](#viewer-hello)
3. [Backpressure (AIMD Congestion Control)](#backpressure-aimd-congestion-control)
4. [Session Info Broadcast](#session-info-broadcast)
5. [Publisher Status Lifecycle](#publisher-status-lifecycle)
6. [App Activation/Deactivation](#app-activationdeactivation)
7. [Audio Control Messages](#audio-control-messages)
8. [Camera & Recording Control](#camera--recording-control)
9. [Streaming Control](#streaming-control)
10. [AI Guidance & Telemetry](#ai-guidance--telemetry)
11. [Publisher Telemetry](#publisher-telemetry)
12. [Codec & Link State](#codec--link-state)
13. [Text & TTS](#text--tts)
14. [Full Message Reference Tables](#full-message-reference-tables)
15. [HTTP API Endpoints](#http-api-endpoints)
16. [Error Response Codes](#error-response-codes)
17. [Text Field Limits](#text-field-limits)
18. [Version Negotiation](#version-negotiation)

---

## Publisher Hello

Sent by iOS immediately after WebSocket open. The server uses this for device binding, session metadata, and viewer information display.

```json
{
  "type": "hello",
  "deviceId": "string (UUID) -- iOS identifierForVendor, max 256 chars",
  "deviceName": "string -- e.g. 'Ebowwa's iPhone', max 256 chars",
  "deviceModel": "string -- e.g. 'iPhone14,4' from utsname.machine",
  "systemVersion": "string -- e.g. '18.2'",
  "wearableId": "string -- DAT SDK device ID (may be empty)",
  "wearableType": "string -- e.g. 'meta_rayban' (may be empty)",
  "appVersion": "string -- CFBundleShortVersionString",
  "buildNumber": "string -- CFBundleVersion",
  "batteryLevel": "number (0.0-1.0 or -1.0 if unknown)",
  "batteryState": "string ('unplugged'|'charging'|'full'|'unknown')",
  "lowPowerMode": "boolean -- ProcessInfo.processInfo.isLowPowerModeEnabled",
  "videoCodec": "number -- 0=JPEG, 1=H.264"
}
```

**Server processing:**
- All string fields truncated to 256 chars; null if not a string
- `batteryLevel` stored as number or null
- `batteryState` stored as string or null
- `lowPowerMode` coerced to boolean via `!!`
- If `deviceId` is present, binds device -> session for reconnection stability
- Device info persisted to SQLite (devices + sessions tables)
- Session metadata broadcast to all viewers as `session_info`

**Server response (immediately on connect):**
```json
{
  "type": "session_assigned",
  "sessionId": "string (UUID or 'dev-<first8>')"
}
```

On successful publisher connect, the server also broadcasts to all viewers:
```json
{
  "type": "publisher_status",
  "status": "standby"
}
```

---

## Viewer Hello

Sent immediately after WebSocket open. Stores build version info and optionally carries auth tokens.

```json
{
  "type": "hello",
  "token": "string (optional) -- auth token from localStorage or login",
  "gitCommit": "string (optional) -- viewer build git commit",
  "buildVersion": "string (optional) -- viewer build version"
}
```

**Server processing:**
- `gitCommit` and `buildVersion` stored on the Viewer object for telemetry
- `token` used for auth when enabled (currently disabled -- all endpoints open)

**Server response (on viewer connect):**
- Cached last video frame (binary FRLY) for instant scene preview
- `session_info` JSON with current device/viewer metadata
- Subscriber registered for guidance events (AI app updates)

---

## Backpressure (AIMD Congestion Control)

AIMD congestion control signaling between viewer, server, and publisher. The viewer runs a TCP-style AIMD loop: multiplicative decrease on frame drops, additive increase on stable delivery. All `targetFps` values clamped to [1, 60] by the server before relay.

**Viewer -> Server:**
```json
{
  "type": "backpressure",
  "targetFps": 15
}
```

**Server -> Publisher** (identical payload, relayed with clamped value):
```json
{
  "type": "backpressure",
  "targetFps": 15
}
```

**Publisher -> Server (ack):**
```json
{
  "type": "backpressure-ack",
  "targetFps": 15
}
```

**Validation:** Type guard checks `typeof msg === "object"`, `msg.type === "backpressure"`, and `typeof msg.targetFps === "number"`. Server clamps to [1, 60] before relaying.

**AIMD parameters in the viewer:**
- Decrease factor: 0.5 (halve on drops)
- Increase rate: +1 fps per interval
- Increase interval: 3000ms
- Min FPS: 1, Max FPS: 30
- Bandwidth low threshold: 200 KB/s (triggers FPS reduction)

---

## Session Info Broadcast

The server broadcasts `session_info` to all viewers whenever device metadata changes (publisher hello, telemetry updates, link state changes).

```json
{
  "type": "session_info",
  "deviceId": "string | null",
  "deviceName": "string | null",
  "deviceModel": "string | null",
  "wearableType": "string | null",
  "systemVersion": "string | null",
  "appVersion": "string | null",
  "buildNumber": "string | null",
  "viewerCount": 2,
  "recording": false,
  "linkState": "connected | disconnected | null",
  "publisherStatus": "standby | live | offline",
  "sessionAge": 123456,
  "connectedAt": 1700000000000
}
```

**`publisherStatus` derivation:**
- `"standby"` -- publisher connected but not streaming (publisher.standby = true)
- `"live"` -- publisher connected and actively streaming frames
- `"offline"` -- no publisher connected
- `"dropped"` -- publisher just disconnected (sent once on close)

**Triggered by:**
1. Publisher hello message
2. Publisher telemetry updates (battery changes)
3. Link state changes
4. New viewer connect (server sends session_info to the new viewer only)
5. Stream start/stop transitions

---

## Publisher Status Lifecycle

The publisher goes through explicit states communicated via multiple message types.

### standby (Publisher -> Server -> Viewers)

Publisher announces it is connected but not yet streaming.

```json
{
  "type": "standby",
  "status": "ready"
}
```

Server translates to viewers as:
```json
{
  "type": "publisher_status",
  "status": "standby"
}
```

### stream_changed (Publisher -> Server -> Viewers)

Publisher toggles between streaming active/inactive.

```json
{
  "type": "stream_changed",
  "streaming": true
}
```

Server processing:
- `streaming: true` -> `registry.activatePublisher()` -> starts recorder, sets standby=false
- `streaming: false` -> sets publisher.standby=true

Broadcast to viewers:
```json
{
  "type": "stream_changed",
  "streaming": true
}
```

### publisher_status (Server -> Viewers, unsolicited)

Sent when publisher connects (`"standby"`), disconnects (`"dropped"`), or changes standby state.

```json
{
  "type": "publisher_status",
  "status": "standby | live | dropped"
}
```

---

## App Activation/Deactivation

Apps are AI-powered features (vision assistants, gesture-driven pipelines) that can be activated by either the publisher or the viewer. The server routes to the GuidanceOrchestrator.

### activate_app (Publisher or Viewer -> Server)

```json
{
  "type": "activate_app",
  "appId": "string -- app identifier from AppRegistry"
}
```

**Server processing:**
- Resolves `appId` to an `AppPipeline` via `appRegistry.resolvePipeline()`
- Sets `session.activeAppId` and `session.appPipeline`
- Calls `orchestrator.activateApp(sessionId, appId)`
- Sends cached frame to AI for immediate context

**Server response to sender:**
```json
{
  "type": "app_status",
  "appId": "vision-assistant",
  "status": "active"
}
```

On failure (appId not found):
```json
{
  "type": "app_status",
  "appId": "unknown-app",
  "status": "error",
  "error": "App not found"
}
```

### deactivate_app (Publisher or Viewer -> Server)

```json
{
  "type": "deactivate_app"
}
```

**Server response to sender:**
```json
{
  "type": "app_status",
  "appId": "previous-app-id",
  "status": "inactive"
}
```

Server also calls `orchestrator.deactivateApp(sessionId)`.

### gesture (Publisher -> Server)

Hand gesture detected on-device. May auto-resolve to an app if a gesture binding exists.

```json
{
  "type": "gesture",
  "gesture": "string -- gesture name (e.g. 'thumbs_up', 'peace')",
  "confidence": 0.95,
  "timestampMs": 1700000000000
}
```

**Server processing:**
- Publishes to ControlEventBus
- If gesture resolves to an app via `appRegistry.resolveByGesture()`, auto-activates that app
- If an app is already active, sends gesture as a text trigger to the AI

### trigger_gesture (Viewer -> Server)

Viewer-simulated gesture for testing/debugging. Same processing as publisher gesture.

```json
{
  "type": "trigger_gesture",
  "gesture": "string",
  "confidence": 1.0
}
```

### set_vision_fps (Publisher or Viewer -> Server)

Adjusts the AI vision analysis frame rate. Clamped to [0.1, 5] fps.

```json
{
  "type": "set_vision_fps",
  "fps": 1.0
}
```

**Server response:**
```json
{
  "type": "vision_fps",
  "fps": 1.0
}
```

---

## Audio Control Messages

### set_audio_mode (Viewer -> Server -> Publisher)

Switches the publisher's microphone input source.

```json
{
  "type": "set_audio_mode",
  "mode": "phone | glasses | all"
}
```

Server validates `mode` is one of `["phone", "glasses", "all"]`, then relays to publisher.

### audio_mode_changed (Publisher -> Server -> Viewers)

Publisher acknowledges the audio mode was changed.

```json
{
  "type": "audio_mode_changed",
  "mode": "glasses"
}
```

Broadcast to all viewers.

### set_audio_gain (Viewer -> Server -> Publisher)

Per-source gain control in dB.

```json
{
  "type": "set_audio_gain",
  "codecType": 0,
  "gainDb": 3.0
}
```

Server relays directly to publisher.

### set_noise_gate (Viewer -> Server -> Publisher)

Per-source noise gate threshold.

```json
{
  "type": "set_noise_gate",
  "codecType": 1,
  "threshold": -40.0
}
```

Server relays directly to publisher.

### set_noise_suppression (Viewer -> Server -> Publisher)

Per-source noise suppression toggle.

```json
{
  "type": "set_noise_suppression",
  "codecType": 0,
  "enabled": true
}
```

Server relays directly to publisher.

### set_audio_mix (Viewer -> Server -> Publisher)

Audio mix control for multi-source sessions.

```json
{
  "type": "set_audio_mix",
  "enabled": true,
  "weightPhone": 0.7,
  "weightGlasses": 0.3
}
```

Server relays directly to publisher.

### get_audio_config (Viewer -> Server -> Publisher)

Requests the publisher's current audio configuration.

```json
{
  "type": "get_audio_config"
}
```

Server relays to publisher.

### audio_config (Publisher -> Server -> Viewers)

Publisher responds with current audio configuration. Broadcast to all viewers.

```json
{
  "type": "audio_config",
  "...": "publisher-defined audio config fields"
}
```

Server broadcasts the entire message as-is to all viewers.

---

## Camera & Recording Control

### capture_photo (Viewer -> Server -> Publisher)

Requests the publisher to capture a high-resolution still photo.

```json
{
  "type": "capture_photo"
}
```

Server relays to publisher.

### photo_captured (Publisher -> Server -> Viewers)

Publisher confirms photo was captured. Broadcast to all viewers.

```json
{
  "type": "photo_captured"
}
```

### start_recording (Viewer -> Server -> Publisher)

Requests the publisher to start recording.

```json
{
  "type": "start_recording"
}
```

Server relays to publisher.

### stop_recording (Viewer -> Server -> Publisher)

Requests the publisher to stop recording.

```json
{
  "type": "stop_recording"
}
```

Server relays to publisher.

### recording_changed (Publisher -> Server -> Viewers)

Publisher reports recording state change. Broadcast to all viewers.

```json
{
  "type": "recording_changed",
  "recording": true
}
```

---

## Streaming Control

### start_stream (Viewer -> Server -> Publisher)

Viewer or wake-device endpoint requests the publisher to start streaming video frames.

```json
{
  "type": "start_stream"
}
```

Also sent directly by the server when a device wake request arrives and the device is already connected (no APNs push needed).

### stop_stream (Viewer -> Server -> Publisher)

```json
{
  "type": "stop_stream"
}
```

Server relays to publisher.

---

## AI Guidance & Telemetry

### guidance_event (Server -> Publisher and Viewers)

Full guidance event with bounding boxes. Sent by the GuidanceOrchestrator when AI detects objects or produces spatial annotations.

```json
{
  "type": "guidance_event",
  "event": {
    "...": "GuidanceEvent object with bounding boxes, labels, confidence"
  }
}
```

Pushed to publisher (for iOS overlay rendering) and to all subscribers (viewers + ai-log WebSocket).

### guidance_text (Server -> Publisher)

AI-generated text content for client-side TTS. Sent when the AI produces guidance that should be spoken through the glasses speakers.

```json
{
  "type": "guidance_text",
  "text": "string -- AI-generated guidance text"
}
```

### ai_telemetry (Viewer -> Server, and Server -> Viewer)

Viewer requests current AI telemetry data.

**Viewer -> Server:**
```json
{
  "type": "ai_telemetry"
}
```

**Server -> Viewer response:**
```json
{
  "type": "ai_telemetry",
  "telemetry": {
    "triggers": 10,
    "guidanceEvents": 8,
    "...": "orchestrator telemetry fields"
  }
}
```

### ai_status (Server -> ai-log WebSocket)

Sent on ai-log WebSocket connect to provide initial state.

```json
{
  "type": "ai_status",
  "status": { "...": "orchestrator status fields" }
}
```

---

## Publisher Telemetry

### publisher_telemetry (Publisher -> Server -> Viewers)

Periodic telemetry from the iOS publisher. Includes battery updates.

```json
{
  "type": "publisher_telemetry",
  "battery": {
    "level": 0.85,
    "state": "unplugged",
    "lowPowerMode": false
  },
  "...": "additional telemetry fields from publisher"
}
```

**Server processing:**
- Updates publisher battery fields from `cmd.battery`
- Broadcasts the entire message to all viewers

---

## Codec & Link State

### codec_changed (Publisher -> Server -> Viewers)

Publisher reports a codec change (e.g., JPEG to H.264).

```json
{
  "type": "codec_changed",
  "codec": "h264"
}
```

Broadcast to all viewers.

### set_codec (Viewer -> Server -> Publisher)

Viewer requests a codec change. Non-negotiated -- no ack mechanism.

```json
{
  "type": "set_codec",
  "codec": "jpeg | h264"
}
```

Server validates `codec` is `"jpeg"` or `"h264"`, then relays to publisher.

### link_state_changed (Publisher -> Server -> Viewers)

Publisher reports network link state change.

```json
{
  "type": "link_state_changed",
  "state": "connected | disconnected | unknown"
}
```

**Server processing:**
- Updates `session.linkState`
- Broadcasts to all viewers

### publisher_error (Publisher -> Server -> Viewers)

Publisher reports an error condition.

```json
{
  "type": "publisher_error",
  "error": "string -- error description",
  "state": "string -- publisher state at time of error"
}
```

Broadcast to all viewers.

---

## Text & TTS

### send_text (Viewer -> Server)

Viewer sends a text prompt to the active AI service (not to the publisher).

```json
{
  "type": "send_text",
  "text": "string (max 1000 chars) -- text prompt for AI"
}
```

**Server processing:**
- Truncates to 1000 chars
- Calls `orchestrator.sendTrigger(sessionId, text)` -- routes to active AI provider

### speak_text (Viewer -> Server -> Publisher)

Viewer requests TTS playback on the publisher device.

```json
{
  "type": "speak_text",
  "text": "string (max 500 chars)"
}
```

Server truncates to 500 chars and relays to publisher.

### spoken_text (Publisher -> Server -> Viewers)

Publisher confirms TTS text was spoken. Broadcast to all viewers.

```json
{
  "type": "spoken_text",
  "text": "string"
}
```

---

## Full Message Reference Tables

### Publisher -> Server

| Type | Purpose | Key Fields |
|------|---------|------------|
| `hello` | Device identity on connect | See [Publisher Hello](#publisher-hello) |
| `standby` | Announce standby state | `status: "ready"` |
| `stream_changed` | Streaming state toggle | `streaming: bool` |
| `backpressure-ack` | Acknowledges backpressure application | `targetFps` |
| `gesture` | Hand gesture detected on-device | `gesture`, `confidence`, `timestampMs` |
| `activate_app` | Activate an AI app | `appId` |
| `deactivate_app` | Deactivate current AI app | -- |
| `set_vision_fps` | Adjust AI vision analysis rate | `fps` (0.1-5) |
| `publisher_telemetry` | Periodic telemetry + battery | `battery.level`, `battery.state`, `battery.lowPowerMode` |
| `link_state_changed` | Network link state change | `state` ("connected"\|"disconnected"\|"unknown") |
| `publisher_error` | Error condition report | `error`, `state` |
| `codec_changed` | Codec change notification | `codec` ("jpeg"\|"h264") |
| `spoken_text` | TTS confirmation | `text` |
| `audio_mode_changed` | Audio mode change acknowledgment | `mode` ("phone"\|"glasses"\|"all") |
| `audio_config` | Current audio configuration response | Publisher-defined fields |
| `photo_captured` | Photo capture confirmation | -- |
| `recording_changed` | Recording state change | `recording: bool` |

### Viewer -> Server

| Type | Purpose | Key Fields |
|------|---------|------------|
| `hello` | Viewer identity + auth | `token`, `gitCommit`, `buildVersion` |
| `backpressure` | FPS throttle request (AIMD) | `targetFps` (1-60) |
| `config` | Quality preset selection | `quality` ("high"\|"medium"\|"low"\|"mini") |
| `stats` | Request stream statistics | -- |
| `activate_app` | Activate an AI app | `appId` |
| `deactivate_app` | Deactivate current AI app | -- |
| `trigger_gesture` | Simulate a gesture (debug) | `gesture`, `confidence` |
| `set_vision_fps` | Adjust AI vision analysis rate | `fps` (0.1-5) |
| `send_text` | Text prompt to active AI | `text` (max 1000 chars) |
| `ai_telemetry` | Request AI telemetry data | -- |
| `set_codec` | Request codec change | `codec` ("jpeg"\|"h264") |
| `speak_text` | TTS to publisher device | `text` (max 500 chars) |
| `set_audio_mode` | Switch mic input source | `mode` ("phone"\|"glasses"\|"all") |
| `set_audio_gain` | Per-source gain control | `codecType`, `gainDb` |
| `set_noise_gate` | Per-source noise gate | `codecType`, `threshold` |
| `set_noise_suppression` | Per-source noise suppression | `codecType`, `enabled` |
| `set_audio_mix` | Audio mix control | `enabled`, `weightPhone`, `weightGlasses` |
| `get_audio_config` | Request publisher audio config | -- |
| `capture_photo` | Request still photo capture | -- |
| `start_recording` | Start recording | -- |
| `stop_recording` | Stop recording | -- |
| `start_stream` | Request publisher start streaming | -- |
| `stop_stream` | Request publisher stop streaming | -- |

### Server -> Viewer

| Type | Purpose | Key Fields |
|------|---------|------------|
| `session_info` | Publisher device info + session state | See [Session Info Broadcast](#session-info-broadcast) |
| `publisher_status` | Publisher lifecycle event | `status` ("standby"\|"live"\|"dropped") |
| `stream_changed` | Streaming state relay | `streaming: bool` |
| `quality` | Quality preset confirmation | `preset`, `maxFps`, `label` |
| `stats` | Stats response | `fps`, `bytes`, `connections` |
| `app_status` | App activation result | `appId`, `status`, `error?` |
| `vision_fps` | Vision FPS confirmation | `fps` |
| `backpressure` | FPS throttle command (relay) | `targetFps` |
| `set_codec` | Codec change request (relay) | `codec` |
| `publisher_telemetry` | Publisher telemetry relay | Full publisher telemetry |
| `link_state_changed` | Link state relay | `state` |
| `publisher_error` | Publisher error relay | `error`, `state` |
| `codec_changed` | Codec change notification relay | `codec` |
| `spoken_text` | TTS confirmation relay | `text` |
| `audio_mode_changed` | Audio mode change relay | `mode` |
| `audio_config` | Audio config relay | Publisher-defined fields |
| `photo_captured` | Photo capture relay | -- |
| `recording_changed` | Recording state relay | `recording: bool` |
| `guidance_event` | AI guidance with bounding boxes | `event` (GuidanceEvent) |
| `ai_telemetry` | AI telemetry response | `telemetry` |

### Server -> Publisher

| Type | Purpose | Key Fields |
|------|---------|------------|
| `session_assigned` | Session ID assignment | `sessionId` |
| `backpressure` | FPS throttle command | `targetFps` |
| `set_codec` | Codec change request | `codec` ("jpeg"\|"h264") |
| `speak_text` | TTS request | `text` (max 500 chars) |
| `set_audio_mode` | Mic switching command | `mode` ("phone"\|"glasses"\|"all") |
| `set_audio_gain` | Gain control | `codecType`, `gainDb` |
| `set_noise_gate` | Noise gate threshold | `codecType`, `threshold` |
| `set_noise_suppression` | Noise suppression toggle | `codecType`, `enabled` |
| `set_audio_mix` | Audio mix control | `enabled`, `weightPhone`, `weightGlasses` |
| `get_audio_config` | Request audio config | -- |
| `capture_photo` | Photo capture request | -- |
| `start_recording` | Start recording request | -- |
| `stop_recording` | Stop recording request | -- |
| `start_stream` | Start streaming request | -- |
| `stop_stream` | Stop streaming request | -- |
| `guidance_text` | AI text for client-side TTS | `text` |
| `guidance_event` | AI guidance with bounding boxes | `event` |
| `app_status` | App activation confirmation | `appId`, `status` |

---

## HTTP API Endpoints

### Health & Diagnostics

#### `GET /health`

Zero-I/O health check. Returns server uptime and configuration status.

**Response:**
```json
{
  "ok": true,
  "uptimeMs": 3600000,
  "wasmLoaded": true,
  "timestamp": "2026-04-21T12:00:00.000Z",
  "gitCommit": "abc1234",
  "buildVersion": "1.2.3"
}
```

#### `GET /stats`

Platform-wide statistics plus per-session metrics.

**Response:** JSON object with aggregate stats, per-session breakdowns, and server metadata.

#### `GET /api/config`

Runtime configuration for the SPA viewer.

**Response:**
```json
{
  "noAuth": true,
  "version": {
    "gitCommit": "abc1234",
    "buildVersion": "1.2.3"
  }
}
```

### Session Management

#### `GET /sessions`

List active relay sessions and historical session IDs.

**Response:**
```json
[
  {
    "id": "session-uuid",
    "live": true,
    "publisherConnected": true,
    "viewerCount": 2,
    "metadata": { "deviceName": "...", "deviceModel": "...", "..." },
    "uptimeMs": 120000
  },
  {
    "id": "old-session-uuid",
    "live": false
  }
]
```

Only sessions that have (or had) a publisher are included.

### Gallery

#### `GET /gallery/api`

JSON feed with metadata and thumbnails for all sessions (live + recorded).

**Response:** Array of session objects:
```json
[
  {
    "sessionId": "uuid",
    "live": true,
    "startedAt": "ISO-8601",
    "device": { "deviceName": "...", "deviceModel": "...", "wearableType": "..." },
    "segments": 0,
    "audioChunks": 0,
    "exportCached": false,
    "hasThumbnail": false,
    "thumbnailUrl": "/session/uuid/thumbnail",
    "videoUrl": "/session/uuid/video.mp4?audio",
    "accessLevel": "public",
    "acl": []
  }
]
```

Cached for 30 seconds (`Cache-Control: public, max-age=30`).

### Session Export & Media

#### `GET /session/<id>/thumbnail`

Mid-frame JPEG thumbnail. Cached to R2 after first generation.

**Response:** `image/jpeg` binary. Cache-Control: `public, max-age=86400`.

**Errors:** 404 if no video data available, 500 on generation failure.

#### `GET /session/<id>/video.mp4`

MP4 export. Serves from R2 cache if available, otherwise builds and caches.

**Query params:** `?audio` -- include audio tracks in export.

**Response:** `video/mp4` binary stream. Cache-Control: `public, max-age=3600`.

**Errors:** ExportError mapped to appropriate HTTP status.

#### `GET /session/<id>/export`

JSON metadata about a recorded session.

**Response:** Session export metadata from `getSessionExportMeta()`.

#### `GET /session/<id>/video/<segment>`

Signed redirect to S3/R2 video segment.

**Response:** 302 redirect to signed URL. 404 if not found.

#### `GET /session/<id>/audio/<chunk>`

Signed redirect to S3/R2 audio chunk.

**Response:** 302 redirect to signed URL. 404 if not found.

### Audio Push

#### `POST /session/<id>/audio-in`

Push audio (FRAU frame) to the publisher and fan out to viewers.

**Request body:** Raw binary FRAU frame (must pass `isAudioFrame()` check, minimum `AUDIO_HEADER_SIZE` bytes).

**Response:**
```json
{
  "ok": true,
  "bytes": 1024
}
```

**Errors:**
- 400 -- payload too small or not a valid FRAU frame
- 404 -- no connected publisher

### AI Guidance

#### `GET /session/<id>/guidance`

AI guidance history, status, and telemetry for a session.

**Response:**
```json
{
  "history": [ "...GuidanceEvent objects..." ],
  "status": { "...orchestrator status..." },
  "telemetry": { "triggers": 10, "guidanceEvents": 8, "..." }
}
```

#### `GET /session/<id>/guidance/history`

Persisted guidance events from R2 (works for recorded sessions). Reads `sessions/<id>/guidance.jsonl`.

**Response:**
```json
{
  "events": [ "...parsed JSON events..." ],
  "count": 42
}
```

### Push Notifications (APNs)

#### `POST /api/device-token`

Register or update an APNs device token for remote wake.

**Request body:**
```json
{
  "deviceId": "string (required) -- iOS identifierForVendor",
  "deviceToken": "string (required) -- APNs device token",
  "platform": "string (optional) -- e.g. 'ios'",
  "bundleId": "string (optional) -- app bundle identifier"
}
```

**Response:**
```json
{ "ok": true }
```

**Errors:** 400 if `deviceId` or `deviceToken` missing, or invalid JSON.

#### `POST /api/wake-device`

Wake an iOS device via APNs silent + visible push. If the device is already connected via WebSocket, sends `start_stream` directly instead of push.

**Request body:**
```json
{
  "deviceId": "string (optional) -- resolved from sessionId if omitted",
  "sessionId": "string (optional) -- used to look up deviceId"
}
```

**Resolution order for deviceId:** explicit param > session metadata > in-memory map > SQLite DB.

**Response (device already connected):**
```json
{ "ok": true, "status": "already_connected" }
```

**Response (push sent):**
```json
{ "ok": true, "status": "push_sent", "silent": true, "visible": true }
```

**Errors:**
- 404 -- no device found for session, or no device token registered, or no connected publisher
- 410 -- device token invalid (Unregistered/BadDeviceToken), token cleared from DB
- 503 -- APNs not configured on server

#### `GET /api/registered-devices`

List all devices with registered APNs tokens.

**Response:** Array of device objects from SQLite.

### App Registry

#### `GET /apps`

List all registered apps and their configurations.

**Response:** Array from `appRegistry.listApps()`.

### Telemetry

#### `GET /telemetry/ai`

AI telemetry -- aggregate or per-session.

**Query params:** `?session=<id>` for per-session.

**Per-session response:**
```json
{
  "sessionId": "uuid",
  "status": { "...orchestrator status..." },
  "telemetry": { "triggers": 10, "guidanceEvents": 8 },
  "eventHistory": [ "...events..." ]
}
```

**Aggregate response:**
```json
{
  "aggregate": {
    "sessions": 3,
    "totalTriggers": 25,
    "totalGuidanceEvents": 20
  },
  "sessions": {
    "session-id": { "status": {}, "telemetry": {}, "eventCount": 8 }
  }
}
```

#### `WebSocket /telemetry/ai/log`

Live AI guidance event log. Receives `guidance_event`, `ai_status`, and `ai_telemetry` messages in real-time.

**Query params:** `?session=<id>` to filter to a specific session (default: all sessions).

On connect, server replays all existing guidance events for the subscribed session(s).

### Latest Session Shortcuts

#### `GET /latest/video.mp4`

Redirects to the most recent session's MP4 export (with audio).

**Response:** 302 redirect to `/session/<latestId>/video.mp4?audio`.

**Errors:** 404 if no recorded sessions.

#### `GET /latest/export`

JSON metadata for the most recent session.

**Response:** Session export metadata with `sessionId` added.

**Errors:** 404 if no recorded sessions.

### WebSocket Endpoints

#### `WebSocket /publish?session=<id>`

iOS publisher connects here. Binary frames are FRLY video or FRAU audio. Text frames are JSON control messages.

#### `WebSocket /view?session=<id>`

Browser viewer connects here. Receives FRLY/FRAU binary frames and JSON control messages. Can send JSON control messages and FRAU audio frames (push-to-talk).

#### `WebSocket /tap/audio?session=<id>`

Audio tap for AI pipeline. Receives binary FRAU frames for all audio passing through the session.

#### `WebSocket /telemetry/ai/log?session=<id>`

Live AI telemetry log. Receives JSON events: `ai_status`, `ai_telemetry`, `guidance_event`.

---

## Error Response Codes

### HTTP Status Codes

| Status | Meaning |
|--------|---------|
| 400 | Bad request -- invalid JSON, missing required fields, payload too small, not a FRAU frame |
| 404 | Not found -- no recorded sessions, no video data, session/device not found |
| 410 | Gone -- APNs device token invalid (Unregistered/BadDeviceToken) |
| 500 | Internal error -- export failed, thumbnail generation failed |
| 503 | Service unavailable -- APNs not configured on server |

### WebSocket Close Codes

| Code | Meaning |
|------|---------|
| 4001 | Auth required / session claim failed |
| 4003 | Access denied / session owned by another user |
| 401 | Auth token invalid (viewer) |

---

## Text Field Limits

| Field | Max Length |
|-------|-----------|
| Hello string fields (all) | 256 chars |
| `send_text` | 1000 chars |
| `speak_text` | 500 chars |

Server enforces these limits by truncation before relay.

---

## Version Negotiation

The protocol version byte is a hard requirement. There is no version exchange, no fallback, and no capability advertisement. If the version byte does not match `1`, the frame is silently dropped. The `appVersion` and `buildNumber` fields in the publisher hello are informational only -- they are not used for protocol decisions.

Codec changes are also non-negotiated. The publisher announces its codec in byte[25] of each frame. Viewers can request a codec change via `set_codec`, but there is no ack mechanism -- the viewer observes the codec changing in subsequent frames.
