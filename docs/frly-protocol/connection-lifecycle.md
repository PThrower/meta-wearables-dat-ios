# Connection Lifecycle

Connect, streaming, disconnect, and reconnection behavior for the FRLY/FRAU protocol.

---

## Connect (Publisher)

```
iOS App                                     Relay Server
  |                                              |
  |--- ws connect /publish?session=<id>&device=<id> -->|
  |<-- connection open -------------------------|
  |<-- JSON "session_assigned" { sessionId } ---|
  |--- JSON "hello" (device identity) --------->|
  |--- JSON "stream_changed" { streaming: true } ->|  (when streaming starts)
  |<-- JSON "publisher_status" { status: "standby" } (broadcast to viewers)
  |--- binary FRLY keyframe -------------------->|
  |--- binary FRAU audio chunks ---------------->|
  |<-- binary FRAU inbound audio (server->publisher) --|
  |<-- JSON control messages (guidance, commands) -----|
  |                                              |
  |  (keepalive: ping every 5s)                  |
  |                                              |
```

1. `RelayStage.connect()` creates `URLSessionWebSocketTask` to `wss://relay.simulationapi.com/publish?session=<id>&device=<deviceId>`
2. 5-second connection timeout via `CheckedContinuation`
3. On open, server calls `registry.claimPublisher()` then sends `session_assigned` with the resolved session ID
4. iOS sends JSON `hello` with device metadata (see sendHello section below)
5. Starts receive loop (required by `URLSessionWebSocketTask`)
6. Starts keepalive loop (5s ping interval)
7. Resets sequence counter, stats, and adaptive quality state

### WebSocket URL Parameters

| Param | Endpoint | Required | Description |
|-------|----------|----------|-------------|
| `session` | /publish, /view | No | Explicit session ID. If omitted, publisher uses device-keyed resolution; viewer defaults to `"default"` |
| `device` | /publish | No | Device ID for stable session binding. Creates session ID `dev-<first8chars>`. Persists across reconnects via `deviceSessionMap` |
| `token` | /view | No | Auth/JWT token for viewer authentication (stored in localStorage, re-read on reconnect) |
| `role` | (internal) | N/A | Set by the server during upgrade: `"publish"`, `"view"`, `"audio-tap"`, or `"ai-log"` |

Session ID resolution order for publishers: explicit `?session=` param, then existing `deviceSessionMap` lookup, then new `dev-<deviceId[:8]>`, then random UUID fallback.

---

## Connect (Viewer)

```
Browser Viewer                              Relay Server
  |                                              |
  |--- ws connect /view?session=<id> ----------->|
  |--- JSON "hello" { token, gitCommit, buildVersion } -->|
  |<-- JSON "session_info" { device info } -----|
  |<-- binary cached last FRLY frame -----------|  (instant scene)
  |<-- JSON guidance events (subscribed) -------|
  |<-- binary FRLY video frames ----------------|
  |<-- binary FRAU audio frames ----------------|
  |                                              |
```

1. `RelayPlayer.connect(url, shareToken?, authToken?)` creates browser `WebSocket`
2. `binaryType = "arraybuffer"`
3. On open: sends JSON `hello` with `{ type: "hello", token, gitCommit, buildVersion }`
4. Server adds viewer via `registry.addViewer()`, subscribes to guidance events
5. Server sends cached last frame for instant display
6. Server sends `session_info` with device metadata
7. On close codes 401 or 4001: enters auth-required state, clears localStorage token
8. On close code 4003: enters access-denied state, no reconnect

---

## sendHello() -- Complete Field List

The publisher hello is sent as JSON immediately after WebSocket opens. It is dispatched from `@MainActor` because `UIDevice.current` is main-actor isolated in iOS 17+.

| Field | Type | Source | Example |
|-------|------|--------|---------|
| `type` | `String` | Literal | `"hello"` |
| `deviceId` | `String` | `UIDevice.current.identifierForVendor` | `"A1B2C3D4-E5F6-..."` |
| `deviceName` | `String` | `UIDevice.current.name` | `"iPhone"` |
| `deviceModel` | `String` | `utsname.machine` | `"iPhone14,4"` |
| `systemVersion` | `String` | `UIDevice.current.systemVersion` | `"18.1"` |
| `wearableId` | `String` | DAT SDK device ID (or `""`) | `"abc123"` |
| `wearableType` | `String` | DAT SDK device type (or `""`) | `"rayban-meta"` |
| `appVersion` | `String` | `CFBundleShortVersionString` | `"1.4.0"` |
| `buildNumber` | `String` | `CFBundleVersion` | `"42"` |
| `batteryLevel` | `Float` | `UIDevice.current.batteryLevel` | `0.87` |
| `batteryState` | `String` | Battery state enum | `"unplugged" \| "charging" \| "full" \| "unknown"` |
| `lowPowerMode` | `Bool` | `ProcessInfo.processInfo.isLowPowerModeEnabled` | `false` |
| `videoCodec` | `Int` | `encoder.codec.rawValue` | `0` (JPEG) or `1` (H.264) |

Server-side processing: fields are truncated to 256 chars via `strField()`, stored on the `Publisher` object and `session.metadata`, and trigger a `session_info` broadcast to all viewers. The `deviceId` also triggers `bindDeviceToSession()` for reconnect stability.

---

## Ping/Pong Keepalive

### iOS Publisher (WebSocket-level ping/pong)

| Property | Value |
|----------|-------|
| Mechanism | `URLSessionWebSocketTask.sendPing()` |
| Interval | 5 seconds |
| Latency measurement | `ContinuousClock.Instant` attosecond precision |
| Failure action | Mark disconnected, trigger auto-reconnect |

Latency is computed as `pongTime - pingStart` using attosecond-precision Swift clock:
```swift
let latency = pongTime - pingStart
let ms = Double(latency.components.seconds) * 1000.0
    + Double(latency.components.attoseconds) / 1_000_000_000_000_000.0
```

The keepalive loop checks `Task.isCancelled` both before and after the 5-second sleep, meaning cancellation is near-immediate even mid-sleep.

### Server (Bun built-in)

| Property | Value |
|----------|-------|
| `idleTimeout` | 120 seconds |
| Mechanism | Bun WebSocket automatic ping/pong |
| Action on idle | Connection closed by Bun |

### Viewer (browser)

The viewer relies on the browser's built-in WebSocket ping/pong handling. No application-level keepalive is needed.

---

## Stream

### Video Pipeline

```
DAT SDK CMSampleBuffer
  -> FramePipelineManager
    -> RelayStage.relayFrame()
      -> frame pacing gate (1/effectiveTargetFps interval)
      -> encode (JPEG or H.264, detached background task)
      -> WireProtocol.buildVideoFrame() (36-byte header + CRC + payload)
      -> URLSessionWebSocketTask.send(.data)
```

### Audio Pipeline

```
AVAudioEngine input tap
  -> PCMConvert.floatToPCM16()
  -> AudioPacket -> AudioEventBus
  -> AudioRelayStage subscriber
    -> noise gate (RMS threshold)
    -> noise suppression (EMA spectral subtraction)
    -> gain (dB multiplier)
    -> WireProtocol.buildFRAU() (36-byte header + CRC + PCM)
    -> RelayStage.sendRawData()
```

### Inbound FRAU Audio Receive Handling (Server -> Publisher)

The server pushes FRAU audio frames to the publisher for local playback (e.g., AI TTS output, viewer mic audio). This arrives as binary WebSocket data in the receive loop.

```swift
case .data(let data):
    if WireProtocol.parseFRAU(data) != nil {
        self.inboundAudioCount += 1
        // Throttled logging: first 3 frames + every 100th
        if self.inboundAudioCount <= 3 || self.inboundAudioCount % 100 == 0 {
            NSLog("[RelayStage] Inbound audio frame #\(self.inboundAudioCount): \(data.count) bytes")
        }
        if let handler = await self.onReceivedAudio {
            handler(data)  // Dispatches to AudioEventBus
        }
    }
```

The `onReceivedAudio` callback is set by `StreamSessionViewModel` via `setOnReceivedAudio()` before connecting. Server sources of inbound audio:
- AI guidance TTS: `orchestrator.setAudioPushFn()` builds FRAU codecType=3 (16kHz mono 16-bit) and pushes via `registry.sendToPublisher()`
- Viewer mic: browser `MediaStream` -> AudioWorklet -> FRAU codecType=3 -> `isAudioFrame()` check -> `registry.sendToPublisher()`
- REST API: `POST /session/<id>/audio-in` accepts raw FRAU frame -> fanout to viewers + push to publisher

### Single In-Flight Encode

The `isEncoding` flag prevents concurrent encodes. Only one encode runs at a time -- additional frames are silently dropped (not queued). This prevents memory pressure from accumulated pixel buffers.

### Sequence Number Semantics

Sequence numbers are u64 LE, starting at 0, incremented only on successful encode + send. Failed encodes do NOT advance the sequence counter. This means sequence numbers are gap-free within a session but may not match frame count if frames are dropped by pacing or noise gate.

### claimSequence() Guard Logic

```swift
private func claimSequence(_ seq: UInt64) -> UInt64 {
    if seq > sequenceNumber {
        sequenceNumber = seq
    }
    return sequenceNumber
}
```

The sequence number is "claimed" only after a successful encode. The detached encode task calls `claimSequence(nextSeq)` where `nextSeq = sequenceNumber + 1`. The guard ensures:
- If the encode succeeds, `seq > sequenceNumber` is true (since seq = sequenceNumber + 1), so it advances
- If a previous encode already claimed a higher number (race condition), the guard prevents regression
- Failed encodes never call `claimSequence()`, so the sequence counter stays at the last successfully sent value

This prevents sequence gaps from concurrent or failed encodes.

---

## Adaptive Quality

### EMA (Exponential Moving Average) Encode Time

The EMA tracks encode duration with smoothing factor alpha = 0.3:

```swift
private let encodeTimeAlpha: Double = 0.3
private var encodeTimeEmaMs: Double?   // nil until first sample

private func updateEncodeTime(_ encodeMs: Double) {
    if let ema = encodeTimeEmaMs {
        encodeTimeEmaMs = encodeTimeAlpha * encodeMs + (1 - encodeTimeAlpha) * ema
    } else {
        encodeTimeEmaMs = encodeMs  // First sample: initialize directly, no smoothing
    }
}
```

Key behavior: **First sample initializes EMA directly** (no smoothing against a default value). This avoids an artificial ramp-up period where the EMA would underestimate encode time.

The EMA drives:
- **Hardware FPS cap**: `1000 / (ema * 1.1)` -- never sends faster than the encoder can produce
- **JPEG quality adaptation**: quality decreased by 5% when `ema > budget * 1.2`, increased by 2% when `ema < budget * 0.8`

### Effective Target FPS

The lesser of three constraints:
1. **Server backpressure** (`serverTargetFps`) -- always wins if set
2. **Configured target FPS** (default 15)
3. **Hardware cap** from EMA: `1000 / (encodeTimeEmaMs * 1.1)`

---

## Server Backpressure

### Viewer -> Server -> Publisher Flow

The viewer runs AIMD (Additive Increase / Multiplicative Decrease) congestion control:

| Parameter | Value |
|-----------|-------|
| Initial target | 30 FPS (`AIMD_MAX_FPS`) |
| Multiplicative decrease | 0.5x (halve on drops) |
| Additive increase | +1 FPS |
| Increase interval | 3000ms (`AIMD_INCREASE_INTERVAL_MS`) |
| Minimum FPS | 1 (`AIMD_MIN_FPS`) |
| Maximum FPS | 30 (`AIMD_MAX_FPS`) |
| Bandwidth threshold | 200 KB/s (`BW_LOW_THRESHOLD`) -- below this, don't increase |

Decrease trigger: sequence gap detection (`sequence > lastSequence + 1`)
Increase trigger: no drops for 3s AND bandwidth estimate >= 200 KB/s

Viewer sends: `{ "type": "backpressure", "targetFps": <number> }`

Server relays to publisher: `{ "type": "backpressure", "targetFps": <clamped 1-60> }`

### backpressure-ack JSON Response

Publisher acknowledges backpressure adjustment by sending back:

```json
{
  "type": "backpressure-ack",
  "targetFps": 15
}
```

On the iOS side, `handleBackpressure()`:
1. Sets `serverTargetFps` to the received value
2. Resets `lastRelayTime` to nil (so next frame uses the new rate immediately, no stale interval)
3. Sends the ack JSON back to server
4. Server logs the ack: `[relay] Backpressure ack from publisher: targetFps=15 session=...`

### Server-side backpressure detection

```typescript
// In server.ts message handler for viewer messages:
if (isBackpressureMessage(cmd)) {
  const clampedFps = Math.max(1, Math.min(60, cmd.targetFps));
  const publisherWs = session.publisher?.ws;
  if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
    publisherWs.send(JSON.stringify({ type: "backpressure", targetFps: clampedFps }));
  }
}
```

Server-side ack detection:
```typescript
if (isBackpressureAckMessage(cmd)) {
  console.log(`[relay] Backpressure ack from publisher: targetFps=${cmd.targetFps} session=${sessionId}`);
}
```

---

## onControlMessage Callback Dispatch

The `onControlMessage` callback is a generic handler set by `StreamSessionViewModel` for ALL JSON messages received from the server. It fires for every parsed JSON message, including backpressure:

```swift
case .string(let text):
    if let data = text.data(using: .utf8),
       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        // Handle backpressure (also dispatched to onControlMessage)
        if json["type"] as? String == "backpressure",
           let targetFps = json["targetFps"] as? Double {
            await self.handleBackpressure(targetFps: targetFps)
        }
        // Always dispatch to control message handler
        if let handler = await self.onControlMessage {
            handler(json)
        }
    }
```

Server-to-publisher JSON message types that trigger this callback:
- `backpressure` -- FPS throttle command
- `guidance_text` -- AI guidance text for TTS playback
- `guidance_event` -- Full guidance event with bounding boxes
- `set_audio_mode` -- Mic switching command from viewer
- `set_audio_gain` -- Per-source gain control
- `set_noise_gate` -- Per-source noise gate threshold
- `set_noise_suppression` -- Toggle noise suppression
- `set_audio_mix` -- Audio mix weights
- `get_audio_config` -- Request current audio config
- `capture_photo` -- Trigger photo capture
- `start_recording` / `stop_recording` -- Recording control
- `start_stream` / `stop_stream` -- Stream control (also sent via APNs wake)
- `speak_text` -- TTS text for local playback
- `set_codec` -- Codec switch command (`"jpeg"` or `"h264"`)
- `app_status` -- App activation/deactivation confirmation

---

## getStats() Telemetry Push Mechanism

The publisher's `getStats()` method returns a dictionary of real-time telemetry:

```swift
func getStats() -> [String: Any] {
    return [
        "framesSent": framesSent,             // UInt64
        "totalBytesSent": totalBytesSent,      // UInt64
        "framesFailed": framesFailed,          // UInt64
        "framesDropped": framesDropped,        // UInt64
        "framesDroppedByPacing": framesDroppedByPacing,       // UInt64
        "framesDroppedByBackpressure": framesDroppedByBackpressure, // UInt64
        "encodeTimeEmaMs": encodeTimeEmaMs ?? 0,  // Double (0 if no samples)
        "adaptiveQuality": adaptiveQuality,    // CGFloat (0.2-0.8 for JPEG)
        "videoCodec": encoder.codec.rawValue,  // Int (0=JPEG, 1=H.264)
        "latencyMs": relayLatencyMs ?? 0,      // Double (ping/pong RTT, 0 if no pong)
        "lastFrameSizeBytes": lastFrameSizeBytes,  // Int
        "avgFrameSizeBytes": framesSent > 0 ? Int(totalBytesSent / framesSent) : 0, // Int
    ]
}
```

Stats are NOT pushed automatically over the WebSocket. The ViewModel calls `getStats()` and includes them in `publisher_telemetry` JSON messages sent to the server, which broadcasts to viewers. Stats are reset on `start()` (initial connection) but NOT on auto-reconnect -- the `start()` method is only called for fresh pipeline starts, while reconnect just re-establishes the WebSocket.

### Reconnect vs Initial Start Behavior

| State | `sequenceNumber` | `framesSent` | `encodeTimeEmaMs` | `adaptiveQuality` | `serverTargetFps` |
|-------|-------------------|--------------|--------------------|--------------------|--------------------|
| Initial `start()` | Reset to 0 | Reset to 0 | Reset to nil | Reset to 0.5 | Reset to nil |
| Auto-reconnect (`triggerReconnect`) | Preserved | Preserved | Preserved | Preserved | Preserved |
| Foreground `reconnect()` | Preserved | Preserved | Preserved | Preserved | Preserved |

Auto-reconnect only re-establishes the WebSocket connection. The sequence counter and all stats continue from where they left off, meaning the server may see a sequence jump after reconnect (which viewers handle via gap detection in AIMD).

---

## Disconnect

```
RelayStage.disconnect()
  -> cancel all tasks (receiveLoopTask, keepAliveTask, reconnectTask)
  -> cancel WebSocket with .goingAway close code
  -> invalidate URLSession
  -> auto-reconnect: exponential backoff (1s -> 2s -> 4s ... max 30s)
```

Auto-reconnect triggers on: receive loop errors, ping failures, send errors. Resets backoff to 1s on successful connect.

### Server-side Disconnect Handling

When the publisher WebSocket closes:
1. Server broadcasts `{ type: "publisher_status", status: "dropped" }` to all viewers
2. Server calls `registry.releasePublisher()` which:
   - Accumulates dropped frames from publisher timing
   - Finalizes the session recorder (R2 upload)
   - Clears `session.publisher` and `session.lastFrame`
   - Updates session state in SQLite
3. Server updates device status to `"standby"` in DB
4. Server generates thumbnail in background
5. Server invalidates gallery cache

When a viewer WebSocket closes:
1. Server calls `registry.removeViewer()`
2. Accumulates throttled quality frame count
3. Removes viewer from session viewers map
4. Cleans up guidance subscription

---

## WebSocket Close Codes

| Code | Meaning | Sender | Details |
|------|---------|--------|---------|
| **1001** (goingAway) | Normal client-initiated disconnect | iOS RelayStage | Sent by `disconnect()` via `cancel(with: .goingAway)` |
| **401** | Auth required | Server | Viewer's token is invalid/missing; viewer enters AUTH REQUIRED state |
| **4001** | Publisher claim failed | Server | Publisher already connected (OPEN WebSocket) or claim mutex is active; new connection rejected |
| **4002** | Publisher replaced/evicted | Server | Sent to OLD publisher when: (a) zombie eviction (ws not OPEN), (b) stale frame timeout (15s), or (c) dead ws detected in cleanup |
| **4003** | Access denied or viewer eviction | Server | Viewer: session owned by another user, access denied. Also used for stale viewer eviction (30s) |

### Publisher Takeover

If a new publisher connects and the existing publisher's WebSocket is no longer OPEN, the server force-closes the old connection with 4002 and gives the slot to the new one. This is NOT a rejection of the new connection -- it is a forced eviction of the old one.

If the existing publisher's WebSocket IS OPEN, the server rejects the new connection with 4001.

### Server-side Session Claim Mutex

The `publisherClaiming` boolean flag on the Session object prevents race conditions during concurrent publisher claims:

```typescript
// Mutex: prevent concurrent publisher claims
if (session.publisherClaiming) {
  return "publisher claim in progress";  // -> 4001 close
}
session.publisherClaiming = true;

// ... claim logic (zombie eviction, recorder finish, etc.) ...

session.publisher = publisher;
session.publisherClaiming = false;  // Release mutex after assignment
```

The mutex is set before any async operations (recorder finish) and released after publisher assignment. If the claim fails or the connection is rejected, the mutex is never released (the session is effectively locked), but this is acceptable because the claiming WebSocket will be closed and cleaned up.

---

## Session Management

### Single Publisher Per Session

The `claimPublisher()` method enforces one publisher per session via a mutex flag `publisherClaiming`:
- Concurrent claims blocked by mutex (returns 4001)
- Zombie eviction: non-OPEN WebSocket force-closed with 4002
- Active publisher rejection: OPEN WebSocket causes 4001 to new connection
- Cross-session eviction: same WebSocket object found in another session is evicted from the old one
- Ownership enforcement: if session has an `ownerId` that differs from the connecting user, returns 4003

### Unlimited Viewers

No maximum viewer count. Viewers tracked in `Map<string, Viewer>` and evicted only by stale cleanup.

### Session Expiry

| Session Type | Idle Expiry | Condition |
|-------------|-------------|-----------|
| Normal | 60 seconds | No publisher, no viewers |
| Device-bound | 300 seconds (5 min) | Created with `?device=<id>` query param |
| Stale publisher | 15 seconds | No frames received (standby publishers exempt) |
| Stale viewer | 30 seconds | No frames received |

Stale cleanup runs every 5 seconds via `setInterval(() => registry.cleanupStale(), 5000)`.

### Viewer Eviction Triggers

Viewers are evicted (closed with 4003) when:
1. **Stale frame timeout**: `lastReceivedAt > 0 && (now - lastReceivedAt) > 30s`, or `(now - connected) > 30s` if no frames received yet
2. **Send failure**: `viewer.ws.send(data)` throws -- viewer is immediately removed from the map
3. **Access denied**: `addViewer()` returns an error string prefixed with `"error:"` -- viewer is closed with 4003
4. **Session owned by another user**: publisher claim with mismatched `ownerId` returns 4003

### Device Binding

The `?device=<deviceId>` query param creates a stable session ID `dev-<first8chars>`. The `deviceSessionMap` persists across reconnections so the same device always returns to the same session. The hello message's `deviceId` field also triggers `bindDeviceToSession()` for clients that connect without the URL param but provide device identity in the hello JSON.

### Publisher Standby State

Publishers start in standby mode (`standby: true`, connected but not streaming). Only when they send `stream_changed` with `streaming: true` does the server:
1. Call `registry.activatePublisher()` which sets `standby = false`
2. Start the session recorder (reuses stable `recordingId` for reconnect appending)
3. Update device status to `"online"` in DB

Standby publishers are exempt from frame-based stale detection -- only WebSocket-level liveness (ping/pong, `idleTimeout`) applies. The `start_recorder` message from the viewer also triggers activation.

### Last-Frame Cache

The server caches the most recent FRLY frame per session (`session.lastFrame`). This is used for:
- Instant viewer display on connect (sent before any live frames arrive)
- AI service context when an app is activated mid-stream (JPEG payload extracted for vision)

The cache is cleared when the publisher disconnects.

---

## Auto-Reconnect

### iOS Publisher (RelayStage)

Exponential backoff on the iOS side:

| Attempt | Delay |
|---------|-------|
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4 | 8s |
| 5 | 16s |
| 6+ | 30s (max) |

Resets to 1s on successful connect. `reconnect()` method available for explicit foreground recovery. `onReconnected` callback notifies ViewModel to re-announce state (re-send hello, stream_changed, etc.).

The keepalive loop checks `Task.isCancelled` both before and after the 5-second sleep, meaning cancellation is near-immediate even mid-sleep.

### Browser Viewer (RelayPlayer)

| Property | Value |
|----------|-------|
| Initial delay | 1000ms |
| Max delay | 15000ms |
| Backoff | 2x per attempt |
| Auth failure (401, 4001) | No reconnect, enters AUTH REQUIRED state |
| Access denied (4003) | No reconnect, enters ACCESS DENIED state |
| Intentional disconnect | No reconnect |

On reconnect, the viewer re-reads the auth token from localStorage (may have been refreshed during the session). All stream state is reset: FPS counters, dropped frame count, bandwidth estimate, audio state, H.264 decoder.

---

## Log Throttling Constants

To prevent log spam, the iOS RelayStage uses modulo-based throttling:

| Log Message | Throttle Pattern | Example |
|-------------|-----------------|---------|
| Frames sent | Every 50th frame (`framesSent % 50 == 1`) | Shows frame 1, 51, 101... |
| Send errors | Every 10th error (`framesFailed % 10 == 1`) | Shows error 1, 11, 21... |
| Pacing drops | Every 500th drop (`framesDroppedByPacing % 500 == 1`) | Shows drop 1, 501, 1001... |
| Inbound audio | First 3 frames, then every 100th (`count <= 3 \|\| count % 100 == 0`) | Shows frame 1, 2, 3, 100, 200... |

The `% N == 1` pattern ensures the first occurrence is always logged (since `1 % N == 1` for all N > 0).

Server-side throttling follows the same pattern for viewer audio forwarding: first frame logged, then every 100th.
