# Bandwidth Control Research

Per-viewer quality presets and resolution scaling for the caringmind-frame-relay server.

## Current State

- Single iOS publisher sends FRLY JPEG frames (~640x480, quality 60)
- Relay server fans out identical frames to all N viewers
- No per-viewer bandwidth adaptation
- Wire protocol: 29-byte header (magic + sequence + width + height + quality + timestamp) + JPEG payload

## Problem

Viewers on different connections (4G, WiFi, fiber) all receive the same bitrate. A viewer on a slow connection gets stuttering; a viewer on fast connection gets unnecessarily low quality.

---

## Approach 1: Frame Rate Throttling (Zero CPU)

Skip every Nth frame per viewer based on their quality preset.

```typescript
const QUALITY_PRESETS = {
  high:  { maxFps: 30, label: "High" },
  medium: { maxFps: 15, label: "Medium" },
  low:   { maxFps: 8,  label: "Low" },
  mini:  { maxFps: 4,  label: "Mini" },
};
```

Implementation: per-viewer `lastSent` timestamp + `minIntervalMs` check. If interval < threshold, skip the frame. No decoding or re-encoding required.

**Pros**: Zero CPU, immediate, works with existing wire protocol
**Cons**: Doesn't reduce per-frame size, only reduces frame count

---

## Approach 2: Server-Side JPEG Re-compression

Decode incoming JPEG, re-encode at lower quality and/or resolution per viewer.

### Library Options

#### sharp + Bun Compatibility (Verified Apr 2026)

**Works on both macOS and Linux.** Already in production at `@ebowwa/coder` (sharp v0.34.5, Bun runtime).

**Why it works for us (when others report crashes):**

The key is **externalizing** sharp from the Bun bundle. Our build command uses `--external sharp`:

```bash
bun build ./src/index.ts --external sharp --outdir ./dist --target bun
```

This means:
1. **Build time**: Bun never tries to bundle or compile sharp's native `.node` addon
2. **Runtime**: `await import("sharp")` dynamically loads the platform-specific binary:
   - macOS: `@img/sharp-darwin-arm64`
   - Linux: `@img/sharp-linux-x64`
3. **Fallback**: If import fails, image processing is gracefully disabled

The GitHub crash reports (segfaults, heap corruption) are from people using `bun build --compile`, which bakes everything into a single binary and breaks native addon loading. By keeping sharp external, we avoid that entirely.

**Our proven pattern (from `@ebowwa/coder`):**

```typescript
let _sharp: any = null;
let _sharpAvailable: boolean | null = null;

async function getSharp() {
  if (_sharp !== null) return _sharp;
  if (_sharpAvailable === false) {
    throw new Error("sharp not available - image processing disabled");
  }
  try {
    const module = await import("sharp");
    _sharp = module.default || module;
    _sharpAvailable = true;
    return _sharp;
  } catch {
    _sharpAvailable = false;
    _sharp = null;
    throw new Error("sharp not available - image processing disabled");
  }
}
```

**package.json requirements:**

```json
{
  "trustedDependencies": ["sharp"],
  "dependencies": {
    "sharp": "^0.34.5"
  }
}
```

`trustedDependencies` lets `bun install` resolve sharp's platform-specific optional dependencies (`@img/sharp-*`). Without it, `bun install` skips them.

**Rules:**
- DO use `bun run` with `--external sharp`
- DO use dynamic `import("sharp")` with fallback
- DO add sharp to `trustedDependencies`
- DO NOT use `bun build --compile` with sharp (breaks native addon loading)

**Performance**: JPEG re-encoding at 640x480 is 6-10ms per frame (~100-167 FPS capacity). At 30 FPS uses only 18-30% of CPU budget.

```typescript
// Quality reduction only (~3-5ms at 640x480)
const lower = await sharp(jpegBuffer, { failOnError: false })
  .jpeg({ quality: 30, chromaSubsampling: '4:2:0', mozjpeg: false })
  .toBuffer();

// Resize + quality reduction (~6-10ms at 640x480)
const resized = await sharp(jpegBuffer, { failOnError: false })
  .resize(320, 240)
  .jpeg({ quality: 30, chromaSubsampling: '4:2:0' })
  .toBuffer();
```

#### imgkit (Bun-Native Alternative)

- Rust + napi-rs, built specifically for Bun
- 38 GitHub stars, 509 weekly downloads, 4 months old (as of Apr 2026), 1 contributor
- The "950x faster" claim applies to **metadata extraction only** (reads JPEG header bytes vs sharp's full decode), NOT re-encoding
- Actual re-encoding performance likely similar to sharp (both use libjpeg-turbo equivalent)
- No production users or independent benchmarks for re-encoding
- May be viable if sharp + Bun issues persist, but unproven for real-time workloads

```typescript
import { transform, toJpeg } from 'imgkit';

// Quality reduction only
const lower = await toJpeg(jpegBuffer, { quality: 30 });

// Resize + quality reduction
const resized = await transform(jpegBuffer, {
  resize: { width: 320, height: 240, fit: 'inside' },
  output: { format: 'jpeg', jpeg: { quality: 30 } },
});
```

#### Why NOT Canvas

- Bun has no built-in Canvas support (issue #4135 closed as `not-planned`)
- `node-canvas` and `@napi-rs/canvas` crash under load in Bun
- 2-3x slower than sharp for pure JPEG operations

#### Why NOT WASM JPEG

- 2-10x slower than native (30-50ms per frame at 640x480)
- Cannot sustain 30 FPS (33ms budget)
- Only viable for offline/batch processing

### Recommendation

**For the relay server (runs on Linux VPS)**:
1. Use sharp — we already use it in `@ebowwa/coder` on Bun + Linux
2. Add `trustedDependencies: ["sharp"]` to package.json
3. Use dynamic import with fallback (same pattern as coder)
4. Phase 1 (frame throttling) needs no image library — start there
5. Phase 3 (re-compression) uses sharp with the proven coder pattern

---

## Approach 3: Simulcast (Publisher Sends Multiple Tiers)

iOS publisher encodes 2-3 quality tiers simultaneously. Relay server routes the appropriate tier per viewer.

```typescript
const TIERS = [
  { id: 'high',   resolution: [640, 480], quality: 85, maxFps: 30 },
  { id: 'medium', resolution: [480, 360], quality: 70, maxFps: 15 },
  { id: 'low',    resolution: [320, 240], quality: 50, maxFps: 8  },
];
```

Requires iOS-side changes to encode multiple tiers per frame. Most bandwidth-efficient but highest publisher CPU cost.

**Pros**: Best quality per bitrate, server just routes (no CPU)
**Cons**: Requires iOS changes, increases publisher bandwidth, complex wire protocol

---

## Approach 4: Adaptive Bitrate (Auto-Detect)

Server estimates viewer bandwidth and auto-selects quality preset. No manual selection needed.

### Bandwidth Estimation (No RTCP)

Since we don't have WebRTC's RTCP feedback, estimate at application layer:

1. **Frame timing analysis**: Track inter-frame arrival at viewer (viewer sends ACKs with timestamps)
2. **Queue depth monitoring**: Growing send queue = congestion
3. **WebSocket backpressure**: Track `bufferedAmount` on viewer's WebSocket

### Quality Adaptation Algorithm

```
FOR each viewer:
  ESTIMATE bandwidth from frame timings + queue depth

  IF bandwidth < current_tier * 0.8:
    DOWNGRADE immediately
  ELSE IF bandwidth > next_tier * 1.2 AND stable for 5s:
    UPGRADE
  END IF
END FOR
```

Key parameters:
- **Hysteresis margin**: 20% headroom before upgrade (prevents oscillation)
- **Stability period**: 5 seconds before switching (prevents flapping)
- **Queue depth threshold**: 20-30 frames max

---

## Recommended Implementation Order

| Phase | Approach | Effort | Impact |
|-------|----------|--------|--------|
| 1 | Frame rate throttling per viewer | Low | High |
| 2 | Viewer sends quality preset (manual) | Low | Medium |
| 3 | Server-side JPEG re-compression (sharp, fallback imgkit) | Medium | High |
| 4 | Adaptive bitrate (auto-detect) | High | Highest |

### Phase 1: Viewer Quality Presets + Frame Throttling

1. Viewer connects, sends `{"type":"config","quality":"medium"}` over WebSocket
2. Server stores per-viewer quality preset
3. In `fanout()`, skip frames that don't match viewer's FPS target
4. Stats endpoint shows per-viewer quality setting

### Phase 3: JPEG Re-compression

1. Add `sharp` dependency (install with `npm install --include=optional sharp`)
2. Test on VPS — if native addon fails, fall back to `imgkit`
3. When viewer has quality preset requiring lower quality, re-encode JPEG before sending
4. Cache re-encoded frames per quality tier (same sequence = same output)
5. Build new FRLY header with updated width/height/quality for re-encoded frames

---

## Viewer Feedback Protocol

```typescript
// Viewer -> Server
{
  type: "config",
  quality: "high" | "medium" | "low" | "mini" | "auto"
}

// Server -> Viewer (on quality change)
{
  type: "quality",
  preset: "medium",
  fps: 15,
  resolution: [640, 480],
  bitrate: "estimated"
}
```

---

## Quality Preset Definitions

| Preset | Max FPS | JPEG Quality | Resolution | Est. Bitrate |
|--------|---------|-------------|------------|-------------|
| high   | 30      | 60 (original) | 640x480   | ~2 Mbps     |
| medium | 15      | 60 (original) | 640x480   | ~1 Mbps     |
| low    | 8       | 40 (re-encoded) | 480x360 | ~400 Kbps   |
| mini   | 4       | 30 (re-encoded) | 320x240 | ~150 Kbps   |

---

## Sources

- sharp: https://github.com/lovell/sharp (32K stars, 31M weekly downloads)
- imgkit: https://github.com/nexus-aissam/imgkit (38 stars, 509 weekly downloads)
- Sharp Bun issues: #21610, #20372, #27929, #4424
- Bun Canvas support: issues #4135, #5835, #12375
- SFU patterns: mediasoup, LiveKit, Pion WebRTC
- GCC (Google Congestion Control): adapted for application-layer BWE
- Sharp benchmarks: 6-10ms per 640x480 JPEG re-encode (64 ops/sec AMD64)
