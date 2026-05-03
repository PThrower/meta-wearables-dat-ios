# PRD-014: Unified Telemetry & Stats

**Product:** com.mwdat-ios / Platform Telemetry
**Owner:** @ebowwa
**Status:** Draft
**Last Updated:** 2026-04-10
**Depends On:** PRD-002 (Relay Platform), PRD-013 (Platform API Surface / Frame Pipeline)

---

## Problem

Stats are siloed across channels with no unified collection, aggregation, or query surface:

- **iOS client** (`TelemetryService`): Rich local metrics (FPS, jitter, frame count, drops, TTFF, connection state, errors, device info) but never leaves the device. No reporting to relay.
- **Relay server** (`SessionRegistry.stats()`): Monolithic 170-line method computing everything in one shot -- server metrics, per-session breakdowns, gallery aggregates, bandwidth. Only runs when `/stats` is hit. Stats split between P0-8 (pipeline stats stage runs always) and this endpoint.
- **Browser viewer**: Zero telemetry. No FPS, no connection quality, no error tracking, no frame drops.
- **AI workers**: No telemetry at all.
- **Audio**: `AudioTapBus` counts taps but produces no structured stats.

No channel knows about any other channel's state. The relay can't report iOS-side metrics (jitter, TTFF, encoding latency) because the iOS client never sends them. The browser can't report viewer-side latency because there's no reporting mechanism. The pipeline (PRD-013 P0-8) produces stats but they're all relay-side -- nothing from upstream or downstream.

Additionally, the publisher hello message reports `appVersion` and `buildNumber` but not the DAT SDK version. Multiple SDK versions could be in the wild (0.5.0, 0.6.x) with no way to know which publishers are on which version.

---

## Channels

| Channel | Direction | Current Stats | Reporting |
|---------|-----------|---------------|-----------|
| **iOS Publisher** | Upstream | FPS, jitter, frame count, drops, TTFF, encoding latency, errors, connection state | None (local HUD only) |
| **Relay Server** | Platform | Publisher counts, viewer counts, bandwidth, throttle, recording, gallery | `/stats` endpoint |
| **Browser Viewer** | Downstream | None | None |
| **AI Worker** | Downstream | None | None |
| **Audio Tap** | Sideband | Tap count | `AudioTapBus.tapCount()` only |

---

## Requirements

### P0 -- Must Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P0-1 | iOS publisher reports telemetry to relay | `RelayStage` sends periodic JSON telemetry messages (every 5s) with FPS, jitter, frame count, drops, encoding latency, TTFF, errors; relay stores on `Publisher` object |
| P0-2 | Browser viewer reports telemetry to relay | Viewer sends periodic JSON telemetry messages (every 5s) with received FPS, jitter, frame drops, connection quality; relay stores on `Viewer` object |
| P0-3 | Unified stats API endpoint | `/api/v1/stats` includes relay-side pipeline stats + upstream iOS metrics + downstream viewer metrics in one response |
| P0-4 | Per-session stats endpoint | `/api/v1/sessions/<id>/stats` returns full session telemetry: publisher metrics, viewer aggregate, pipeline stage stats, recording status |
| P0-5 | `sdkVersion` in publisher hello metadata | iOS client sends `"sdkVersion": "0.5.0"` in the hello JSON; relay stores on `Publisher` object; exposed in stats/export |
| P0-6 | Pipeline stats stage runs always | `StatsStage` (from PRD-013 P0-8) runs regardless of viewer count; updates publisher counters, timing, resolution metadata on every frame |

### P1 -- Should Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P1-1 | AI worker reports telemetry | Connected `/analyze` workers send periodic stats (frames processed, inference latency, queue depth) |
| P1-2 | Audio tap structured stats | `AudioTapBus` exposes per-tap stats (frame count, bytes, codecType breakdown) instead of just `tapCount()` |
| P1-3 | Telemetry history buffer | Relay keeps last N telemetry reports per channel (configurable, default 12 = 1 minute at 5s interval) for trend analysis |
| P1-4 | Stats export to S3 | On session end, final telemetry snapshot written to `sessions/<id>/telemetry.json` alongside `meta.json` |

### P2 -- Could Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P2-1 | WebSocket stats push | Real-time stats available via WebSocket (`/api/v1/stats/stream`) for live dashboard |
| P2-2 | Alert on metric threshold | Configurable alerts: FPS drops below threshold, viewer count spikes, encoding latency exceeds target |
| P2-3 | Per-viewer latency measurement | FRLY timestamp comparison at viewer gives end-to-end latency per viewer |

---

## Telemetry Message Format

All channels use the same envelope. Different payloads per source.

### Envelope

```typescript
interface TelemetryMessage {
  type: "telemetry"
  source: "publisher" | "viewer" | "analyzer"
  sessionId: string
  timestampMs: number
  payload: PublisherPayload | ViewerPayload | AnalyzerPayload
}
```

### Publisher Payload (iOS -> Relay)

```typescript
interface PublisherPayload {
  // Frame pipeline
  fps: number                    // effective FPS (rolling 1s window)
  jitterMs: number | null        // mean frame interval deviation
  frameCount: number             // total frames since connect
  droppedFrames: number          // frames dropped (encoding busy, backpressure)
  encodingLatencyMs: number      // average JPEG encode time (rolling window)

  // Session
  ttffMs: number | null          // time to first frame
  uptimeMs: number               // time since streaming started
  sessionState: string           // "streaming" | "paused" | "stopped"

  // Connection
  linkState: string              // "connected" | "disconnected" | "connecting"
  connectedDurationMs: number    // total BLE connected time

  // Errors
  errorCount: number             // total StreamSessionError count
  lastError: string | null       // most recent error description

  // Device
  batteryLevel: number | null    // glasses battery (if available)
  thermalState: string           // "nominal" | "fair" | "serious" | "critical"

  // SDK
  sdkVersion: string             // DAT SDK version (e.g., "0.5.0")
  appVersion: string             // app version (e.g., "1.0.0")
  buildNumber: string            // build number
}
```

### Viewer Payload (Browser -> Relay)

```typescript
interface ViewerPayload {
  // Frame reception
  fps: number                    // received FPS
  jitterMs: number | null        // frame interval deviation
  frameCount: number             // total frames received
  droppedFrames: number          // frames expected but not received (sequence gaps)
  avgFrameSizeKb: number         // average JPEG size

  // Connection
  latencyMs: number | null       // estimated relay-to-viewer latency (FRLY timestamp delta)
  uptimeMs: number               // time since viewer connected
  qualityPreset: string          // "high" | "medium" | "low" | "mini"

  // Audio
  audioCodecTypes: number[]      // which audio sources are being received

  // Client
  userAgent: string              // browser user agent
  sdkVersion: string             // viewer SDK version (git commit or build version)
}
```

### Analyzer Payload (AI Worker -> Relay)

```typescript
interface AnalyzerPayload {
  fps: number                    // frames processed per second
  framesProcessed: number        // total frames processed
  inferenceLatencyMs: number     // average inference time
  queueDepth: number             // frames waiting in processing queue
  modelVersion: string           // which model is running
}
```

---

## Transport

Telemetry messages are sent over the existing WebSocket connection as JSON strings. No new endpoints.

| Channel | Existing WebSocket | Message |
|---------|-------------------|---------|
| iOS Publisher | `/publish?session=<id>` | `RelayStage` sends telemetry JSON every 5s alongside binary frames |
| Browser Viewer | `/view?session=<id>` | Viewer JS sends telemetry JSON every 5s alongside quality config messages |
| AI Worker | `/analyze?session=<id>` | Analyzer sends telemetry JSON every 5s |

The relay already handles JSON control messages from publishers (`type: "hello"`, `type: "config"`) and viewers (`type: "stats"`, `type: "config"`, `type: "hello"`). Telemetry adds a new `type: "telemetry"` to the same message stream.

---

## SDK Version Tracking

### iOS Publisher Hello

Current `sendHello()` in `RelayStage.swift`:
```swift
let hello: [String: String] = [
    "type": "hello",
    "deviceId": deviceId,
    "deviceName": deviceName,
    "deviceModel": hardwareModel,
    "systemVersion": systemVersion,
    "wearableId": ...,
    "wearableType": ...,
    "appVersion": ...,       // CFBundleShortVersionString
    "buildNumber": ...,      // CFBundleVersion
]
```

Add `sdkVersion`:
```swift
let hello: [String: String] = [
    "type": "hello",
    // ... existing fields ...
    "sdkVersion": "0.5.0",   // Meta DAT SDK version from Package.swift
    "appVersion": ...,
    "buildNumber": ...,
]
```

### Relay Storage

Add `sdkVersion` to the `Publisher` interface in `types.ts`:
```typescript
export interface Publisher {
  // ... existing fields ...
  sdkVersion: string | null   // DAT SDK version (e.g., "0.5.0")
}
```

Store in `server.ts` hello handler alongside existing fields:
```typescript
session.publisher.sdkVersion = cmd.sdkVersion || null;
session.metadata.sdkVersion = cmd.sdkVersion || null;
```

### Browser Viewer Hello

Current viewer hello sends `gitCommit` and `buildVersion`. Add `sdkVersion` (same concept -- viewer SDK version for the browser SDK when it exists).

### Session Metadata

Add to `SessionMetadata`:
```typescript
export interface SessionMetadata {
  // ... existing fields ...
  sdkVersion: string | null
}
```

Written to `meta.json` on session end. Visible in gallery, export, and stats.

---

## Relay-Side Aggregation

The `StatsStage` (from PRD-013) runs on every frame. It maintains:

```
Session {
  // ... existing fields ...
  telemetry: {
    publisher: PublisherPayload | null     // last received from iOS
    viewerAggregate: {
      avgFps: number                       // average across all viewers
      avgJitterMs: number
      totalFrameCount: number
      totalDroppedFrames: number
      avgLatencyMs: number | null
    }
    analyzers: Map<string, AnalyzerPayload>  // per-analyzer last report
    publisherHistory: PublisherPayload[]     // last 12 reports
    viewerHistory: ViewerAggregate[]         // last 12 reports
  }
}
```

`/api/v1/stats` returns platform-wide aggregate.
`/api/v1/sessions/<id>/stats` returns per-session telemetry including channel-specific payloads.

---

## Key Files

| File | Change |
|------|--------|
| `hosted/server/src/types.ts` | Add `sdkVersion` to `Publisher`, `SessionMetadata`; add `TelemetryMessage` types |
| `hosted/server/src/server.ts` | Handle `type: "telemetry"` JSON messages from publishers, viewers, analyzers |
| `hosted/server/src/session-registry.ts` | Remove monolithic `stats()`; split into `platformStats()` and `sessionStats(id)` |
| `hosted/server/src/stages/stats.ts` | Pipeline stats stage (from PRD-013); runs on every frame |
| `publishers/CameraAccess/CameraAccess/Pipeline/Stages/RelayStage.swift` | Add `sdkVersion` to hello; send telemetry JSON every 5s |
| `publishers/CameraAccess/CameraAccess/Services/TelemetryService.swift` | Expose structured `TelemetrySnapshot` for `RelayStage` to report |
| `hosted/viewer/` | Add telemetry reporting (5s interval JSON messages) |

---

## Dependency Graph

```
PRD-014 (Unified Telemetry)
   |
   +---> PRD-002 (relay stores telemetry on session/publisher)
   +---> PRD-013 (pipeline StatsStage runs on every frame; /api/v1/stats endpoint)
   +---> PRD-001 (iOS TelemetryService produces structured metrics)
```

---

## Success Metrics

| Metric | Target | Method |
|--------|--------|--------|
| Telemetry reporting interval | 5s +/- 1s per channel | Timestamp delta in relay logs |
| Stats endpoint latency | < 100ms p95 | Server timing |
| Publisher SDK version coverage | 100% of connected publishers report sdkVersion | `/api/v1/sessions/<id>/stats` check |
| Viewer telemetry coverage | 100% of connected viewers report stats | `/api/v1/sessions/<id>/stats` check |

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Telemetry messages increase WebSocket load | Low | JSON payload is ~500 bytes every 5s; negligible vs binary frame traffic |
| iOS TelemetryService is `@MainActor` -- telemetry reporting must not block UI | Medium | RelayStage is an actor; telemetry send is fire-and-forget on the WebSocket |
| Stats aggregation on relay grows with concurrent sessions | Medium | Fixed-size history buffer (12 reports per channel per session); cap concurrent sessions |
