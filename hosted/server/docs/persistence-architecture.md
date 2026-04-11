# Persistence Architecture -- External Bucket Storage

How to persist streamed content (video, audio, AI results) to external object storage. Written 2026-04-03 against commit `33ea802` on `feat/telemetry-diagnostics`.

This is a planning document. The current server has no persistence layer -- all data is in-memory and lost on restart or session end.

---

## Two Capture Paths

```
Path A: iOS-side                    Path B: Server-side
=============                       ================

RecordingStage (.mov)               server.ts (sees every frame)
       |                                   |
       v                                   v
  Local file upload                  Stream-to-bucket
  after session ends                 during live session
```

**Path A (iOS)** already exists -- `RecordingStage` writes `.mov` locally. Problem: uploading a full recording after session means data only exists after the session ends. If the phone dies or loses connection, it's lost.

**Path B (Server)** is the preferred approach. The server already sees every FRLY/FRAU frame. It can write to a bucket in real-time without touching phone bandwidth or battery.

---

## What Gets Stored

| Data | Format | Who Writes | When |
|------|--------|-----------|------|
| Video segments | JPEG sequence or `.ts` segments | Server | Live, every N seconds |
| Audio segments | PCM chunks or `.wav` | Server | Live, every N seconds |
| AI detections | JSON | AI Worker | Per-inference |
| Transcriptions | JSON + text | AI Worker | Per-segment |
| Session metadata | JSON | Server | Session start/end |
| Key frames | JPEG (flagged by AI) | AI Worker | On event (person detected, etc.) |

---

## Bucket Layout

```
bucket/
  sessions/
    {sessionId}/
      meta.json                    -- device info, timestamps, session config
      video/
        seg-0001.mjpeg             -- or .ts for HLS, or individual JPEGs
        seg-0002.mjpeg
        ...
      audio/
        chunk-0001.pcm             -- raw FRAU payload, or transcoded
        chunk-0002.pcm
        ...
      ai/
        detections.jsonl           -- newline-delimited AI results
        transcriptions.jsonl       -- whisper output with timestamps
        keyframes/
          000427-person.jpg        -- AI-flagged key frame
          001892-text.jpg
  index.json                       -- session directory for listing
```

---

## Provider Options

| Provider | Why | S3-Compatible | Egress Cost |
|----------|-----|--------------|-------------|
| **Hetzner Storage Box** | Already on Hetzner infra | Yes (S3 API) | Free (internal) |
| **Cloudflare R2** | Zero egress, S3-compatible | Yes | $0 |
| **Google Cloud Storage** | Aligns with Google OAuth choice | Yes | Paid |
| **AWS S3** | Industry standard | Native | Paid |

Hetzner Storage Box with S3 API is the natural fit. Zero egress within Hetzner network, S3-compatible so the Bun server uses `@aws-sdk/client-s3`.

---

## Server-Side Recording: Session Recorder

New concept: a server-side recording consumer that writes to bucket alongside viewer fan-out.

### Data Structure

```ts
interface SessionRecorder {
  sessionId: string;
  bucket: S3Client;
  videoBuffer: Buffer[];     // accumulate JPEG frames into segments
  audioBuffer: Buffer[];     // accumulate PCM chunks
  segmentInterval: number;   // flush every N seconds (e.g. 10s)
  lastFlush: number;
}
```

### Fan-Out with Recording

When a frame arrives from the publisher:

```
publisher sends frame
       |
       v
server.ts
       |
       +---> fanout to viewers (existing)
       +---> fanout to AI workers (planned)
       +---> sessionRecorder.append(frame)  <-- NEW
                |
                v
          buffer JPEG frames
          every 10s: flush segment to bucket
          on session end: flush remaining + write meta.json
```

### SDK Integration

Bun server uses `@aws-sdk/client-s3` (works with any S3-compatible endpoint):

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: "https://fsn1.your-storagebox.de",  // Hetzner
  region: "fsn1",
  credentials: { accessKeyId: "...", secretAccessKey: "..." },
});

async function flushSegment(sessionId: string, segIndex: number, data: Buffer) {
  await s3.send(new PutObjectCommand({
    Bucket: "caringmind-sessions",
    Key: `sessions/${sessionId}/video/seg-${segIndex.toString().padStart(4, "0")}.mjpeg`,
    Body: data,
  }));
}
```

Credentials via Doppler (existing secrets workflow):

```
S3_ENDPOINT     = https://fsn1.your-storagebox.de
S3_REGION       = fsn1
S3_ACCESS_KEY   = (from Doppler)
S3_SECRET_KEY   = (from Doppler)
S3_BUCKET       = caringmind-sessions
```

---

## Data Flow with Persistence

```
iOS App                          Bun Relay Server                    External
  |                                    |                            S3 Bucket
  |  FRLY video frames                 |                               |
  |  FRAU audio frames                 |                               |
  |  --------------------------------> |                               |
  |                                    |                               |
  |                                    +---> viewers (fan-out)         |
  |                                    +---> AI worker                 |
  |                                    |       |                       |
  |                                    |       +-- detections.jsonl --> |
  |                                    |       +-- keyframes/*.jpg ---> |
  |                                    |       +-- transcripts -------> |
  |                                    |                               |
  |                                    +---> session recorder          |
  |                                            |                       |
  |                                            +-- video/seg-*.mjpeg -> |
  |                                            +-- audio/chunk-*.pcm -> |
  |                                            +-- meta.json ---------> |
  |                                                                    |
  |                                 Playback / Retrieval               |
  |  <---- GET /recording/{sessionId} ---------------------------------|
  |  <---- GET /sessions (list from bucket index) ---------------------|
```

---

## Retrieval Endpoints

New HTTP endpoints on the relay server for accessing stored sessions:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sessions` | GET | List stored sessions from bucket index |
| `/session/{id}` | GET | Serve session metadata |
| `/recording/{id}/video` | GET | Stream recorded video (segmented) |
| `/recording/{id}/audio` | GET | Stream recorded audio |
| `/recording/{id}/ai` | GET | Return AI detections + transcriptions |

The server proxies bucket reads rather than making the bucket public. This allows auth to gate access (see `docs/auth-google-oauth.md`).

---

## Retention and Lifecycle

| Data Type | Retention | Reason |
|-----------|-----------|--------|
| Video segments | 30-90 days | Storage cost, compliance window |
| AI detections | 1 year+ | Low volume JSON, useful for trends |
| Key frames | 1 year+ | Small JPEGs, high value |
| Transcriptions | 1 year+ | Low volume text, compliance |
| Session metadata | Indefinite | Tiny JSON, reference data |

Bucket lifecycle rules handle auto-expiration. AI results can be archived to cheaper storage tiers after 30 days.

S3 lifecycle configuration:

```json
{
  "Rules": [
    {
      "ID": "ExpireVideoSegments",
      "Filter": { "Prefix": "sessions/" },
      "Status": "Enabled",
      "Expiration": { "Days": 90 }
    },
    {
      "ID": "ArchiveAIResults",
      "Filter": { "Prefix": "sessions/" },
      "Status": "Enabled",
      "Transitions": [
        { "Days": 30, "StorageClass": "STANDARD_IA" }
      ]
    }
  ]
}
```

---

## Recording Format Considerations

### Video: JPEG Sequence vs HLS

| Format | Pros | Cons |
|--------|------|------|
| JPEG sequence (`.mjpeg`) | Simple, each frame independent, easy to seek | Large files, no standard player support |
| HLS segments (`.ts`) | Standard playback, adaptive bitrate | Requires ffmpeg transcoding on server |
| Individual JPEGs per frame | Granular, easy to extract keyframes | Many small objects, higher S3 PUT costs |

For initial implementation, JPEG sequences flushed as segments are simplest. Each segment is a concatenation of JPEG frames from a time window. Playback can reconstruct by splitting on JPEG SOI markers (`0xFFD8`).

### Audio: Raw PCM vs Compressed

| Format | Pros | Cons |
|--------|------|------|
| Raw PCM 16-bit 48kHz | Already in FRAU payload, zero CPU | Large (~768 KB/sec) |
| Opus | 10x smaller, good quality | Requires transcoding on server |
| FLAC | Lossless, 2-3x smaller | Requires transcoding on server |

For initial implementation, raw PCM is simplest -- the FRAU payload is already PCM. Compression can be added as a post-processing step or later optimization.

---

## Storage Cost Estimation

Per hour of streaming at 15fps, 720p JPEG at ~20KB/frame:

| Component | Size/Hour | Notes |
|-----------|-----------|-------|
| Video (JPEG @ 15fps) | ~1.1 GB | 20KB * 15 * 3600 |
| Audio (PCM 48kHz mono) | ~2.8 GB | 768KB * 3600 |
| AI detections | ~1-5 MB | JSON, low volume |
| Key frames | ~5-20 MB | Sporadic JPEGs |
| Metadata | ~1 KB | Tiny |
| **Total** | **~3.9 GB/hour** | |

At Hetzner Storage Box pricing (~EUR 3.81/month for 100GB), roughly 25 hours of storage per 100GB. Lifecycle rules keep active sessions on hot storage and expire older data.

---

## Staleness Warning

This document was written against the codebase on `feat/telemetry-diagnostics` at commit `33ea802`. The persistence architecture depends on:

- Multi-session routing being implemented (see `docs/multi-session-platform.md`)
- AI integration being designed (see `docs/ai-integration-architecture.md`)
- Auth gating bucket access (see `docs/auth-google-oauth.md`)

Before implementing persistence, re-read the affected files and update this document.
