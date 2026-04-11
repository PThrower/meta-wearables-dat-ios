# PRD-004: Session Persistence & Playback

**Product:** com.mwdat-ios / Relay Server + Object Storage
**Owner:** @ebowwa
**Status:** P0 Complete
**Last Updated:** 2026-04-10
**Depends On:** PRD-002 (Multi-session relay), PRD-003 (AI detections to persist)

---

## Problem

All streamed data is ephemeral. When a session ends or the server restarts, every frame, audio chunk, and AI detection is lost. There is no way to:
- Replay a past session
- Review AI detections after the fact
- Build a training dataset from real glasses footage
- Provide compliance/audit trails for assistive use cases
- Show a gallery of past sessions to the operator or viewers

The server already sees every FRLY/FRAU frame in real-time. Writing to an S3-compatible bucket during the live session is the lowest-friction persistence path -- zero iOS changes, zero additional bandwidth from the phone.

---

## Users

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| **Operator** | Person who wore the glasses | Review past sessions; download recordings; see AI highlights |
| **Viewer** | Remote person who watched live | Replay sessions they missed or want to re-watch |
| **AI System** | Batch inference pipeline | Process stored video/audio for training, evaluation, transcription |
| **Platform Operator** | CaringMind team | Audit sessions; debug issues from recorded data; manage storage lifecycle |

---

## Current State

### What Exists

- `RecordingStage` on iOS writes `.mov` files locally (operator's phone)
- `session-recorder.ts` module exists in the relay server
- `session-export.ts` handles gallery data, MP4 export, thumbnails
- `@aws-sdk/client-s3` and `@ebowwa/object-store` are dependencies in `relay/server/package.json`
- `persistence-architecture.md` documents the full design (bucket layout, segment format, cost estimates)
- Gallery HTML (`gallery.html`) renders stored sessions with thumbnails

### Gaps

1. ~~**Server-side recorder not wired into fan-out**~~ -- RESOLVED: `session.recorder?.appendVideo(buf)` / `appendAudio(buf)` in server.ts message handler
2. ~~**No bucket provisioned**~~ -- RESOLVED: Hetzner Storage Box with S3 API, credentials via Doppler
3. ~~**No segment flush logic**~~ -- RESOLVED: `SessionRecorder` buffers and flushes on timed interval
4. ~~**No audio recording**~~ -- RESOLVED: FRAU PCM chunks captured alongside video
5. ~~**No session metadata persistence**~~ -- RESOLVED: `meta.json` with device info, timestamps, duration, frame count
6. ~~**No retrieval endpoints**~~ -- RESOLVED: signed URLs for video/audio segments, MP4 export, thumbnail endpoint
7. ~~**Gallery data injection is static**~~ -- RESOLVED: `galleryCached()` with 30s TTL, live from bucket

---

## Requirements

### P0 -- Must Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P0-1 | Session recorder integrated into relay fan-out | Every FRLY frame appended to recorder buffer alongside viewer delivery |
| P0-2 | Timed segment flush to S3-compatible bucket | JPEG frames buffered and flushed as `.mjpeg` segments every 10 seconds |
| P0-3 | Audio segment recording | FRAU PCM chunks buffered and flushed as `.pcm` segments every 10 seconds |
| P0-4 | Session metadata written on session start and end | `meta.json` with device info, timestamps, resolution, FPS, duration, frame count |
| P0-5 | Bucket layout: `sessions/{sessionId}/video/`, `audio/`, `meta.json` | Consistent key structure for retrieval and lifecycle rules |
| P0-6 | Hetzner Storage Box with S3 API as default provider | Zero egress cost within Hetzner network; credentials via Doppler |
| P0-7 | Configurable recording: on/off per session | Publisher can opt in/out of server-side recording via query param or control message |

### P1 -- Should Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P1-1 | Session listing from bucket (`GET /sessions?stored=true`) | Returns array of stored sessions with metadata, thumbnail URL, duration |
| P1-2 | Session video retrieval (`GET /recording/{id}/video`) | Streams MJPEG segments concatenated; playable in browser or downloadable |
| P1-3 | Session audio retrieval (`GET /recording/{id}/audio`) | Streams PCM segments; optionally transcoded to WAV with appropriate headers |
| P1-4 | AI detection persistence | `AIDetection` events written to `sessions/{sessionId}/ai/detections.jsonl` |
| P1-5 | Thumbnail generation per session | First frame of session saved as JPEG thumbnail to `sessions/{sessionId}/thumb.jpg` |
| P1-6 | Presigned URL generation for direct download | `GET /recording/{id}/download` returns S3 presigned URL (time-limited) |
| P1-7 | Opus audio transcoding | Stored PCM segments transcoded to Opus on flush; reduces audio storage from ~2.8 GB/hr to ~280 MB/hr; Opus files stored alongside PCM originals |

### P2 -- Could Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P2-1 | HLS transcoding via ffmpeg | Convert stored MJPEG + Opus (P1-7) to HLS `.m3u8` + `.ts` segments for standard video playback |
| P2-2 | ~~MP4 export~~ -- RESOLVED: `exportAndCacheMp4()` builds MP4 via ffmpeg, caches to R2, serves from `/session/{id}/video.mp4` |
| P2-3 | AI keyframe extraction | AI-flagged frames (person detected, text visible) saved as individual JPEGs with metadata |
| P2-4 | Whisper transcription of stored audio | Batch-process stored PCM segments through Whisper; write `transcriptions.jsonl` |
| P2-5 | Bucket lifecycle rules | Auto-expire video segments after 90 days; archive AI results to cold storage after 30 days |
| P2-6 | iOS-side upload of local `.mov` recordings | Post-session upload from `RecordingStage` to bucket via presigned URL |
| P2-7 | Cross-session search | Query across stored sessions by AI detection type, text content, date range |

---

## Technical Architecture

### Bucket Layout

```
caringmind-sessions/
  sessions/
    {sessionId}/
      meta.json                    -- device info, timestamps, config
      thumb.jpg                    -- first frame thumbnail
      video/
        seg-0001.mjpeg             -- concatenated JPEG frames (10s window)
        seg-0002.mjpeg
        ...
      audio/
        chunk-0001.pcm             -- raw PCM 16-bit 48kHz mono (10s window)
        chunk-0002.pcm
        ...
      ai/
        detections.jsonl           -- newline-delimited AIDetection events
        transcriptions.jsonl       -- Whisper output (P2-4)
        keyframes/                 -- AI-flagged frames (P2-3)
          000427-person.jpg
          001892-text.jpg
  index.json                       -- session directory cache
```

### Session Recorder Data Flow

```
publisher sends FRLY frame
       |
  server.ts fan-out
       |
       +---> viewers (existing)
       +---> AI workers (PRD-003 server-side)
       +---> SessionRecorder.appendVideo(frame)
                    |
                    v
              videoBuffer.push(jpegBytes)
                    |
              if (now - lastFlush > 10_000ms)
                    |
                    v
              S3 PutObject -> sessions/{id}/video/seg-{n}.mjpeg
              videoBuffer = []
              segmentIndex++

publisher sends FRAU frame
       |
       +---> SessionRecorder.appendAudio(frame)
              (same buffering pattern -> audio/chunk-{n}.pcm)
```

### Session Recorder Interface

```typescript
interface SessionRecorder {
  sessionId: string;
  s3: S3Client;
  bucket: string;
  
  videoBuffer: Uint8Array[];
  audioBuffer: Uint8Array[];
  segmentIndex: number;
  lastVideoFlush: number;
  lastAudioFlush: number;
  segmentIntervalMs: number;        // default 10_000
  
  totalFrames: number;
  totalAudioChunks: number;
  startedAt: number;
  
  appendVideo(frame: Uint8Array): void;
  appendAudio(frame: Uint8Array): void;
  flush(): Promise<void>;           // force flush remaining buffers
  finalize(): Promise<void>;        // flush + write meta.json + thumb.jpg
}
```

### Infrastructure

```
[Bun Relay Server :8080]
       |
       +---> Fan-out to viewers
       +---> Fan-out to AI workers
       +---> SessionRecorder
                |
                v
       [Hetzner Storage Box / S3 API]
         endpoint: fsn1.your-storagebox.de
         bucket: caringmind-sessions
         credentials: Doppler
```

### Retrieval Endpoints

| Endpoint | Method | Response |
|----------|--------|----------|
| `GET /sessions?stored=true` | HTTP | JSON array of stored session metadata |
| `GET /recording/{id}` | HTTP | Session metadata + links to video/audio/ai |
| `GET /recording/{id}/video` | HTTP | MJPEG stream (concatenated segments) |
| `GET /recording/{id}/audio` | HTTP | PCM stream (concatenated chunks) or WAV |
| `GET /recording/{id}/ai` | HTTP | `detections.jsonl` content |
| `GET /recording/{id}/download` | HTTP | Presigned S3 URL for direct download |

Server proxies bucket reads -- bucket is never public. Auth gates access (PRD-002 P1-2).

---

## Storage Cost Estimate

Per hour of streaming at 15fps, 720p JPEG at ~20KB/frame:

| Component | Size/Hour |
|-----------|-----------|
| Video (JPEG @ 15fps) | ~1.1 GB |
| Audio (PCM 48kHz mono) | ~2.8 GB |
| AI detections (JSON) | ~1-5 MB |
| Key frames (sporadic JPEG) | ~5-20 MB |
| Metadata | ~1 KB |
| **Total** | **~3.9 GB/hour** |

At Hetzner Storage Box pricing (~EUR 3.81/month for 100GB): ~25 hours of recording per 100GB. Lifecycle rules expire video segments after 90 days to bound cost.

---

## Success Metrics

| Metric | Target | Method |
|--------|--------|--------|
| Segment flush reliability | > 99.9% (no dropped segments) | Monitor segment count vs expected from frame count |
| Flush latency (buffer -> S3) | < 500ms per segment | Server-side timing |
| Recording overhead on frame delivery | < 2ms added latency to viewer fan-out | Profiling |
| Retrieval latency (segment fetch) | < 100ms within Hetzner network | S3 GET timing |
| Storage cost per session-hour | < EUR 0.15 | Bucket billing |

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| S3 flush failure loses segment | High | Retry with exponential backoff; hold buffer until confirmed; log gaps |
| Memory pressure from large video/audio buffers | High | Cap buffer size; flush early if approaching limit; drop oldest frames |
| Storage cost accumulates unbounded | Medium | Lifecycle rules (P2-5); configurable per-session recording (P0-7) |
| PCM audio is uncompressed (~2.8 GB/hour) | Medium | Opus transcoding (P1-7) reduces 10x to ~280 MB/hr; PCM kept as source until Opus is validated |
| MJPEG is not a standard playback format | Low | HLS transcoding (P2-1) for browser playback; MJPEG is fine for storage/retrieval |
| Bucket credentials exposure | Medium | Credentials via Doppler; server proxies all access; bucket not public |
