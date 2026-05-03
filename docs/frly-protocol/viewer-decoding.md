# Viewer Decoding

Browser-side FRLY/FRAU handling, A/V sync, codec switching, ring buffer, and push-to-talk.

All behavior described here is implemented in `RelayPlayer` (`relay-player.ts`) with supporting modules `frau-builder.ts`, `resampler.ts`, and `audio-worklet.ts`.

---

## Frame Dispatch

Binary frames arrive over a WebSocket (`binaryType = "arraybuffer"`). The first 4 bytes are compared against magic byte constants:

- `[0:4] === FRAU_MAGIC` --> `_handleAudioFrame`
- `[0:4] === FRLY_MAGIC` --> `_handleVideoFrame`
- Any buffer shorter than 4 bytes is silently dropped.

String frames are parsed as JSON and forwarded to the `onJsonMessage` callback (used by the guidance panel and bounding box system). Non-JSON strings are silently ignored.

---

## Video Decoding

### Dual Decoder Path

The viewer selects one of two decoder paths at runtime depending on browser support for the `VideoDecoder` WebCodecs API:

**WebCodecs (Chrome/Edge -- `typeof VideoDecoder !== "undefined"`):**
1. Parse Annex B NAL units from the H.264 payload via `_parseAnnexBNals`
2. Extract SPS (NAL type 7) and PPS (NAL type 8) from keyframes
3. Build `avcC` box from parameter sets
4. Derive codec string from SPS bytes (see below)
5. Create and configure `VideoDecoder` with `optimizeForLatency: true`
6. Strip SPS/PPS NALs, keep only VCL (slice) NALs
7. Convert remaining VCL NALs to AVCC format (4-byte big-endian length prefix) via `_annexBToAvcc`
8. Wrap in `EncodedVideoChunk` (timestamp in microseconds) and call `decoder.decode()`
9. Decoder output callback draws `VideoFrame` to canvas via `ctx.drawImage(frame, 0, 0)`, then closes the frame

**MSE/jMuxer (Safari/Firefox -- `VideoDecoder` is undefined):**
1. Hidden `<video>` element created: `muted=true`, `playsInline=true`, `autoplay=true`, `display=none`
2. `JMuxer` configured with:
   ```typescript
   {
     node: video,
     mode: "video",
     flushingTime: 50,     // 50ms flush interval
     fps: 15,
     debug: false,
     onReady: () => { video.play(); _startMSEDrawLoop(); },
     onError: (e) => { console.error(e); },
   }
   ```
3. Raw Annex B NALs fed directly to `jmuxer.feed({ video: payload })` -- no Annex-B-to-AVCC conversion needed
4. `requestAnimationFrame` loop draws the hidden `<video>` element to the visible canvas via `ctx.drawImage(mseVideo, 0, 0)`
5. Draw loop checks `mseVideo.readyState >= 2` (HAVE_CURRENT_DATA) before drawing; skips frames with zero dimensions

### NAL Parsing (`_parseAnnexBNals`)

Scans the payload for start codes and extracts NAL units:

- Recognizes both 3-byte (`00 00 01`) and 4-byte (`00 00 00 01`) start code prefixes
- Scans forward from each NAL start to find the next start code (or end-of-buffer) to determine the NAL boundary
- NAL type is extracted as `payload[nalStart] & 0x1F` (low 5 bits of the first byte after the start code)
- Returns an array of `{ type: number, data: Uint8Array }` where `data` is the NAL body (including the type byte but excluding the start code)
- If no start codes are found, returns an empty array (frame is logged as an error)

### avcC Wire Layout

The `_buildAvcC` method constructs the `avcC` (AVC Decoder Configuration Record) box:

```
[0]     configurationVersion = 1
[1]     AVCProfileIndication   (from SPS byte[1])
[2]     profile_compatibility  (from SPS byte[2])
[3]     AVCLevelIndication     (from SPS byte[3])
[4]     0xFF  (reserved 6 bits + lengthSizeMinusOne = 3, meaning 4-byte NAL lengths)
[5]     0xE0 | numSPS  (reserved 3 bits + SPS count)
[6:8]   SPS[0].length (big-endian u16)
[8:8+N] SPS[0] data
        ... repeat for each SPS
[k]     numPPS (u8)
[k+1:k+3] PPS[0].length (big-endian u16)
[k+3:k+3+M] PPS[0] data
        ... repeat for each PPS
```

All parts are assembled into a contiguous `Uint8Array`. The 4-byte NAL length prefix (`lengthSizeMinusOne = 3`) matches the `_annexBToAvcc` output format.

### Codec String Derivation from SPS Bytes

The codec string is derived from the first SPS NAL's raw bytes:

```typescript
const profile = sps[1];  // profile_idc (e.g., 0x42 = Baseline, 0x4D = Main, 0x64 = High)
const compat  = sps[2];  // constraint_set flags
const level   = sps[3];  // level_idc (e.g., 0x1E = level 3.0, 0x28 = level 4.0)
const codecStr = `avc1.${hex(profile)}${hex(compat)}${hex(level)}`;
// Example: "avc1.42001e" for Baseline profile, level 3.0
```

Each component is formatted as a 2-digit lowercase hex string (zero-padded). Defaults are `0x42`, `0x00`, `0x1E` if the SPS is too short.

### WebCodecs Queue Limit

If `videoDecoder.decodeQueueSize > 3`, non-keyframes are silently dropped (`return` without decode). Keyframes are always decoded regardless of queue depth. This prevents latency accumulation when the decoder falls behind.

### SPS Change Handling (Reconfigure In-Place)

When a keyframe arrives with new SPS/PPS parameter sets:

1. Current parameter sets are saved as `prevParams`
2. New parameter sets replace `_h264ParameterSets`
3. If the decoder already exists and is in `"configured"` state:
   - Byte-level comparison of the new SPS against the previous SPS (length check + element-wise equality)
   - If SPS changed: a new `avcC` is built from the updated SPS/PPS, and `videoDecoder.configure()` is called again with the new `codec` string and `description`
   - If `configure()` throws, the decoder is closed and nulled (will be recreated on the next frame with parameter sets)
4. The decoder is NOT destroyed on SPS change -- it is reconfigured in-place. This handles mid-stream resolution changes (e.g., publisher switches camera quality) without interrupting playback.

### MSE Pre-Buffer

Before MSE/jMuxer reports ready (`onReady` callback fires), incoming H.264 frames are buffered:

- `_msePendingFrames` array holds up to 5 `Uint8Array` payloads
- When `onReady` fires, all buffered frames are flushed to `jmuxer.feed()` in FIFO order
- Subsequent frames are fed directly without buffering
- Frames beyond the 5-frame limit during pre-buffer are silently dropped

### JPEG Rendering

JPEG frames are rendered using `new Image()` with a Blob URL, NOT `createImageBitmap`:

```typescript
_renderJPEGFrame(jpegPayload, width, height):
  1. blob = new Blob([jpegPayload], { type: "image/jpeg" })
  2. url = URL.createObjectURL(blob)
  3. img = new Image()
  4. img.onload = () => {
       ctx.drawImage(img, 0, 0)
       URL.revokeObjectURL(url)   // free the Blob URL immediately
     }
  5. img.src = url
```

Canvas dimensions are updated to match `width` x `height` on each frame if they differ. Bounding boxes are redrawn after each JPEG frame.

### Canvas Rendering Pipeline Summary

Both decoder paths converge on the same canvas drawing pattern:

| Path | Draw Method | Canvas Resize | Bounding Boxes |
|------|-------------|---------------|----------------|
| WebCodecs | `ctx.drawImage(VideoFrame, 0, 0)` in decoder output callback | Matched to `frame.displayWidth x displayHeight` | `drawBoundingBoxes()` after each draw |
| MSE/jMuxer | `ctx.drawImage(mseVideo, 0, 0)` in rAF loop | Matched to `video.videoWidth x videoHeight` | `drawBoundingBoxes()` after each draw |
| JPEG | `ctx.drawImage(img, 0, 0)` in Image.onload | Matched to FRLY header `width x height` | `drawBoundingBoxes()` after each draw |

All paths also store `lastVideoWidth` / `lastVideoHeight` for the bounding box coordinate system.

---

## Codec Switching (JPEG <-> H.264 Mid-Stream)

When a codec type change is detected (`_lastCodecType !== codecType`):

1. `lastSequence` reset to 0 -- prevents new codec's sequence numbers from being misinterpreted as a gap (which would trigger a spurious AIMD multiplicative decrease)
2. No explicit decoder flush -- sequence reset is the only mid-stream handling

`_destroyH264Decoder()` is only called in `_resetStreamState()` (full reconnect) and `destroy()`, NOT on codec switch. This means the H.264 decoder persists across JPEG interludes and resumes when H.264 frames return.

Server does NOT transcode. FRLY frames are forwarded as-is to all viewers. AI service forwarding is JPEG-only (H.264 excluded because it would require server-side decode).

---

## AIMD Backpressure (TCP-Style Congestion Control)

The viewer implements Additive Increase / Multiplicative Decrease (AIMD) backpressure to tell the server what FPS to target.

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `AIMD_DECREASE_FACTOR` | 0.5 | Multiplicative decrease: halve target FPS on frame drops |
| `AIMD_INCREASE_FPS` | 1 | Additive increase: +1 fps per probe interval |
| `AIMD_INCREASE_INTERVAL_MS` | 3000 | Probe upward every 3 seconds |
| `AIMD_MIN_FPS` | 1 | Floor -- never go below 1 fps |
| `AIMD_MAX_FPS` | 30 | Ceiling -- never exceed 30 fps (initial value) |

### Multiplicative Decrease (On Frame Drops)

When a sequence gap is detected (`sequence > lastSequence + 1`):
1. Count dropped frames: `dropped = sequence - lastSequence - 1`
2. Accumulate into `droppedFrames` total
3. Halve the target: `backpressureFps = max(AIMD_MIN_FPS, floor(backpressureFps * 0.5))`
4. If the value actually decreased, send `{ type: "backpressure", targetFps }` to server
5. Fire `onBackpressureFps` callback

### Additive Increase (Probe Upward)

Every `AIMD_INCREASE_INTERVAL_MS` (3s) since last backpressure send, AND only if:
- `backpressureFps < AIMD_MAX_FPS` (not already at ceiling)
- `bwEstimate >= BW_LOW_THRESHOLD` (bandwidth is healthy, >= 200 KB/s)

Then: `backpressureFps = min(AIMD_MAX_FPS, backpressureFps + 1)` and send to server.

### Bandwidth-Aware Override

If bandwidth is below threshold AND we have enough data to be reliable (`frameCount >= 15`, `bwEstimate < Infinity`):

```
bwFps = max(1, floor(bwEstimate / 20_000))   // ~20KB per frame at 30fps
if bwFps < backpressureFps:
    backpressureFps = bwFps
    send backpressure
```

This provides a secondary mechanism: even without sequence drops, low bandwidth forces the target down.

---

## Bandwidth Estimation

Sliding window approach tracking bytes received per second:

| Property | Value | Purpose |
|----------|-------|---------|
| `BW_WINDOW_SLOTS` | 5 | 5-second sliding window |
| `BW_LOW_THRESHOLD` | 200,000 (200 KB/s) | Below this, FPS is reduced |
| `bwWindowBytes` | `number[]` | Array of completed 1-second slot totals |
| `bwBytesInSlot` | `number` | Bytes accumulated in current incomplete slot |
| `bwWindowStart` | `number` | Timestamp when current slot began |
| `bwEstimate` | `number` | Smoothed estimate (average of window slots), initialized to `Infinity` |

### Algorithm

1. On each video frame, `_trackBandwidth(buf.length)` is called
2. Accumulate `buf.length` into `bwBytesInSlot`
3. If `elapsed >= 1000ms` since `bwWindowStart`:
   - Push `bwBytesInSlot` to `bwWindowBytes`
   - Zero-fill any gap slots (connection idle) -- up to `completedSlots - 1` zero entries
   - Trim to keep only the last `BW_WINDOW_SLOTS` entries
   - Reset `bwBytesInSlot = 0`, adjust `bwWindowStart`
   - Update `bwEstimate = sum(bwWindowBytes) / bwWindowBytes.length`
   - Fire `onBandwidth(bwEstimate)` callback if estimate is finite
4. `bwEstimate` starts at `Infinity` so bandwidth checks pass until real data is available

---

## Audio Playback

### FRAU Header Parsing

The `_handleAudioFrame` method parses the 36-byte FRAU header:

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| 0:4 | 4 | Magic "FRAU" | Already matched for dispatch |
| 4 | 1 | version | u8, expected to be 1 |
| 5:9 | 4 | payloadLen | u32 LE |
| 9 | 1 | codecType | u8, validated via `isKnownCodecType()` |
| 10:18 | 8 | sequence | u64 LE |
| 18:22 | 4 | sampleRate | u32 LE |
| 22:24 | 2 | channels | u16 LE |
| 24:26 | 2 | bitsPerSample | u16 LE, must be 16 |
| 26:34 | 8 | timestamp | u64 LE (ms) |
| 34:36 | 2 | headerCrc16 | u16 LE |
| 36: | variable | PCM payload | Int16 samples |

Frames with `bitsPerSample !== 16` or `payloadLength > actualPayload` are silently dropped.

### Multi-Channel Downmix

Before resampling, multi-channel audio is downmixed to mono in `_pushAudioToRing`:

```typescript
if (channels > 1):
  frames = floor(inSamples / channels)
  monoSamples = new Int16Array(frames)
  for each frame:
    monoSamples[i] = round(sum(pcmInt16[i*channels .. i*channels+channels]) / channels)
```

Simple arithmetic mean across all channels. Single-channel audio passes through unchanged.

### Resampling (Playback)

Uses `windowedSincResample` from `resampler.ts` -- a Lanczos windowed sinc interpolator (a=3):

- Input: `Int16Array` PCM at source sample rate
- Output: `Float32Array` normalized to [-1, 1] at the `AudioContext.sampleRate` (48kHz)
- If `srcRate === dstRate`: fast path -- just normalize Int16 to Float32 (`/ 32768.0`)
- Lanczos kernel: `L(x) = a * sin(pi*x) * sin(pi*x/a) / (pi*pi*x*x)` for `|x| < a`, 0 for `|x| >= a`
- Window size `a = 3`, so each output sample is influenced by up to 6 neighbors (3 on each side)
- Weighted average with normalization by `weightSum` to prevent DC bias

### Audio Level Metering

After resampling, the peak absolute value across the Float32 samples is tracked:

```typescript
for each sample:
  audioLevel = max(audioLevel, abs(sample))
pct = min(100, round(audioLevel * 300))   // scaled for UI display
cb.onAudioLevel(pct)
```

`audioLevel` is reset to 0 at the start of each `_playAudioChunk` call, so it represents the peak of the most recent chunk only.

### Dual Ring Buffer

There are two ring buffer implementations -- one in the AudioWorklet thread and one on the main thread as fallback:

#### AudioWorklet Ring Buffer (`audio-worklet.ts`)

Runs in a separate audio thread. The `RingDrainProcessor` is registered as `"ring-drain"`.

| Property | Value |
|----------|-------|
| `RING` | `Float32Array(96000)` -- 96,000 samples (2 seconds at 48kHz) |
| `PREBUFFER` | `48000 * 0.06 = 2880` samples (60ms at 48kHz) |
| `writePos`, `readPos`, `fill` | Circular buffer state |
| `started` | Prebuffer gate -- false until `fill >= PREBUFFER` |

Behavior:
- **Push** (via `postMessage`): Append Float32 samples to ring, wrapping at boundary. Discards samples if ring is full (`fill < RING.length` guard).
- **Process** (audio thread callback):
  - If `!started`: output zeros, check if `fill >= PREBUFFER` to start
  - If `started`: read `min(output.length, fill)` samples, output zeros for remainder
  - On underrun (`toRead < len`): zero remaining samples, reset `started = false`
  - Underrun requires re-prebuffer fill before resuming -- prevents clicks/pops
- **Reset** (via `postMessage({ type: "reset" })`): Zero all positions, set `started = false`

#### Main Thread Fallback Ring Buffer

| Property | Value |
|----------|-------|
| `RING_SIZE` | `48000 * 2 = 96000` samples |
| `RING_BUFFER` | `Float32Array(96000)` |
| `PREBUFFER_SAMPLES` | `48000 * 0.06 = 2880` samples |
| Buffer size (ScriptProcessor) | 4096 samples |

Identical logic to the worklet version but runs on the main thread via `ScriptProcessorNode.onaudioprocess`. Used when `audioWorklet.addModule()` fails (e.g., older browsers, CSP restrictions).

When the worklet IS loaded, the main thread ring buffer still receives samples from `pendingSamples` (buffered while the worklet was loading), but once the worklet is ready, all new samples go directly to the worklet via `postMessage`.

### No Jitter Buffer

There is no sequence reordering, no adaptive playout delay, and no packet loss concealment. The ring buffer acts purely as a prebuffer/flow buffer.

---

## A/V Sync

The viewer uses a **clock mapping** approach:

```typescript
videoClockBase: { senderMs: number; audioCtxTime: number } | null
```

Updated in two places:
1. **Video frames**: `senderMs = timestampMs`, `audioCtxTime = audioCtx.currentTime` (in `_handleVideoFrame`)
2. **Audio frames**: `senderMs = senderTimestampMs`, `audioCtxTime = audioCtx.currentTime` (in `_playAudioChunk`)

Both update the same `videoClockBase` singleton -- last writer wins. This means the mapping is continuously refined as frames arrive.

### Latency Computation

Relative latency (clock drift measurement, not absolute end-to-end):

```
firstFrameLocalTime   = Date.now() when first video frame arrived
firstFrameSenderTime  = timestampMs from first video frame's FRLY header

latency = (Date.now() - firstFrameLocalTime) - (timestampMs - firstFrameSenderTime)
absLatency = abs(latency)
```

This measures how the local clock's elapsed time compares to the sender's elapsed time. A growing positive value indicates clock drift (viewer falling behind). The absolute value is reported via `onLatency`.

No explicit look-ahead clamping or audio time-stretching. The ring buffer prebuffer (60ms) provides implicit jitter absorption. No dynamic clock correction or sample rate adjustment at playback time.

---

## Bounding Box Overlay System

The viewer supports a bounding box overlay rendered on a separate `<canvas id="overlayCanvas">` (sibling of the main video canvas in the DOM).

### Initialization

In the constructor, the overlay canvas is located as `canvas.nextElementSibling` if it matches `id === "overlayCanvas"`. If not found, the overlay system is inert (null checks guard all calls).

### Coordinate System

Bounding boxes are received in **1024-normalized coordinates** (0..1024 range), independent of actual video resolution:

```typescript
px = (box.x1 / 1024) * canvasWidth
py = (box.y1 / 1024) * canvasHeight
pw = ((box.x2 - box.x1) / 1024) * canvasWidth
ph = ((box.y2 - box.y1) / 1024) * canvasHeight
```

### Rendering

- 8-color palette: `#4ade80`, `#60a5fa`, `#facc15`, `#f87171`, `#a78bfa`, `#fb923c`, `#2dd4bf`, `#e879f9`
- Each box gets a color from the palette (cycling via `i % colors.length`)
- 2px stroke rectangle for the box
- Label above the box: `"{label} {confidence}%"` (confidence as rounded percentage)
- Label background: filled rectangle with the box color
- Label text: black, bold 11px SF Mono monospace

### Lifecycle

- `setBoundingBoxes(boxes)`: Update boxes and immediately redraw. Set a 10-second timeout (`bboxTimeout`) to clear boxes if no new bbox event arrives.
- `setShowOverlays(show)`: Toggle visibility. When hidden, `drawBoundingBoxes()` clears the overlay canvas.
- Boxes are redrawn after every video frame (JPEG onload, WebCodecs decoder output, MSE rAF draw).
- The overlay canvas is resized to match `lastVideoWidth x lastVideoHeight` on each draw call if dimensions differ.

---

## Stats Tracking

The following statistics are tracked and reported via callbacks:

| Stat | Callback | Updated When | Details |
|------|----------|-------------|---------|
| FPS | `onFps` | Every 1 second | `fpsFrameCount * 1000 / elapsed_ms`, rounded |
| Frame count | internal | Each video frame | `frameCount++`, `fpsFrameCount++` |
| Sequence | `onSequence` | Each video frame | Raw sequence number from FRLY header |
| Dropped frames | `onDropped` | On sequence gap + each frame | Cumulative total of all gaps |
| Video size | `onSize` | Each video frame | `width`, `height` from FRLY header |
| Latency | `onLatency` | Each video frame | `abs((localNow - firstFrameLocal) - (senderTs - firstFrameSenderTs))` |
| Bandwidth | `onBandwidth` | ~Every 1 second | Smoothed bytes/sec from 5-second sliding window |
| Backpressure FPS | `onBackpressureFps` | On AIMD event | Current AIMD target FPS |
| Audio state | `onAudioState` | Each audio frame | `"ON"` when audio is active |
| Audio level | `onAudioLevel` | Each audio chunk | Peak amplitude as percentage (0-100, scaled by * 300) |
| Audio codec | `onAudioCodec` | Each audio frame | `(codecType, sampleRate)` |
| Connection state | `onConnectionState` | WebSocket events | `"connected"`, `"disconnected"`, `"reconnecting"`, `"error"` |
| Status | `onStatus` | Various | Human-readable string: `"CONNECTED"`, `"CLOSED"`, `"RECONN Ns"`, `"AUTH REQUIRED"`, `"ACCESS DENIED"`, `"ERROR"` |

### H.264 Debug State

Internal `_h264Debug` object tracks (drawn on canvas for live diagnostics when enabled):

| Field | Description |
|-------|-------------|
| `framesIn` | Total H.264 frames received |
| `nalsParsed` | NAL units parsed from most recent frame |
| `vclNals` | VCL (slice) NALs in most recent frame |
| `spsFound` / `ppsFound` | Whether SPS/PPS found in current frame |
| `decoderState` | `VideoDecoder.state` |
| `decoderPath` | `"WebCodecs"` or `"MSE"` |
| `lastError` | Last error message |
| `codecStr` | Derived codec string (e.g., `"avc1.42001e"`) |
| `avccSize` | Size of avcC box in bytes |

---

## Viewer Reconnect Behavior

### Normal Close (Intentional)

`disconnect()` sets `intentionalClose = true` and `lastUrl = null`. No reconnect is attempted.

### Abnormal Close (Connection Lost)

When `ws.onclose` fires and `!intentionalClose`:

1. Call `_resetStreamState()` (resets all counters, destroys decoders, clears ring buffers)
2. Fire `onConnectionState("reconnecting")` and `onStatus("RECONN Ns")`
3. Schedule reconnect with exponential backoff:
   - Initial delay: 1000ms
   - Multiplier: `delay = min(delay * 2, RECONNECT_MAX)`
   - Maximum delay: 15000ms (15 seconds)
4. On reconnect: re-read auth token from `localStorage` (`relay_token`), call `connect(lastUrl, shareToken, freshToken)`
5. On successful open: reset `reconnectDelay` back to 1000ms, send `{ type: "hello", token, gitCommit, buildVersion }`

### Auth-Related Close Codes

| Code | Behavior |
|------|----------|
| 401 / 4001 | Set `intentionalClose = true`, fire `onAuthRequired()`, remove `relay_token` from localStorage. No reconnect. |
| 4003 | Set `intentionalClose = true`, fire `onStatus("ACCESS DENIED")`. No reconnect. |

---

## Push-to-Talk (Viewer -> Publisher)

### Capture Chain

1. **`startMic()`** -> `navigator.mediaDevices.getUserMedia` with constraints:
   - `sampleRate: 16000`, `channelCount: 1`
   - `echoCancellation: true`, `noiseSuppression: true`, `autoGainControl: true`
2. **Separate `AudioContext`** at 48kHz (`new AudioContext({ sampleRate: 48000 })`) -- browsers ignore the 16kHz constraint in `getUserMedia` and typically run the audio pipeline at 48kHz
3. **Inline `AudioWorkletProcessor`** (`"mic-capture"`): registered from a Blob URL to avoid needing a separate static file. The processor transfers `Float32Array` buffers to the main thread via `postMessage(ch0.buffer, [ch0.buffer])` (transferable, zero-copy)
4. **Main thread resampling**: naive nearest-neighbor decimation from 48kHz to 16kHz:
   ```typescript
   ratio = srcSampleRate / targetSampleRate   // 48000/16000 = 3.0
   outLength = floor(input.length / ratio)
   for each output sample i:
     srcIdx = floor(i * ratio)               // pick every 3rd sample
     sample = clamp(input[srcIdx], -1, 1)
     pcmInt16[i] = sample * 0x7FFF           // Float32 -> Int16
   ```
5. **Frame building**: `buildFrauFrame(codecType=3, seqNum, 16000, 1, 16, pcmInt16)` -- delegates to `@ebowwa/relay-protocol` `buildAudioFrame`
6. **Send**: `ws.send(frame)` as binary ArrayBuffer over the viewer WebSocket

### FRAU Wire Format for Push-to-Talk

The frame produced by `buildFrauFrame` has the v1 wire layout (36 byte header + PCM payload):

| Offset | Field | Value for PTT |
|--------|-------|---------------|
| [0:4] | Magic | `"FRAU"` |
| [4] | version | 1 |
| [5:9] | payloadLen | Length of PCM data in bytes |
| [9] | codecType | 3 (relay inbound) |
| [10:18] | sequence | Incrementing `micSeqNum` |
| [18:22] | sampleRate | 16000 |
| [22:24] | channels | 1 |
| [24:26] | bitsPerSample | 16 |
| [26:34] | timestamp | `Date.now()` (ms) |
| [34:36] | headerCrc16 | CRC-16 of header |
| [36:] | payload | Raw Int16 PCM bytes |

### Server Relay

Binary frames from viewers are checked: `isAudioFrame(buf)` -> forwarded to publisher via `sendToPublisher()`. Dropped if publisher not connected.

### Viewer Mic Resampling Method

Push-to-talk uses naive nearest-neighbor decimation (`srcIdx = Math.floor(i * ratio)`) rather than the Lanczos windowed sinc used for playback. This is a deliberate trade-off: nearest-neighbor is faster and sufficient for 8kHz-origin audio from glasses HFP mic being upsampled to 48kHz by the browser then decimated back to 16kHz. The quality loss is negligible compared to the HFP bandwidth limitation (8kHz mono).

### Cleanup

`stopMic()`:
1. Disconnect worklet node and null its `onmessage` handler
2. Disconnect `MediaStreamAudioSourceNode`
3. Stop all `MediaStream` tracks
4. Close the mic `AudioContext`
5. Set `isMicActive = false`
