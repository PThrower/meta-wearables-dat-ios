# PRD-013: Platform API Surface

**Product:** com.mwdat-ios / Relay Platform API
**Owner:** @ebowwa
**Status:** Draft
**Last Updated:** 2026-04-10
**Depends On:** PRD-002 (Relay Platform), PRD-007 (Auth), PRD-012 (Developer API wraps this)

---

## Problem

The relay server has 15+ endpoints in a single `fetch()` handler with if/match chains. The surface grew organically:

- **Mixed concerns**: same handler serves HTML pages, JSON API responses, binary streams (MP4/thumbnails), and WebSocket upgrades
- **Inconsistent auth**: `/stats`, `/publish`, `/view`, `/tap/audio` require auth; `/gallery/api`, `/sessions`, `/session/<id>/thumbnail` do not
- **Single-publisher leftovers**: `/latest/video.mp4` and `/latest/export` assume one active session; meaningless in multi-session
- **No API versioning**: everything at the root, no `/api/` prefix, no version header
- **S3 proxy leaks**: `/session/<id>/video/<seg>` and `/session/<id>/audio/<chunk>` are raw signed URL redirects that expose storage internals
- **Monolithic stats**: `SessionRegistry.stats()` is 170 lines computing everything in one shot -- server metrics, per-session breakdowns, gallery aggregates, bandwidth calculations -- all from one endpoint

The Developer API (PRD-012) needs a clean HTTP surface to wrap. Right now it would have to parse HTML responses and handle inconsistent auth patterns.

---

## Users

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| **Developer** | Building apps with `@ebowwa/mwdat-sdk` | Predictable REST API with consistent auth, JSON responses, versioned endpoints |
| **Browser Viewer** | Person watching a live stream | HTML page with embedded session; no API awareness needed |
| **Platform Operator** | Monitoring infrastructure | Structured stats, health checks, session management |
| **AI Worker** | Server-side inference service | Frame/audio WebSocket with auth; no HTML, no gallery |

---

## Current Surface (Messy)

```
# WebSocket endpoints (auth-gated)
/publish?session=<id>        WebSocket, iOS publisher
/view?session=<id>           WebSocket or HTML page (depends on Upgrade header)
/tap/audio?session=<id>      WebSocket, audio tap (auth-gated)

# HTML pages (no auth)
/                            Unified page (gallery + directory + live player)
/session/<id>                Viewer HTML scoped to session
/view?session=<id>           Same as /session/<id> when no Upgrade header

# JSON API (mixed auth)
/stats                       Auth-gated: monster payload with everything
/sessions                    No auth: active + historical sessions
/gallery/api                 No auth: gallery data (15s cache)
/session/<id>/export         No auth: export metadata
/latest/export               No auth: latest session export metadata

# Binary/media (no auth)
/latest/video.mp4            Redirect to most recent session MP4
/session/<id>/thumbnail      JPEG thumbnail
/session/<id>/video.mp4      MP4 export (streamed, R2 cached)
/session/<id>/video/<seg>    S3 signed URL redirect (leaks storage)
/session/<id>/audio/<chunk>  S3 signed URL redirect (leaks storage)

# Redirects
/gallery                     Redirect to /
```

---

## Proposed Surface

Separate into three layers: **API** (JSON, versioned, auth-consistent), **Media** (binary, CDN-friendly), **HTML** (viewer pages, no auth required).

### Layer 1: API (`/api/v1/`)

All JSON. All auth-gated (Bearer token). Versioned prefix.

| Endpoint | Method | What | Auth |
|----------|--------|------|------|
| `/api/v1/sessions` | GET | Active + recent sessions with metadata | Required |
| `/api/v1/sessions/<id>` | GET | Single session detail (live or stored) | Required |
| `/api/v1/sessions/<id>/stats` | GET | Per-session metrics (FPS, bitrate, viewers, timing) | Required |
| `/api/v1/stats` | GET | Platform-wide metrics (server, aggregate, reliability) | Required |
| `/api/v1/gallery` | GET | Stored sessions with thumbnails, duration, export status | Required |
| `/api/v1/sessions/<id>/export` | GET | Export metadata (frames, duration, size, media URLs) | Required |

**Removed from API:**
- `/latest/video.mp4` and `/latest/export` -- SDK calls `/api/v1/sessions` and sorts by timestamp
- `/sessions` (unauthed) -- replaced by `/api/v1/sessions` (authed)
- `/gallery/api` (unauthed) -- replaced by `/api/v1/gallery` (authed)

### Layer 2: Media (CDN-friendly paths)

Binary responses. Public or token-gated per session `isPublic` flag.

| Endpoint | Response | Cache | Auth |
|----------|----------|-------|------|
| `/media/<id>/thumbnail.jpg` | JPEG | 24h | None (public) |
| `/media/<id>/video.mp4` | MP4 stream | 1h | Token if private session |
| `/media/<id>/frames/<seg>` | Raw FRLY segment | 1h | Token if private session |
| `/media/<id>/audio/<chunk>` | Raw FRAU chunk | 1h | Token if private session |

**Changes from current:**
- `/session/<id>/thumbnail` -> `/media/<id>/thumbnail.jpg` (explicit extension, CDN-friendly)
- `/session/<id>/video.mp4` -> `/media/<id>/video.mp4` (clean prefix)
- `/session/<id>/video/<seg>` -> `/media/<id>/frames/<seg>` (no S3 leak)
- `/session/<id>/audio/<chunk>` -> `/media/<id>/audio/<chunk>` (no S3 leak)
- S3 signed URL redirects eliminated -- server proxies binary directly
- Private sessions require token in query param or Authorization header

### Layer 3: WebSocket (unchanged protocol)

| Endpoint | Protocol | Auth |
|----------|----------|------|
| `/publish?session=<id>` | WebSocket | Required |
| `/view?session=<id>` | WebSocket | Required |
| `/tap/audio?session=<id>` | WebSocket | Required |
| `/analyze?session=<id>` | WebSocket | Required (P1-3, PRD-002) |

No changes to WebSocket endpoints. FRLY/FRAU binary passthrough unchanged.

### Layer 4: HTML (viewer pages, no auth for public sessions)

| Path | What |
|------|------|
| `/` | Landing: gallery + directory + live player (unified page) |
| `/s/<id>` | Session viewer (short URL, embeddable) |

**Changes from current:**
- `/session/<id>` removed -- replaced by `/s/<id>`
- `/view?session=<id>` as HTML page removed -- replaced by `/s/<id>`
- `/gallery` removed -- `/` serves everything
- HTML pages call `/api/v1/` endpoints for data (with embedded token or no-auth mode)

---

## Requirements

### P0 -- Must Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P0-1 | All JSON under `/api/v1/` prefix, old JSON paths deleted | No JSON endpoints outside `/api/v1/`; `/stats`, `/sessions`, `/gallery/api`, `/session/<id>/export`, `/latest/export` all removed |
| P0-2 | Consistent auth on all `/api/v1/` endpoints | Every `/api/v1/` route validates Bearer token; returns 401 if missing/invalid |
| P0-3 | Split `stats()` into focused endpoints | `/api/v1/stats` returns platform metrics only; `/api/v1/sessions/<id>/stats` returns session-scoped metrics |
| P0-4 | Media paths under `/media/` prefix, old paths deleted | `/session/<id>/thumbnail`, `/session/<id>/video.mp4`, `/session/<id>/video/<seg>`, `/session/<id>/audio/<chunk>` all removed; replaced by `/media/<id>/` |
| P0-5 | Eliminate S3 signed URL redirects | Server proxies binary directly; no `store.signedUrl()` exposed to clients |
| P0-6 | Remove `/latest/` shortcuts | `/latest/video.mp4` and `/latest/export` removed; use `/api/v1/sessions` to find latest |
| P0-7 | Short session URLs, old paths deleted | `/s/<id>` serves viewer HTML; `/session/<id>` HTML page removed; `/view?session=<id>` HTML page removed |
| P0-8 | Frame processing pipeline runs regardless of viewers | Stats, recording, throttle, AI fan-out, and audio tap stages all execute when publisher sends frames; only `ViewerFanoutStage` checks viewer count |
| P0-9 | Pipeline stages are pluggable per-session | `FramePipeline.register(stage)` adds stages; `createDefaultPipeline()` provides standard set; custom pipelines for AI-heavy sessions |
| P0-10 | `server.ts` delegates to pipeline, not registry | `message()` calls `pipeline.dispatch()` instead of `registry.fanout()` + `recorder.appendVideo()` directly |

### P1 -- Should Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P1-1 | API version header | All `/api/v1/` responses include `X-API-Version: 1` header |
| P1-2 | Request logging for API endpoints | Structured JSON logs for all `/api/v1/` requests: method, path, status, latency, userId |
| P1-3 | Rate limiting per user on API endpoints | 100 req/min per user on `/api/v1/` routes; 429 with Retry-After header |
| P1-4 | CORS headers for API endpoints | `Access-Control-Allow-Origin`, `Allow-Methods`, `Allow-Headers` on `/api/v1/` responses |
| P1-5 | OpenAPI spec at `/api/v1/docs` | Auto-generated or hand-maintained OpenAPI 3.1 JSON spec |

### P2 -- Could Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P2-1 | Health check endpoint (`/api/v1/health`) | Returns 200 with `{ status: "ok", uptimeMs, wasmLoaded }` -- no auth required |
| P2-2 | Gallery search/filter | `/api/v1/gallery?from=<date>&to=<date>&device=<type>` query params |
| P2-3 | Session deletion API | `DELETE /api/v1/sessions/<id>` removes stored session data (owner only) |
| P2-4 | Webhook for session events | POST to configured URL on session start/end/export-complete |

---

## Frame Processing Pipeline

Current architecture couples frame processing to viewer presence. `fanout()` short-circuits at `session.viewers.size === 0`, which means header parsing, WASM throttle timing, resolution metadata, and frame counters all skip when nobody is watching.

Processing stages must run independently. A viewer is just one consumer of a frame, not the gate for all processing.

### Current (broken)

```
server.ts message():
  Video frame:
    1. publisher.frameCount++                        (always)
    2. publisher.totalBytes +=                       (always)
    3. registry.fanout()                             (SKIPS if 0 viewers)
       - parseHeader()                               ← resolution metadata lost
       - updateTiming()                              ← timing stats lost
       - lastHeader = { width, height, quality }     ← quality metadata lost
       - WASM throttle check                         ← throttle state stale
       - totalFramesRelayed++                        ← counter wrong
       - for viewer: ws.send(data)                   (correct to skip)
    4. recorder.appendVideo()                        (always)

  Audio frame:
    1. publisher.audioCount++                        (always)
    2. publisher.audioBytes +=                       (always)
    3. registry.fanoutAudio()                        (SKIPS if 0 viewers)
       - publisher audio tap stats                   (always -- runs before the check)
       - for viewer: ws.send(data)                   (correct to skip)
    4. recorder.appendAudio()                        (always)
    5. audioTapBus.publish()                         (always)
```

### Proposed (viewer-agnostic pipeline)

```
server.ts message():
  Video frame:
    1. FramePipeline.dispatch(sessionId, frame)

FramePipeline.dispatch():
    for each registered stage:
      stage.process(frame, session)                  ← runs regardless of viewers

Stages (run in order, each independent):

    StatsStage          publisher counters, timing, resolution metadata
    RecordingStage      append to S3 recorder
    ThrottleStage       WASM per-session throttle state
    AIFanoutStage       forward to /analyze WebSocket connections
    ViewerFanoutStage   forward to /view WebSocket connections (respects quality presets)
    AudioTapStage       publish to AudioTapBus subscribers
```

Each stage is a class with a `process(frame, session)` method. Stages are registered per-session, not globally. Adding a new processing stage (e.g., on-server AI inference, thumbnail extraction, frame annotation) means adding a class, not editing `fanout()`.

### Pipeline interface

```typescript
interface FramePipelineStage {
  readonly name: string
  process(ctx: FrameContext): void | Promise<void>
}

interface FrameContext {
  sessionId: string
  session: Session
  raw: Uint8Array          // original FRLY/FRAU binary
  parsed: {
    type: "video" | "audio"
    header: ParsedHeader | null
    payload: Uint8Array    // JPEG or PCM
  }
}

class FramePipeline {
  private stages: FramePipelineStage[] = []

  register(stage: FramePipelineStage): void {
    this.stages.push(stage)
  }

  async dispatch(sessionId: string, session: Session, raw: Uint8Array): void {
    const parsed = parseFrame(raw)
    const ctx: FrameContext = { sessionId, session, raw, parsed }
    for (const stage of this.stages) {
      try { await stage.process(ctx) } catch (err) {
        console.error(`[pipeline] ${stage.name} failed:`, err)
      }
    }
  }
}
```

### Built-in stages

| Stage | What | Gated on viewers? |
|-------|------|--------------------|
| `StatsStage` | Update publisher counters, timing, resolution metadata | No -- always runs |
| `RecordingStage` | Append raw frame to session recorder | No -- always runs |
| `ThrottleStage` | Update WASM throttle state | No -- always runs |
| `ViewerFanoutStage` | Send to connected viewers with quality presets | Yes -- but only the send, not the throttle state update |
| `AIFanoutStage` | Forward to `/analyze` WebSocket connections | No -- runs if analyzers exist |
| `AudioTapStage` | Publish to AudioTapBus | No -- always runs |

### Per-session pipeline configuration

```typescript
// Default pipeline for a new session
function createDefaultPipeline(session: Session): FramePipeline {
  const pipeline = new FramePipeline()
  pipeline.register(new StatsStage())
  pipeline.register(new RecordingStage())
  pipeline.register(new ThrottleStage())
  pipeline.register(new AIFanoutStage())
  pipeline.register(new ViewerFanoutStage())
  pipeline.register(new AudioTapStage())
  return pipeline
}

// Custom pipeline for AI-heavy sessions
function createAIPipeline(session: Session): FramePipeline {
  const pipeline = createDefaultPipeline(session)
  pipeline.register(new ThumbnailExtractorStage())  // extract every 30th frame
  pipeline.register(new FrameAnnotationStage())      // add AI detections as metadata
  return pipeline
}
```

This replaces the current approach where `server.ts` directly calls `registry.fanout()` and `recorder.appendVideo()` in sequence. The pipeline owns frame dispatch; `server.ts` only calls `pipeline.dispatch()`.

---

## Routing Architecture

Replace the monolithic `fetch()` with a router. Bun doesn't have a built-in router, but the pattern is straightforward.

```
Current (server.ts):
  fetch(req, server) {
    if (url.pathname === "/latest/video.mp4") { ... }
    if (url.pathname === "/stats") { ... }
    if (url.pathname === "/gallery") { ... }
    if (url.pathname === "/gallery/api") { ... }
    if (url.pathname.startsWith("/assets/")) { ... }
    if (url.pathname === "/sessions") { ... }
    // ... 10 more if/match chains
  }

Proposed:
  fetch(req, server) {
    const route = matchRoute(url.pathname)

    // API layer -- all JSON, all authed
    if (route.prefix === "/api/v1") {
      return handleApiRoute(route, req)
    }

    // Media layer -- binary, public or token-gated
    if (route.prefix === "/media") {
      return handleMediaRoute(route, req)
    }

    // WebSocket upgrade
    if (isWsRoute(route)) {
      return handleWsUpgrade(route, req, server)
    }

    // HTML layer -- viewer pages
    return handleHtmlRoute(route, req)
  }
```

### Route Handler Pattern

```typescript
type RouteHandler = (req: Request, params: Record<string, string>) => Promise<Response>

interface Route {
  method: string
  pattern: string           // e.g., "/api/v1/sessions/:id/stats"
  handler: RouteHandler
  authRequired: boolean
}
```

---

## Migration Path

Clean cut-over. One deploy replaces the entire surface.

All old endpoints deleted. New surface ships in a single commit.

**Deleted endpoints:**
| Old Path | Replaced By |
|----------|-------------|
| `/stats` | `/api/v1/stats` |
| `/sessions` | `/api/v1/sessions` |
| `/gallery` | `/` (unified page) |
| `/gallery/api` | `/api/v1/gallery` |
| `/session/<id>` (HTML) | `/s/<id>` |
| `/session/<id>/export` | `/api/v1/sessions/<id>/export` |
| `/session/<id>/thumbnail` | `/media/<id>/thumbnail.jpg` |
| `/session/<id>/video.mp4` | `/media/<id>/video.mp4` |
| `/session/<id>/video/<seg>` | `/media/<id>/frames/<seg>` |
| `/session/<id>/audio/<chunk>` | `/media/<id>/audio/<chunk>` |
| `/latest/video.mp4` | `/api/v1/sessions` (client sorts) |
| `/latest/export` | `/api/v1/sessions` (client sorts) |
| `/view` (HTML page mode) | `/s/<id>` |

**Unchanged endpoints:**
| Path | Notes |
|------|-------|
| `/publish?session=<id>` | WebSocket only, no HTML mode |
| `/view?session=<id>` | WebSocket only, no HTML mode |
| `/tap/audio?session=<id>` | WebSocket, auth-gated |
| `/analyze?session=<id>` | WebSocket, auth-gated (P1-3) |
| `/` | Unified page (gallery + directory + live player) |
| `/s/<id>` | Session viewer HTML |
| `/assets/*` | Static viewer assets |

**Client updates required:**
1. iOS app (`RelayStage`): no changes (publishes to `/publish?session=<id>` WebSocket -- unchanged)
2. Browser viewer: update to call `/api/v1/` instead of `/sessions`, `/gallery/api`
3. AI workers: update audio tap to call `/api/v1/sessions` for session discovery
4. Any scripts hitting `/stats` or `/latest/`: update to `/api/v1/` equivalents

---

## Key Files

| File | Change |
|------|--------|
| `relay/server/src/server.ts` | Replace monolithic fetch with router dispatch; `message()` delegates to pipeline |
| `relay/server/src/pipeline.ts` | NEW: `FramePipeline`, `FramePipelineStage`, `FrameContext` types and dispatch loop |
| `relay/server/src/stages/stats.ts` | NEW: publisher counters, timing, resolution metadata |
| `relay/server/src/stages/recording.ts` | NEW: append to session recorder |
| `relay/server/src/stages/throttle.ts` | NEW: WASM per-session throttle state |
| `relay/server/src/stages/viewer-fanout.ts` | NEW: send to viewers with quality presets (only stage gated on viewer count) |
| `relay/server/src/stages/ai-fanout.ts` | NEW: forward to `/analyze` connections |
| `relay/server/src/stages/audio-tap.ts` | NEW: publish to AudioTapBus |
| `relay/server/src/routes/api.ts` | NEW: `/api/v1/*` route handlers |
| `relay/server/src/routes/media.ts` | NEW: `/media/*` binary handlers |
| `relay/server/src/routes/html.ts` | NEW: HTML page serving (viewer, directory) |
| `relay/server/src/session-registry.ts` | Remove `fanout()` and `fanoutAudio()`; split `stats()` into `platformStats()` and `sessionStats(id)` |
| `relay/server/src/session-export.ts` | Media paths updated; no signed URL redirects |
| `relay/viewer/` | Update to call `/api/v1/` endpoints |

---

## Dependency Graph Update

```
PRD-013 (Platform API Surface)
   |
   +---> PRD-002 (Relay Platform -- server.ts refactor)
   +---> PRD-007 (Auth -- consistent Bearer token on all API routes)
   +---> PRD-012 (Developer API -- wraps /api/v1/ endpoints)
            |
            +---> PRD-013 must be complete before SDK can wrap a stable API
```

---

## Success Metrics

| Metric | Target | Method |
|--------|--------|--------|
| API response time (JSON) | < 50ms p95 | Server timing |
| Auth consistency | 100% of `/api/v1/` routes return 401 without token | Automated check |
| Zero S3 URL leaks | No `signedUrl()` exposed to clients | Code review |
| Zero dead endpoints | No old paths return anything except 404 | Automated check |

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Router refactor breaks WebSocket upgrade path | High | WebSocket upgrades handled before route dispatch; same `server.upgrade()` flow |
| Cut-over breaks in-progress viewer sessions | High | Deploy during low-traffic window; viewers auto-reconnect on WebSocket close |
| Stats split loses aggregate data | Low | `/api/v1/stats` still computes platform-wide aggregates; just not per-session detail |
| CDN caching on `/media/` paths serves stale data | Low | Cache-Control headers tuned per content type; versioned URLs for exports |
