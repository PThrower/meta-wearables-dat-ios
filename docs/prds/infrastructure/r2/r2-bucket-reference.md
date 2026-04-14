# R2 Bucket Reference: caringmind-sessions

**Last audited:** 2026-04-13
**Bucket:** `caringmind-sessions`
**Account:** ec.arbee1@gmail.com (ec204d51508d586626874c654f1d29cf)
**Location:** WNAM (Western North America)
**Endpoint:** `https://ec204d51508d586626874c654f1d29cf.r2.cloudflarestorage.com`

## Overview

| Metric | Value |
|--------|-------|
| Created | 2026-04-03 |
| Storage Class | Standard (all objects) |
| Objects | ~1,091 |
| Total Size | ~10.6 GB |
| Sessions | 93 (92 visible in gallery, 1 empty shell filtered) |
| Public Access | Disabled (r2.dev URL off, no custom domains) |
| CORS | Not configured |
| Lifecycle Rules | 1 — abort incomplete multipart uploads after 7 days |

Access is S3-API only, through the Bun relay server (`@ebowwa/object-store` + `@aws-sdk/client-s3`).

---

## Object Schema

```
caringmind-sessions/
  sessions/
    {recordingId}/                          # UUID, stable across publisher reconnects
      meta.json                            # Session metadata, access control, device info
      manifest.json                        # Per-segment/chunk metadata (fps, sample rates)
      video/
        seg-0001.mjpeg                     # Concatenated JPEG frames (~10s per segment)
        seg-0002.mjpeg
        ...
        seg-NNNN.mjpeg.retry               # Retry buffer from failed writes (rare)
      audio/
        chunk-0001.pcm                     # Raw PCM s16le audio (~10s per chunk)
        chunk-0002.pcm
        ...
      thumb.jpg                            # First-frame JPEG thumbnail (lazy-generated)
      export.mp4                           # H.264+AAC MP4 export (lazy-generated via ffmpeg)
      shares/
        shr_{32hex}.json                   # Individual share token
        _index.json                        # Denormalized token list (pruned on update)
```

### Object Count Breakdown

| Extension | Count | Purpose |
|-----------|-------|---------|
| `.pcm` | 406 | Raw audio chunks (largest by count) |
| `.mjpeg` | 337 | Raw video segments (largest by size) |
| `.json` | 148 | meta.json (93) + manifest.json (52) + shares (3) |
| `.jpg` | 91 | Cached first-frame thumbnails |
| `.mp4` | 18 | Cached MP4 exports |

### Size Estimates Per Recording Hour

| Object Type | Rate | 1-Hour Size |
|-------------|------|-------------|
| Video segments (MJPEG) | ~15 fps x ~15 KB JPEG | ~810 MB |
| Audio chunks (PCM s16le 48kHz) | 96 KB/s | ~345 MB |
| Manifest + Meta | Negligible | <100 KB |
| MP4 export (H.264+AAC) | ~2.8 Mbps | ~100-200 MB |
| **Total** | | **~1.2-1.5 GB/hour** |

---

## Key Structures

### meta.json

Written by `session-recorder.ts` on first frame, resume, and finish.

```json
{
  "sessionId": "uuid",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601",
  "durationMs": 54456,
  "device": {
    "deviceName": "iPhone",
    "deviceModel": "iPhone14,4",
    "deviceId": "UDID",
    "systemVersion": "18.7.3",
    "wearableType": "Oakley Meta Vanguard"
  },
  "accessLevel": "link",
  "acl": [],
  "ownerId": "google-sub",
  "ownerEmail": "user@example.com",
  "recording": {
    "segmentsWritten": 6,
    "audioChunks": 5,
    "bytesToBucket": 85715029
  }
}
```

### manifest.json

Written by `session-recorder.ts` on every 10s flush tick and on finish.

```json
{
  "sessionId": "uuid",
  "actualFps": 15.2,
  "audioSampleRate": 48000,
  "totalFrames": 152,
  "videoSegments": [
    { "index": 1, "frameCount": 152, "firstTimestampMs": 1000, "lastTimestampMs": 11000, "bytes": 524288 }
  ],
  "audioChunks": [
    { "index": 1, "sampleRate": 48000, "channels": 1, "totalSamples": 480000, "bytes": 960000 }
  ]
}
```

### shares/shr_{hex}.json

```json
{
  "token": "shr_abc123...",
  "sessionId": "uuid",
  "role": "viewer",
  "createdBy": "google-sub",
  "createdAt": "ISO-8601",
  "expiresAt": "ISO-8601",
  "revoked": false
}
```

---

## Write Paths

| What | Key Pattern | When | Code |
|------|-------------|------|------|
| Video segments | `video/seg-NNNN.mjpeg` | Every 10s tick | `session-recorder.ts:flushVideo()` |
| Audio chunks | `audio/chunk-NNNN.pcm` | Every 10s tick | `session-recorder.ts:flushAudio()` |
| Retry buffer | `video/seg-NNNN.mjpeg.retry` | On write failure retry | `session-recorder.ts:258` |
| Session meta | `meta.json` | First frame, resume, finish | `session-recorder.ts:writeMeta()` |
| Session manifest | `manifest.json` | Every 10s tick, finish | `session-recorder.ts:writeManifest()` |
| Thumbnail | `thumb.jpg` | First thumbnail request (lazy) | `session-export.ts:80` |
| MP4 export | `export.mp4` | First MP4 request (lazy) | `session-export.ts:209` |
| Share token | `shares/shr_{hex}.json` | POST /session/{id}/share | `permissions.ts:149` |
| Share index | `shares/_index.json` | Share token create/revoke | `permissions.ts:211` |

## Read Paths

| What | Key Pattern | When | Code |
|------|-------------|------|------|
| Gallery index | `list("sessions/")` + all meta.json | Every 2 min | `server.ts:buildGalleryIndex()` |
| Session list | `list("sessions/")` | Every 60s | `server.ts:buildSessionList()` |
| Recorder resume | `list("sessions/{id}/")` + meta + manifest | Publisher reconnect | `session-recorder.ts:start()` |
| Thumbnail | `thumb.jpg` or first seg | GET /session/{id}/thumbnail | `session-export.ts:61` |
| MP4 export | `export.mp4` or build from segments | GET /session/{id}/video.mp4 | `session-export.ts:106` |
| Share validation | `shares/shr_{hex}.json` | Every viewer with share token | `permissions.ts:112` |
| Stats aggregation | All meta.json | GET /stats | `session-registry.ts:563` |
| Empty shell cleanup | `list("sessions/")` + all keys | Once, 15s after startup | `server.ts:pruneEmptyShells()` |

## Signed URLs

All use `store.signedUrl(key, ttl)` via `@aws-sdk/s3-request-presigner`. TTL is 3600s (1h) everywhere.

| Endpoint | Key | Delivery |
|----------|-----|----------|
| GET /session/{id}/video/{seg} | `video/seg-NNNN.mjpeg` | 302 redirect to signed URL |
| GET /session/{id}/audio/{chunk} | `audio/chunk-NNNN.pcm` | 302 redirect to signed URL |
| GET /session/{id}/video.mp4 | `export.mp4` | Server-side fetch + proxy |
| GET /stats | `meta.json` | Signed URL in response JSON |

---

## Lifecycle & Deletion

### What Deletes Objects

- **`pruneEmptyShells()`** — Runs once, 15s after server startup. Deletes sessions where `segmentsWritten === 0` and no video keys exist in R2. Only targets truly empty shells from audio-only or publisher-only connections.

### What Does NOT Delete Objects

- **No TTL or expiry** — Objects persist indefinitely
- **No age-based cleanup** — No cron job or background task removes old sessions
- **No session deletion API** — No HTTP endpoint to delete a session
- **No storage tiering** — All objects in Standard; no transition to Infrequent Access
- **Expired share tokens** — `shr_*.json` files remain in R2; only pruned from `_index.json`
- **Retry files** — `seg-NNNN.mjpeg.retry` files accumulate if writes fail
- **In-memory session expiry** — `SESSION_EXPIRY_MS = 60_000` only evicts live state, NOT R2 data

### Growth Rate

At current usage (~10.6 GB over 10 days, ~92 sessions):
- Average session: ~115 MB (video + audio + export)
- Daily growth: ~1 GB/day at current recording frequency
- Projected annual: ~365 GB if not managed

---

## Security Posture

| Feature | Status | Notes |
|---------|--------|-------|
| r2.dev public URL | Disabled | Good — no anonymous public access |
| Custom domains | None | All access through Bun server |
| CORS | Not configured | Signed-URL 302 redirects may fail cross-origin in browsers |
| Bucket access | S3 API only | Credentials in server .env |
| Object encryption | R2 default (AES-256) | Managed by Cloudflare |
| Access control | Server-side | `resolvePermission()` checks owner/acl/token per request |

---

## CLI Management Commands

```bash
# Auth check
wrangler whoami

# Bucket info
wrangler r2 bucket info caringmind-sessions --json

# Bucket size and object count
wrangler r2 bucket info caringmind-sessions --json | jq '{objects, size}'

# Get an object
wrangler r2 object get caringmind-sessions/sessions/{id}/meta.json --remote

# Delete an object
wrangler r2 object delete caringmind-sessions/sessions/{id}/meta.json --remote

# Lifecycle rules
wrangler r2 bucket lifecycle list caringmind-sessions

# CORS rules
wrangler r2 bucket cors list caringmind-sessions

# Dev URL status
wrangler r2 bucket dev-url get caringmind-sessions

# Domains
wrangler r2 bucket domain list caringmind-sessions

# Lock rules
wrangler r2 bucket lock list caringmind-sessions
```

---

## Recommendations

### Critical

1. **Add lifecycle rules for old sessions** — Tier objects older than 30 days to Infrequent Access, delete after 90 days (or configurable retention).
   ```bash
   # Example: move old sessions to Infrequent Access after 30 days
   wrangler r2 bucket lifecycle add caringmind-sessions --name "tier-old-sessions" --prefix "sessions/" --action TransitionStorageClass --days 30 --storage-class INFREQUENT_ACCESS
   ```

2. **Add session deletion API** — `DELETE /session/{id}` endpoint that removes all objects for a session. Owner-only access.

3. **Add CORS configuration** — Allow the relay domain origin to access R2 signed URLs directly.
   ```bash
   wrangler r2 bucket cors set caringmind-sessions --file cors.json
   ```

### Important

4. **Clean up expired share tokens** — Background task to delete `shr_*.json` files past their `expiresAt`.
5. **Clean up retry files** — `.retry` files should be merged or deleted after successful retry.
6. **Gallery index pagination** — Use R2 prefix listing per session instead of full `list("sessions/")` scan to reduce O(N) growth.
7. **Manifest written per session, not per recorder** — Currently the manifest is rebuilt on every recorder reconnect. Store once on finish.

### Nice to Have

8. **Backup strategy** — R2 replication to a second bucket or region for durability.
9. **Configurable signed URL TTL** — Shorter TTL for segment access, longer for MP4 downloads.
10. **Storage metrics dashboard** — Track per-session storage size and growth rate.
