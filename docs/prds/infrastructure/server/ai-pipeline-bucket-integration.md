# AI Pipeline: Real-Time and Persisted

How the AI pipeline works with and without external bucket storage. The bucket is additive -- everything functions without it. Adding persistence means AI results survive session end and can be re-processed.

Written 2026-04-03 as a planning document. Depends on:
- `docs/ai-integration-architecture.md` -- AI tap points and worker design
- `docs/persistence-architecture.md` -- bucket storage and session recorder
- `docs/object-store-package.md` -- `@ebowwa/object-store` interface
- `docs/multi-tenant-bucket-architecture.md` -- user-partitioned key layout

---

## Without Bucket: Real-Time Only

No external storage. All AI processing happens on live frames. Results are ephemeral.

```
iOS App                                     Server
======                                      ======

AIStage (on-device, 4fps)                   /analyze WebSocket
  - CoreML person/face detection              |
  - Results: in-memory, UI alerts             v
  - Zero network cost                    AI Worker Service
                                           - receives live FRLY frames
                                           - runs inference (VLM, Whisper)
                                           - returns results via WS
                                           - NO persistence -- gone when
                                             session ends
```

### Two Real-Time Paths

**Path 1: On-Device AIStage**

Add `AIStage: FramePipelineStage` to the iOS pipeline. No server changes, no network cost.

```swift
actor AIStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "ai"
    var config = FrameStageConfig(targetFPS: 4)  // 4fps for CV tasks

    func processFrame(_ packet: FramePacket) async {
        // CMSampleBuffer -> VNImageRequestHandler
        // Vision framework: person detection, face detection, text recognition
        // Results stay on device -- UI alerts, local state
    }
}
```

Good for: person entered room, fall detection, face proximity alerts.
Limits: iPhone GPU/battery, 4-8fps ceiling for non-trivial models.

**Path 2: Server-Side /analyze Endpoint**

Add `WS /analyze?session=<id>` to relay server. Functions identically to `/view` but fans out to an AI worker service instead of a browser.

```
Publisher --> server.ts --> fan-out to viewers (existing)
                          --> fan-out to AI worker (new, same mechanism)
```

The AI worker receives raw FRLY binary, strips the 29-byte header, decodes JPEG, runs inference, sends results back via WebSocket message.

Good for: heavy models (VLM scene description, Whisper transcription), zero phone impact.
Limits: network latency (50-200ms + inference time), bandwidth cost per frame.

### What's Missing Without Bucket

- AI results vanish when session ends
- Cannot re-analyze with better models later
- No historical search over detections
- No keyframe archive for review
- No compliance audit trail

---

## With Bucket: Persisted AI Results

Same real-time paths, plus AI writes results to the bucket alongside video/audio.

```
iOS App                                     Server                              Bucket
======                                      ======                              ======

AIStage (same as above)                     /analyze (same as above)            data/{userId}/{sessionId}/
                                              |                                    |
                                              v                                    v
                                        Session Recorder                   video/seg-*.mjpeg
                                        writes EVERYTHING                  audio/chunk-*.pcm
                                        to bucket in real-time             ai/
                                           |                                 detections.jsonl
                                           v                                 transcriptions.jsonl
                                        AI Worker writes                   keyframes/*.jpg
                                        results to bucket
                                        alongside video
```

### Three Paths With Bucket

**Path 1: On-Device AIStage** -- unchanged. Still ephemeral on phone. Bucket doesn't affect it.

**Path 2: Live Server + Bucket Writes**

AI worker receives live frames AND writes results to the user's bucket prefix during the session:

```ts
// AI worker processes live frame AND persists result
async function processAndStore(frame: Buffer, store: ObjectStore, userId: string, sessionId: string) {
  const result = await runInference(frame);

  // Real-time: send result back to server for alerts/overlay
  this.ws.send(JSON.stringify(result));

  // Persisted: append to detections log in bucket
  const line = JSON.stringify(result) + "\n";
  const existing = await store.get(`data/${userId}/${sessionId}/ai/detections.jsonl`);
  const updated = existing ? Buffer.concat([existing, Buffer.from(line)]) : Buffer.from(line);
  await store.put(`data/${userId}/${sessionId}/ai/detections.jsonl`, updated);

  // Persisted: save keyframe if significant
  if (result.hasPerson || result.hasText) {
    const key = `data/${userId}/${sessionId}/ai/keyframes/${result.frameSeq.toString().padStart(6, "0")}-${result.label}.jpg`;
    await store.put(key, frame);
  }
}
```

**Path 3: Batch / Post-Hoc Processing**

After session ends, read stored segments from bucket and re-process:

```ts
// Re-analyze a stored session with a new model
async function reprocessSession(userId: string, sessionId: string, store: ObjectStore) {
  const keys = await store.list(`data/${userId}/${sessionId}/video/`);
  for (const key of keys) {
    const segment = await store.get(key);
    if (!segment) continue;

    // Split MJPEG segment into individual JPEG frames (split on 0xFFD8 SOI marker)
    const frames = splitMjpeg(segment);
    for (const frame of frames) {
      const result = await runInference(frame);  // possibly a new/better model
      // Append to detections.jsonl or overwrite
    }
  }
}
```

Good for: re-analysis with improved models, compliance review, training data extraction, historical search.

---

## Comparison: With vs Without Bucket

| | Without Bucket | With Bucket |
|---|---|---|
| Real-time AI | Yes (live frames) | Yes (live frames) |
| AI results stored | No -- ephemeral | Yes -- `ai/*.jsonl` in bucket |
| Re-analyze later | No -- data gone | Yes -- read segments from bucket |
| Keyframe extraction | No | Yes -- `ai/keyframes/*.jpg` |
| Historical search | No | Yes -- `SessionIndex.getByUser()` then scan `detections.jsonl` |
| Compliance audit trail | No | Yes -- detections and transcriptions persist |
| Cost | Compute only | Compute + storage |

---

## Shared Code: Same Interface

Both real-time and stored paths use the same AI worker logic. The worker doesn't care where frames come from:

```ts
// Real-time: frames arrive via WebSocket
aiWorker.processFrame(frlBuffer);

// Stored: frames read from bucket
const segment = await store.get(`data/${userId}/${sessionId}/video/seg-0001.mjpeg`);
const frames = splitMjpeg(segment);
for (const frame of frames) {
  aiWorker.processFrame(frame);
}
```

Same `processFrame()` method. The only difference is transport.

When the bucket is enabled, the AI worker gains a `store: ObjectStore` reference and writes results alongside the session recorder's video/audio segments. The `ObjectStore` interface (see `docs/object-store-package.md`) abstracts the provider -- works with Hetzner, R2, GCS, AWS, or in-memory for testing.

---

## Data Flow: Bucket Enabled

```
Publisher frame arrives at server
       |
       +---> fan-out to viewers (existing)
       |       |
       |       v
       |     Browser: Canvas + AudioContext
       |
       +---> fan-out to AI worker (WebSocket)
       |       |
       |       v
       |     AI Worker receives FRLY binary
       |       |
       |       +---> strip 29-byte header, decode JPEG
       |       +---> run inference
       |       +---> return real-time results (WS message back to server)
       |       +---> append to ai/detections.jsonl (via ObjectStore)
       |       +---> save keyframes to ai/keyframes/ (via ObjectStore)
       |
       +---> session recorder buffers + flushes to bucket
               |
               +---> video/seg-*.mjpeg (every 10s)
               +---> audio/chunk-*.pcm (every 10s)
               +---> meta.json (on session start/end)
```

### Fan-Out in server.ts

Adding bucket persistence doesn't change the fan-out loop. The session recorder and AI worker are just additional consumers:

```ts
// Current fan-out (viewers only)
for (const [id, viewer] of session.viewers) {
  if (viewer.relay.should_relay(Date.now())) {
    viewer.ws.send(frame);
  }
}

// With AI worker + bucket
for (const [id, viewer] of session.viewers) {
  if (viewer.relay.should_relay(Date.now())) {
    viewer.ws.send(frame);
  }
}

for (const [id, analyzer] of session.analyzers) {
  if (analyzer.relay.should_relay(Date.now())) {
    analyzer.ws.send(frame);
  }
}

// Session recorder gets every frame (no throttle)
if (session.recorder) {
  session.recorder.append(frame);
}
```

---

## Bucket Key Layout: AI Data

```
bucket/
  data/
    {userId}/
      {sessionId}/
        meta.json
        video/
          seg-0001.mjpeg
          seg-0002.mjpeg
        audio/
          chunk-0001.pcm
          chunk-0002.pcm
        ai/
          detections.jsonl          -- every AI inference result
          transcriptions.jsonl      -- Whisper output with timestamps
          keyframes/
            000427-person.jpg       -- frame 427, person detected
            001892-text.jpg         -- frame 1892, text recognized
  index/
    users/{userId}.json
    sessions/{sessionId}.json
    recent.json
```

### detections.jsonl Format

```jsonl
{"ts":1712157600000,"seq":427,"type":"person","count":1,"bbox":[120,80,200,300],"confidence":0.94}
{"ts":1712157601000,"seq":450,"type":"person","count":2,"bboxes":[[120,80,200,300],[400,60,180,280]],"confidence":0.91}
{"ts":1712157602000,"seq":501,"type":"text","text":"EXIT","bbox":[300,200,80,30],"confidence":0.88}
```

One JSON object per line, append-only. Efficient to read incrementally (read N lines from end for latest results).

### transcriptions.jsonl Format

```jsonl
{"ts":1712157600000,"startMs":0,"endMs":5000,"text":"Hello, can you see the door?","language":"en","confidence":0.92}
{"ts":1712157605000,"startMs":5000,"endMs":10000,"text":"Yes, it's on your left.","language":"en","confidence":0.89}
```

Timestamps aligned with FRLY video timestamps (same epoch) for audio/video synchronization.

---

## AI Worker Interface

The AI worker exposes a common interface regardless of input source:

```ts
interface AIWorker {
  processFrame(jpegBuffer: Buffer): Promise<InferenceResult | null>;
}

interface InferenceResult {
  timestamp: number;
  frameSeq: number;
  detections: Detection[];
  transcription?: string;
}

interface Detection {
  type: "person" | "face" | "text" | "object" | "anomaly";
  label?: string;
  confidence: number;
  bbox?: [number, number, number, number];
  text?: string;
}
```

The worker is input-agnostic. It receives a JPEG buffer and returns structured results. The caller (server for real-time, batch script for stored) handles transport and persistence.

---

## Batch Processing Jobs

When bucket is enabled, post-hoc processing becomes possible:

| Job | Input | Output | Trigger |
|-----|-------|--------|---------|
| Re-detect | `video/seg-*.mjpeg` | `ai/detections.jsonl` | New model deployed |
| Transcribe | `audio/chunk-*.pcm` | `ai/transcriptions.jsonl` | After session ends |
| Extract keyframes | `video/seg-*.mjpeg` | `ai/keyframes/*.jpg` | After session ends, or on event |
| Scene summary | `ai/detections.jsonl` + `ai/transcriptions.jsonl` | `ai/summary.json` | After session ends |
| Compliance scan | All `ai/` data | Alert or report | Scheduled (daily, weekly) |

Batch jobs read from bucket via `ObjectStore`, process with the same `AIWorker`, and write results back to bucket. No changes to relay server needed.

---

## Implementation Sequence

```
Phase 1: Real-time only (no bucket)
  - iOS AIStage with Vision framework (zero server changes)
  - Server /analyze WebSocket endpoint
  - AI worker service (separate process)

Phase 2: Add bucket persistence
  - Session recorder writes video/audio to bucket
  - AI worker writes detections.jsonl and keyframes to bucket
  - SessionIndex tracks sessions

Phase 3: Batch processing
  - Post-session re-analysis from stored data
  - Transcription of stored audio via Whisper
  - Historical search over detections

Phase 4: Multimodal
  - Combined vision + audio context analysis
  - Scene summaries from stored data
  - Compliance reporting
```

Each phase builds on the previous. Phase 1 works standalone. Phase 2 adds persistence. Phase 3 adds historical analysis. The `ObjectStore` and `SessionIndex` interfaces stay the same across all phases.

---

## Staleness Warning

This document was written against the codebase on `feat/telemetry-diagnostics` at commit `33ea802`. Depends on:

- `docs/ai-integration-architecture.md` -- AI tap points and worker design
- `docs/persistence-architecture.md` -- bucket storage and session recorder
- `docs/object-store-package.md` -- `@ebowwa/object-store` abstraction
- `docs/multi-tenant-bucket-architecture.md` -- user-partitioned key layout and `SessionIndex`
- `docs/pipeline-architecture.md` -- wire protocols and fan-out mechanism
- `docs/multi-session-platform.md` -- session routing
- `docs/auth-google-oauth.md` -- auth gating on retrieval endpoints
