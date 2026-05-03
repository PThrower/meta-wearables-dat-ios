# Congestion Control

AIMD backpressure, server-side token bucket rate limiting, and adaptive quality mechanisms.

---

## Viewer-Side AIMD Backpressure

The viewer implements additive-increase/multiplicative-decrease congestion control:

1. **Detect**: Viewer detects dropped frames via sequence number gaps
2. **Decrease**: Multiplicative decrease -- halve target FPS
3. **Increase**: Additive increase -- probe upward by +1 FPS every 3 seconds when bandwidth is healthy
4. **Bandwidth-aware**: Sliding 5-second window; reduces FPS below 200 KB/s threshold
5. **Relay**: Viewer sends `backpressure` JSON to server; server relays to publisher
6. **Apply**: Publisher applies server target FPS immediately, resets pacing gate (`lastRelayTime = nil`)
7. **Acknowledge**: Publisher sends `backpressure-ack` confirming applied FPS

### Immediate Application

On receiving a backpressure message, the iOS publisher resets `lastRelayTime = nil`, which opens the pacing gate for the very next frame. This ensures the new FPS takes effect immediately rather than waiting for the old interval to expire.

---

## Server-Side Token Bucket

Each viewer connection has a per-quality-preset token bucket that throttles frame delivery.

### Quality Presets

| Preset | Max FPS | Burst Tokens |
|--------|---------|-------------|
| high | 30 | 3 |
| medium | 15 | 2 |
| low | 8 | 2 |
| mini | 4 | 2 |

Burst allowance: `max(2, ceil(maxFps * 0.1))`

### Token Mechanics

- **Refill rate**: `maxFps / 1000` tokens per millisecond
- **Consume**: 1 token per frame forwarded to viewer
- **Burst**: allows short bursts above sustained rate
- **Default**: "high" (30 fps)

### Server FPS EMA

The server also tracks FPS with its own EMA (alpha=0.9/0.1, heavier smoothing than the iOS side's 0.3 alpha).

---

## Publisher-Side Adaptive Quality

See [video-codecs.md](video-codecs.md) for full JPEG adaptive quality details.

### iOS Encode Time EMA

| Parameter | Value |
|-----------|-------|
| Alpha | 0.3 (~3 samples to converge) |
| First sample | Initialized directly (no smoothing) |
| Formula | `ema = 0.3 * newSample + 0.7 * previousEma` |

### Effective FPS Priority Chain

```
1. Server backpressure target (always wins if set)
2. min(configured target, hardware cap)
3. Configured target (default 30 fps)
```

Where **hardware cap** = `1000 / (encodeTimeEma * 1.1)` (10% headroom).

### JPEG Quality Adaptation

| Condition | Action |
|-----------|--------|
| EMA > frameBudget * 1.2 | Quality *= 0.95 (downscale) |
| EMA < frameBudget * 0.8 | Quality *= 1.02 (upscale) |
| Result | Clamped to [0.2, 0.8] |

Frame budget = `1000 / effectiveTargetFps` ms.

---

## Stats Tracked

| Stat | Description |
|------|-------------|
| `framesSent` | Successfully sent frames |
| `framesFailed` | WebSocket send failures |
| `framesDropped` | Total dropped frames |
| `framesDroppedByPacing` | Dropped by frame rate limiter |
| `framesDroppedByBackpressure` | Dropped by server backpressure |
| `totalBytesSent` | Cumulative bytes sent |
| `lastFrameSizeBytes` | Last encoded frame size |
| `avgFrameSizeBytes` | Running average frame size |
| `encodeTimeEmaMs` | Encode time EMA (alpha=0.3) |
| `relayLatencyMs` | Ping/pong RTT |

---

## Vision FPS Limit

AI frame forwarding is clamped to [0.1, 5] fps -- a separate, much lower rate for vision/analysis pipelines.
