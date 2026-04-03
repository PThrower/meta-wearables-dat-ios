# Telemetry and Observability

Current state of observability in the relay platform and what's missing. The server has real-time stats but no persistence, structured logging, metrics export, health checks, or tracing.

Written 2026-04-03 against commit `33ea802` on `feat/telemetry-diagnostics`.

---

## What Exists: `/stats` Endpoint

`GET /stats` returns a JSON snapshot of live server state. Also available via WebSocket command `{type: "stats"}`.

### Server Section

```json
{
  "server": {
    "uptimeMs": 1842000,
    "wasmLoaded": true,
    "ip": "192.168.1.42",
    "port": 8080
  }
}
```

### Publisher Section (when connected)

```json
{
  "publisher": {
    "id": "a1b2c3d4...",
    "clientIp": "192.168.1.100",
    "deviceId": "ABC123-DEF...",
    "deviceName": "Starlink",
    "deviceModel": "iPhone 16 Pro",
    "systemVersion": "18.3.2",
    "wearableId": "meta-rayban-001",
    "wearableType": "Ray-Ban Meta",
    "frameCount": 27600,
    "totalBytes": 1932735283,
    "totalMB": 1842.91,
    "audioCount": 9200,
    "audioBytes": 73600000,
    "audioMB": 70.19,
    "uptimeMs": 1840000,
    "latencyMs": 42,
    "video": { "width": 1280, "height": 720, "quality": 60 },
    "timing": {
      "fps": 14.8,
      "jitterMs": 12.3,
      "minIntervalMs": 33,
      "maxIntervalMs": 187,
      "droppedFrames": 14
    }
  }
}
```

### Viewers Section

```json
{
  "viewers": 3,
  "viewerStats": {
    "a1b2c3d4": {
      "clientIp": "192.168.1.50",
      "quality": "high",
      "maxFps": 30,
      "frames": 8200,
      "throttled": 4100,
      "totalBytes": 580000000,
      "totalMB": 553.13,
      "uptimeMs": 600000,
      "timing": {
        "fps": 28.4,
        "jitterMs": 8.1,
        "minIntervalMs": 30,
        "maxIntervalMs": 52,
        "droppedFrames": 3
      }
    }
  }
}
```

### FrameTiming Implementation

Per-connection timing state tracked via EMA (exponential moving average):

| Metric | Calculation | Purpose |
|--------|------------|---------|
| `fps` | EMA of `1000 / interval` (alpha=0.1) | Smoothed FPS estimate, resistant to single-frame spikes |
| `jitterMs` | EMA of `abs(interval - avgInterval)` (alpha=0.1) | Frame timing stability |
| `minIntervalMs` | Running minimum of all intervals | Best-case frame spacing |
| `maxIntervalMs` | Running maximum of all intervals | Worst-case frame spacing |
| `droppedFrames` | Sum of sequence number gaps | Frames lost between iOS and server |

Sequence gap detection: if `incomingSeq > lastSeq + 1`, the difference is added to `droppedFrames`. This catches frames lost in network transit or dropped by backpressure on the iOS side.

### Limitations of Current Approach

- **Point-in-time only** -- `/stats` shows current values, no history. Restart = everything gone.
- **No aggregation** -- no per-hour, per-session, or per-user rollups
- **No alerts** -- high jitter or dropped frames are tracked but never trigger notifications
- **No export** -- no Prometheus, OTel, or other standard metrics format

---

## Gap 1: No Structured Logging

### Current State

All logging is `console.log` with ad-hoc formatting:

```
[relay] Publisher connected: a1b2c3d4 ip=192.168.1.100
[relay] Publisher hello: device=Starlink wearable=Ray-Ban Meta ip=192.168.1.100
[relay] Viewer connected: e5f6g7h8 ip=192.168.1.50 (total: 3)
[relay] Viewer a1b2c3d4 quality: high (30 FPS)
[relay] Publisher disconnected
[relay] Viewer disconnected: e5f6g7h8 (2 remaining)
[relay] WASM not found, running pure JS
[relay] WASM loaded, throttle: 30 FPS
[relay] WASM load failed: <error>
```

No log levels, no structured fields, no correlation IDs.

### What's Needed

```ts
interface LogEntry {
  timestamp: string;          // ISO 8601
  level: "debug" | "info" | "warn" | "error";
  message: string;
  traceId?: string;           // distributed trace correlation
  sessionId?: string;         // which session this relates to
  component: "relay" | "recorder" | "analyzer" | "auth";
  fields?: Record<string, unknown>;
}
```

Output as JSON for log aggregation (Loki, Datadog, CloudWatch):

```json
{"ts":"2026-04-03T14:22:00.123Z","level":"info","msg":"publisher connected","component":"relay","sessionId":"abc123","clientIp":"192.168.1.100","deviceId":"Starlink"}
{"ts":"2026-04-03T14:22:01.456Z","level":"warn","msg":"high jitter detected","component":"relay","sessionId":"abc123","jitterMs":85.2,"fps":8.1,"threshold":50}
```

### Proposed Logger Interface

```ts
interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, err?: Error, fields?: Record<string, unknown>): void;

  /** Create child logger with persistent fields (sessionId, traceId) */
  child(fields: Record<string, unknown>): Logger;
}
```

Usage:

```ts
const log = logger.child({ sessionId: "abc123", component: "relay" });
log.info("publisher connected", { clientIp: "192.168.1.100" });
// -> {"ts":"...","level":"info","msg":"publisher connected","sessionId":"abc123","component":"relay","clientIp":"192.168.1.100"}
```

---

## Gap 2: No Health Check Endpoint

### What's Needed

`GET /health` -- lightweight liveness check for load balancers and orchestrators.

```json
{
  "status": "ok",
  "uptimeMs": 1842000,
  "wasmLoaded": true,
  "publisher": true,
  "viewers": 3
}
```

Returns 200 when healthy, 503 when degraded (e.g., WASM failed to load, or a critical dependency is down).

`GET /ready` -- readiness check. Returns 200 only when the server can accept traffic (WASM loaded, port bound). For single-instance deployments this is the same as `/health`.

---

## Gap 3: No Metrics Export

### What's Needed

Prometheus-compatible `/metrics` endpoint exporting counters, gauges, and histograms:

```
# Server
relay_uptime_ms 1842000
relay_wasm_loaded 1

# Publisher (0 when disconnected)
relay_publisher_frames_total 27600
relay_publisher_bytes_total 1.932735e+09
relay_publisher_audio_frames_total 9200
relay_publisher_audio_bytes_total 7.36e+07
relay_publisher_fps 14.8
relay_publisher_jitter_ms 12.3
relay_publisher_dropped_frames_total 14
relay_publisher_latency_ms 42

# Viewers
relay_viewers_connected 3
relay_viewer_frames_relayed_total{viewer="a1b2c3d4",quality="high"} 8200
relay_viewer_frames_throttled_total{viewer="a1b2c3d4",quality="high"} 4100
relay_viewer_bytes_total{viewer="a1b2c3d4"} 5.8e+08
relay_viewer_fps{viewer="a1b2c3d4"} 28.4
relay_viewer_jitter_ms{viewer="a1b2c3d4"} 8.1
```

### Prometheus Integration

```ts
// Simple counter/gauge registry
interface MetricsRegistry {
  counter(name: string, labels?: Record<string, string>): Counter;
  gauge(name: string, labels?: Record<string, string>): Gauge;
  histogram(name: string, buckets: number[], labels?: Record<string, string>): Histogram;
  export(): string;  // Prometheus text format
}

interface Counter { inc(value?: number): void; }
interface Gauge { set(value: number): void; inc(value?: number): void; dec(value?: number): void; }
interface Histogram { observe(value: number): void; }
```

The server already tracks all these values. The `/metrics` endpoint just formats them in Prometheus text format instead of JSON.

### OpenTelemetry Alternative

For environments using OTel collectors:

```ts
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("relay-server");
const frameCounter = meter.createCounter("relay.publisher.frames");
const fpsGauge = meter.createObservableGauge("relay.publisher.fps");
```

Both Prometheus and OTel export the same underlying data. Start with Prometheus text format (zero dependencies), add OTel exporter when needed.

---

## Gap 4: No Alerting Thresholds

### What's Tracked But Not Alerted

| Metric | Current Behavior | Alert Threshold |
|--------|-----------------|-----------------|
| `jitterMs` > 50 | Tracked silently | Warn: connection unstable |
| `fps` drops below target | Tracked silently | Warn: underperforming stream |
| `droppedFrames` growing | Tracked silently | Error: significant packet loss |
| `latencyMs` > 500 | Tracked silently | Warn: high latency to publisher |
| Publisher disconnect | Logged to console | Alert: stream interrupted |
| WASM load failure | Logged to console | Error: degraded performance |
| Viewer stale eviction | Logged to console | Info: cleaned up dead connection |

### Proposed Alert System

Lightweight, no external dependencies. Server evaluates thresholds and emits structured events:

```ts
interface AlertRule {
  metric: string;                          // "publisher.jitterMs"
  condition: "gt" | "lt" | "eq";          // threshold comparison
  threshold: number;
  severity: "info" | "warn" | "error";
  cooldownMs: number;                     // don't re-alert for same condition
  message: string;
}

const ALERT_RULES: AlertRule[] = [
  { metric: "publisher.jitterMs", condition: "gt", threshold: 50, severity: "warn", cooldownMs: 30000, message: "High frame jitter" },
  { metric: "publisher.fps", condition: "lt", threshold: 8, severity: "warn", cooldownMs: 15000, message: "Low FPS" },
  { metric: "publisher.droppedFrames", condition: "gt", threshold: 100, severity: "error", cooldownMs: 60000, message: "Excessive frame drops" },
  { metric: "publisher.latencyMs", condition: "gt", threshold: 500, severity: "warn", cooldownMs: 30000, message: "High publisher latency" },
];
```

Alerts emitted via:
1. **Structured log** -- `log.warn("High frame jitter", { jitterMs: 85.2, threshold: 50 })`
2. **WebSocket event** -- viewers get `{type: "alert", severity: "warn", message: "High frame jitter"}`
3. **Metrics export** -- `relay_alerts_fired_total{severity="warn"} 3`
4. **Webhook (future)** -- POST to external alerting service

---

## Gap 5: No Per-Session Diagnostics

### Current State

`FrameTiming` is per-connection, in-memory only. When a publisher or viewer disconnects, all timing data is lost. No historical record of session quality.

### What's Needed

Session diagnostics persisted alongside session data (in bucket or local database):

```ts
interface SessionDiagnostics {
  sessionId: string;
  publisher: {
    deviceModel: string;
    systemVersion: string;
    wearableType: string;
    connectedAt: number;
    disconnectedAt: number;
    durationMs: number;
    totalFrames: number;
    totalAudioFrames: number;
    totalBytes: number;
    averageFps: number;
    averageJitterMs: number;
    maxJitterMs: number;
    droppedFrames: number;
    peakLatencyMs: number;
  };
  viewers: {
    count: number;
    peakConcurrent: number;
    totalFramesRelayed: number;
    totalFramesThrottled: number;
    throttleRatio: number;   // throttled / (relayed + throttled)
  };
  alerts: {
    count: number;
    bySeverity: Record<string, number>;
    first: string | null;
    last: string | null;
  };
}
```

### Storage

Write to bucket on session end:

```
data/{userId}/{sessionId}/
  diagnostics.json    -- session quality summary
```

Or in the `SessionIndex` (see `docs/multi-tenant-bucket-architecture.md`):

```ts
interface SessionMeta {
  id: string;
  userId: string;
  // ... existing fields ...
  diagnostics?: SessionDiagnostics;
}
```

### Rolling Aggregation

During session, maintain running aggregates instead of storing every frame:

```ts
class SessionMetrics {
  private fpsSum = 0;
  private fpsCount = 0;
  private jitterMax = 0;

  update(timing: FrameTiming): void {
    if (timing.fps > 0) { this.fpsSum += timing.fps; this.fpsCount++; }
    if (timing.jitterMs > this.jitterMax) this.jitterMax = timing.jitterMs;
  }

  snapshot(): { avgFps: number; maxJitter: number } {
    return {
      avgFps: this.fpsCount > 0 ? this.fpsSum / this.fpsCount : 0,
      maxJitter: this.jitterMax,
    };
  }
}
```

Flush to bucket on session end. During session, expose via `/stats` for real-time monitoring.

---

## Gap 6: No Distributed Tracing

### Current State

No trace IDs. A frame goes iOS -> WebSocket -> server -> WebSocket -> viewer with no correlation across hops. When debugging latency or frame drops, there's no way to trace a specific frame end-to-end.

### What's Needed

Trace context propagated through the pipeline:

```
iOS App                          Server                          Viewer
========                        ======                          ======

FRLY frame with trace context
  [header][traceId][spanId][JPEG]
       |
       v
server receives frame
  extract traceId from FRLY extension
  create child span for fan-out
       |
       +---> viewer receives frame
       |     log spanId, relay timing
       |     report to trace collector
       |
       +---> AI worker receives frame
       |     log traceId, inference latency
       |
       +---> recorder writes to bucket
             log traceId, segment index
```

### Implementation Options

**Option A: W3C Trace Context in FRLY extension**

Add optional trace headers after the 29-byte FRLY header:

```
[29B FRLY header][4B traceLen][traceLen bytes trace context][JPEG payload]
```

The iOS app generates a trace ID on first frame. Server and viewers propagate it. No external tracing library required on iOS.

**Option B: Server-generated trace IDs**

Server generates trace ID when publisher connects. All frames in that session share the same trace ID. Simpler but doesn't trace individual frames.

**Option C: OpenTelemetry SDK**

Full OTel instrumentation with spans, context propagation, and export to a collector (Jaeger, Tempo, Honeycomb). Most complete but heaviest dependency.

### Recommended: Start with Option B

Server-generated session trace ID. Zero iOS changes. Add frame-level tracing (Option A) when frame-level debugging is needed.

```ts
// Server generates trace ID on publisher connect
const traceId = crypto.randomUUID();

// All logs include traceId
const log = logger.child({ traceId, sessionId });

// All metrics include traceId label
relay_publisher_frames_total{traceId="abc-123",sessionId="def-456"} 27600
```

---

## Architecture: How It All Fits Together

```
iOS App                                     Relay Server
======                                      ============

FRLY/FRAU frames                    +------- Metrics Registry -------+
       |                            |   counters, gauges, histograms   |
       v                            |   updated on every frame event   |
server.ts receives                  +---------------------------------+
       |                                  |            |            |
       +---> /stats (existing)            |            |            |
       +---> /metrics (new)  <-----------+            |            |
       +---> /health  (new)                            |            |
       |                                              |            |
       +---> Logger.structured()                       |            |
       |         |                                     |            |
       |         v                                     v            v
       |   [JSON stdout]                        [Prometheus]   [OTel]
       |   log aggregation                       /metrics      collector
       |   (Loki, Datadog)                        endpoint      (future)
       |
       +---> AlertRule.evaluate()
       |         |
       |         v
       |   [alerts via log, WS, webhook]
       |
       +---> SessionMetrics (rolling aggregate)
       |         |
       |         v
       |   [diagnostics.json in bucket on session end]
       |
       +---> Tracer.child({ traceId })
                 |
                 v
           [trace context in all logs + metrics]
```

---

## Implementation Priority

```
Phase 1: Foundation (no new dependencies)
  - Structured JSON logger (replace console.log)
  - /health endpoint
  - Session diagnostics snapshot on disconnect

Phase 2: Metrics Export
  - /metrics endpoint in Prometheus text format
  - Counter/gauge registry
  - Integrate with Grafana or Prometheus server

Phase 3: Alerting
  - Alert rule evaluation on FrameTiming updates
  - Cooldown logic to avoid alert storms
  - WebSocket alert events to viewers

Phase 4: Distributed Tracing
  - Server-generated trace IDs per session
  - Trace context in structured logs
  - Optional: OTel SDK integration for full tracing
```

Each phase is independent. Phase 1 can ship with zero new dependencies. Phases 2-4 add capabilities incrementally.

---

## Staleness Warning

This document was written against the codebase on `feat/telemetry-diagnostics` at commit `33ea802`. The `/stats` endpoint, `FrameTiming` interface, and `updateTiming()` EMA logic are in `relay/server/src/server.ts`. Depends on:

- `docs/pipeline-architecture.md` -- wire protocols and fan-out mechanism
- `docs/persistence-architecture.md` -- bucket storage for session diagnostics
- `docs/multi-tenant-bucket-architecture.md` -- session index and key layout
- `docs/multi-session-platform.md` -- session routing (multi-publisher support)
