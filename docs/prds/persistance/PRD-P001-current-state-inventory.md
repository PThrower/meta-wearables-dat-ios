# PRD-P001: Persistence Current State Inventory

**Product:** com.mwdat-ios / Relay Platform
**Owner:** @ebowwa
**Status:** Reference Document
**Last Updated:** 2026-04-18

---

## Purpose

This document inventories everything that currently persists and everything that doesn't, as a baseline for the persistence strategy PRDs that follow.

---

## What Persists (R2 via `@ebowwa/object-store`)

All durable storage uses a single Cloudflare R2 bucket (`caringmind-sessions`) accessed through `@ebowwa/object-store` (S3-compatible abstraction).

### Per-Session Files

Written by `session-recorder.ts` during live sessions:

| Key Pattern | Format | Writer | When |
|-------------|--------|--------|------|
| `sessions/{id}/meta.json` | JSON | SessionRecorder | Start + finish |
| `sessions/{id}/manifest.json` | JSON | SessionRecorder | Every 10s flush |
| `sessions/{id}/video/seg-{n}.mjpeg` | Binary JPEG concat | SessionRecorder | Every 10s |
| `sessions/{id}/audio/chunk-{n}.pcm` | Raw PCM 16-bit | SessionRecorder | Every 10s |
| `sessions/{id}/guidance.jsonl` | Newline-delimited JSON | SessionRecorder | Every 10s |
| `sessions/{id}/annotations.jsonl` | Newline-delimited JSON | SessionRecorder | On event |
| `sessions/{id}/export.mp4` | MP4 (ffmpeg) | SessionExport | On demand, cached |
| `sessions/{id}/thumb.jpg` | JPEG | SessionExport | On demand, cached |

### Session Metadata Schema (`meta.json`)

```typescript
interface SessionMeta {
  sessionId: string;
  startedAt: string;           // ISO timestamp
  finishedAt?: string;         // ISO timestamp
  durationMs?: number;
  device?: {
    deviceId?: string;
    deviceName?: string;
    deviceModel?: string;
    wearableId?: string;
    wearableType?: string;
    systemVersion?: string;
  };
  accessLevel: "public" | "link" | "private";
  acl: Array<{ userId: string; email: string; role: "editor" | "viewer" }>;
  ownerId?: string;
  ownerEmail?: string;
  recording?: {
    segmentsWritten: number;
    audioChunks: number;
    bytesToBucket: number;
  };
}
```

### Manifest Schema (`manifest.json`)

```typescript
interface SessionManifest {
  sessionId: string;
  actualFps: number;            // computed from frame timestamps
  audioSampleRate: number;      // dominant sample rate across chunks
  totalFrames: number;
  videoSegments: Array<{
    index: number;
    frameCount: number;
    firstTimestampMs: number;
    lastTimestampMs: number;
    bytes: number;
  }>;
  audioChunks: Array<{
    index: number;
    sampleRate: number;
    channels: number;
    totalSamples: number;
    bytes: number;
  }>;
}
```

---

## What Does NOT Persist (In-Memory Only, Lost on Restart)

### Session State (`session-registry.ts`)

```typescript
private sessions = new Map<string, Session>();       // All active sessions
private deviceSessionMap = new Map<string, string>(); // deviceId → sessionId
```

Each `Session` object holds:

| Field | Type | Loss on Restart |
|-------|------|-----------------|
| `id` | string | Gone |
| `publisher` | Publisher \| null | Gone |
| `viewers` | Map<string, Viewer> | Gone |
| `recorder` | SessionRecorder \| null | Gone |
| `wasmThrottle` | FrameRelay instance | Gone |
| `createdAt` | number | Gone |
| `lastActivityAt` | number | Gone |
| `metadata` | SessionMetadata | Gone |
| `ownerId` | string \| undefined | Gone |
| `ownerEmail` | string \| undefined | Gone |
| `accessLevel` | AccessLevel | Gone |
| `acl` | AclEntry[] | Gone |
| `recordingId` | string \| undefined | Gone |
| `activeAppId` | string \| null | Gone |
| `appPipeline` | AppPipeline \| null | Gone |
| `lastFrame` | Uint8Array \| null | Gone |
| `linkState` | string | Gone |

### Aggregate Counters (`session-registry.ts`)

```typescript
private sessionsStarted = 0;
private totalFramesRelayed = 0;
private totalDroppedFrames = 0;
private peakViewers = 0;
private viewersRejected = 0;
private publisherReconnects = 0;
private framesThrottledWasm = 0;
private framesThrottledQuality = 0;
```

All reset to 0 on process restart. No historical aggregation.

### Gallery Index (`session-store.ts`)

```typescript
private galleryIndex = new Map<string, {
  meta: SessionMeta;
  exportCached: boolean;
  hasThumbnail: boolean;
  updatedAt: number;
}>();
private galleryCacheMap = new Map<string, { data: GallerySession[]; expiry: number }>();
private sessionListCache: { ids: string[]; expiry: number } | null = null;
```

Rebuilt from R2 on first gallery request after restart (expensive: lists all R2 keys, reads every `meta.json` in parallel).

### Auth State

| Data | Location | Loss |
|------|----------|------|
| HMAC secret | Env var via Doppler | Survives (Doppler persists it) |
| Session tokens | JWT (stateless) | Survives (tokens are self-validating) |
| Token revocation list | In-memory Set | **Lost on restart** — revoked tokens become valid again |
| Share tokens | R2 `share-tokens/` prefix | Survives (R2 persists them) |
| Google OAuth tokens | Client-side only | Survives (browser stores them) |

### Device Data

No device registry exists. Device info is:
1. Embedded in `Publisher` interface during connection
2. Written to `meta.json` by SessionRecorder
3. Lost when session ends if not recorded

There is no way to:
- List all devices that have ever connected
- Query sessions by device
- Track device firmware versions over time
- Associate devices with users/organizations

### User / Organization Data

No user or organization store exists. User identity is:
1. Google OAuth sub + email from JWT
2. Embedded in session `ownerId` / `ownerEmail`
3. Stored in session `acl` entries

There is no way to:
- List all users who have used the system
- Query sessions by user
- Associate users with organizations
- Track user roles/permissions across sessions

---

## Infrastructure Summary

| Layer | Technology | Persists? | Lost on Restart? |
|-------|-----------|-----------|------------------|
| Session binary data (video/audio) | Cloudflare R2 | Yes | No |
| Session metadata | R2 (`meta.json`) | Yes | No |
| Session manifest | R2 (`manifest.json`) | Yes | No |
| Guidance events | R2 (`guidance.jsonl`) | Yes | No |
| Annotations | R2 (`annotations.jsonl`) | Yes | No |
| MP4 exports | R2 (`export.mp4`) | Yes | No |
| Share tokens | R2 (`share-tokens/`) | Yes | No |
| Active sessions | In-memory Map | No | **Yes** |
| Device registry | None | No | **Yes** |
| User registry | None | No | **Yes** |
| Organization registry | None | No | **N/A (doesn't exist)** |
| Auth revocation list | In-memory Set | No | **Yes** |
| Telemetry counters | In-memory vars | No | **Yes** |
| Gallery index | In-memory Map | No | **Yes** (rebuilt from R2) |

---

## Pain Points from R2-Only Architecture

### 1. Gallery Index Rebuild is Expensive

On server restart, the first gallery request triggers `buildGalleryIndex()` which:
1. Lists all R2 keys with prefix `sessions/`
2. Filters for `meta.json` files
3. Reads every `meta.json` in parallel
4. Parses and indexes each one

With 100 sessions, this is ~100 parallel R2 GETs. With 10,000 sessions, it stalls.

### 2. No Cross-Session Queries

Questions that require a database, not object storage:
- "Show me all sessions from device X"
- "How many hours did user Y stream this month?"
- "Which sessions have AI detections for 'person'?"
- "What's the average session duration across the org?"

R2 can only list by key prefix. Any query beyond "list all sessions" requires downloading and parsing every `meta.json`.

### 3. No Device Lifecycle Tracking

Devices appear as anonymous connections. The server can't:
- Detect when a device was last seen
- Alert when a device goes offline unexpectedly
- Track firmware update adoption
- Associate a device with a specific worker

### 4. No User/Org Hierarchy

The system has no concept of:
- Organizations (companies, teams)
- Roles (admin, operator, viewer)
- Device assignments (which worker has which glasses)
- Access policies (org-level sharing rules)

### 5. Auth Revocation Doesn't Survive Restarts

If an admin revokes a session token, that revocation is stored in memory. On server restart, the revoked token is valid again until the admin revokes it a second time.

---

## What the Multi-Publisher Operator Dashboard Requires

The operator dashboard vision (from PRD-006 and the GlassFlow reference app) needs:

| Data | Current Source | Gap |
|------|---------------|-----|
| Active publishers (who's streaming now) | In-memory Map | Lost on restart, no historical view |
| Device registry (all known glasses) | None | Doesn't exist |
| Worker roster (who has which glasses) | None | Doesn't exist |
| Org/team structure | None | Doesn't exist |
| Session history per worker | R2 meta.json | Requires full scan to query |
| Session history per device | R2 meta.json | Requires full scan to query |
| Aggregate analytics (hours, frames, errors) | In-memory counters | Reset on restart |
| Alert history | None | Doesn't exist |
| Task/procedure tracking | None | Doesn't exist |

---

## Storage Cost Baseline

Current R2 usage at ~1 hour/session:

| Component | Size/Session | Monthly (50 sessions) |
|-----------|-------------|----------------------|
| Video segments | ~1.1 GB | ~55 GB |
| Audio chunks | ~2.8 GB | ~140 GB |
| Metadata + manifests | ~10 KB | ~500 KB |
| Guidance JSONL | ~1-5 MB | ~50-250 MB |
| MP4 exports (cached) | ~500 MB | ~25 GB |
| **Total** | **~4.4 GB** | **~220 GB** |

R2 pricing: $0.015/GB/month storage, $0 egress. Monthly cost: ~$3.30 for 220 GB.
