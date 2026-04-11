# HLS Recorder Architecture

**Status**: Planned (not implemented)

## Context

The `SessionRecorder` currently writes raw MJPEG+PCM segments to R2. This is AI-friendly (raw JPEGs for vision models) but requires manual ffmpeg processing to play back. HLS (.ts + .m3u8) plays natively in browsers with zero post-processing.

Rather than replacing the current recorder, abstract the interface so either format can be selected at runtime via env var.

## Interface

```ts
interface SessionRecorder {
  readonly sessionId: string;
  start(params: Record<string, string | null>): void;
  appendVideo(frame: Uint8Array): void;  // FRLY binary (29-byte header + JPEG payload)
  appendAudio(frame: Uint8Array): void;  // FRAU binary (29-byte header + PCM payload)
  finish(): Promise<void>;
  getStats(): RecorderStats;
}
```

## Implementations

### MjpegRecorder (current)

- Buffers JPEG frames, flushes every 10s as `sessions/{id}/video/seg-NNNN.mjpeg`
- Buffers PCM samples, flushes every 10s as `sessions/{id}/audio/chunk-NNNN.pcm`
- Writes `sessions/{id}/meta.json` on start and finish
- Raw frames, trivial for AI/ML consumption
- Playback requires manual ffmpeg transcoding

### HlsRecorder (future)

- Muxes JPEG+PCM into MPEG-TS segments via ffmpeg pipe or WASM muxer
- Flushes every 10s as `sessions/{id}/video/seg-NNNN.ts`
- Maintains and writes `sessions/{id}/stream.m3u8` playlist
- Appends `#EXT-X-ENDLIST` on `finish()` for VOD playback
- Live viewers can open the .m3u8 during recording (omit ENDLIST until finish)
- Browser-native playback via `<video>` + hls.js

## Selection

Env var `RECORDER_FORMAT` controls which implementation is instantiated:

```
RECORDER_FORMAT=mjpeg    # default, current behavior
RECORDER_FORMAT=hls      # future, browser-native playback
```

In `server.ts`:

```ts
const recorder: SessionRecorder = process.env.RECORDER_FORMAT === "hls"
  ? new HlsRecorder(publisher.id, store)
  : new MjpegRecorder(publisher.id, store);
```

No other code in the server changes. The fan-out loop, WebSocket handlers, and retrieval endpoints are recorder-agnostic.

## Trade-offs

| | MjpegRecorder | HlsRecorder |
|---|---|---|
| AI frame access | Raw JPEGs, zero decode | Must decode H.264 |
| Browser playback | Requires ffmpeg post-processing | Native `<video>` tag |
| CPU on VPS | Minimal (Buffer.concat) | H.264 encoding overhead |
| Storage format | `.mjpeg` + `.pcm` (separate) | `.ts` (muxed) + `.m3u8` |
| Live replay | Not supported | Supported (~10s latency) |
| Audio sync | Separate files, manual alignment | Muxed into `.ts`, in sync |

## Retrieval Endpoints

MjpegRecorder endpoints (current):
- `GET /sessions` — list session IDs
- `GET /session/:id` — meta.json
- `GET /session/:id/video/:seg` — signed URL redirect
- `GET /session/:id/audio/:chunk` — signed URL redirect

HlsRecorder would add:
- `GET /session/:id/stream.m3u8` — HLS playlist
- `GET /session/:id/video/:seg` — signed URL redirect (same path, `.ts` files)

## When to implement

No rush. Trigger points:
- Need browser-native session playback without ffmpeg
- Need live replay (watch recorded stream in near-real-time)
- Need mobile playback of recorded sessions
