/**
 * SessionRecorder — records video/audio segments to S3 via @ebowwa/object-store
 *
 * Extracted from server.ts for multi-session support.
 * Each session gets its own recorder instance.
 *
 * Preserves per-segment timing metadata (frame count, timestamps) and per-chunk
 * audio parameters (sample rate, channels) so the MP4 export can use the actual
 * framerate and audio sample rate instead of hardcoded guesses.
 */

import type { ObjectStore } from "@ebowwa/object-store";
import { HEADER_SIZE, AUDIO_HEADER_SIZE, parseAudioHeader, parseHeader } from "./protocol.js";
import type { GuidanceEvent } from "./guidance-orchestrator.js";

const SEGMENT_FLUSH_MS = 10_000; // flush buffered data every 10s
const MAX_FAILED_PARTS = 5;     // max retry-buffered segments before dropping oldest
const MAX_MANIFEST_ENTRIES = 1000; // cap manifest growth
const TARGET_SAMPLE_RATE = 48000; // all audio resampled to this rate for uniform concatenation

/**
 * Resample 16-bit LE PCM from fromRate to toRate via linear interpolation.
 * Passthrough when rates match. Handles 8kHz/16kHz/22050Hz/48kHz → 48kHz.
 */
function resamplePcm(pcm: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate || pcm.length < 4) return pcm;
  const srcSamples = pcm.length >> 1; // 2 bytes per sample
  const dstSamples = Math.round(srcSamples * toRate / fromRate);
  const out = new Uint8Array(dstSamples * 2);
  const src = new DataView(pcm.buffer, pcm.byteOffset, pcm.length);
  const dst = new DataView(out.buffer, out.byteOffset, out.length);
  for (let i = 0; i < dstSamples; i++) {
    const srcPos = i * (srcSamples - 1) / (dstSamples - 1 || 1);
    const lo = Math.floor(srcPos);
    const hi = Math.min(lo + 1, srcSamples - 1);
    const frac = srcPos - lo;
    const sLo = src.getInt16(lo * 2, true);
    const sHi = src.getInt16(hi * 2, true);
    dst.setInt16(i * 2, Math.round(sLo + (sHi - sLo) * frac), true);
  }
  return out;
}

export interface BboxAnnotation {
  timestampMs: number;
  sessionId: string;
  objects: Array<{
    y1: number; x1: number; y2: number; x2: number;
    label: string;
    confidence: number;
  }>;
}

interface VideoSegmentMeta {
  index: number;
  frameCount: number;
  firstTimestampMs: number;
  lastTimestampMs: number;
  bytes: number;
}

interface AudioChunkMeta {
  index: number;
  sampleRate: number;
  channels: number;
  totalSamples: number;
  bytes: number;
}

export class SessionRecorder {
  readonly sessionId: string;
  private store: ObjectStore;
  private videoParts: Buffer[] = [];
  private audioParts: Buffer[] = [];
  private failedVideoParts: Buffer[] = []; // retry buffer for failed writes
  private failedAudioParts: Buffer[] = [];
  private segIndex = 0;
  private chunkIndex = 0;
  private resumedFromExisting = false;
  private lastFlush = Date.now();
  private startedAt: number = 0;
  private flushedSegments = 0;
  private bytesToBucket = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private _deviceInfo: Record<string, string | null> = {};
  private _active = false;
  private _accessLevel: string = "link";
  private _acl: Array<{ userId: string; email: string; role: string }> = [];
  private _ownerId: string | undefined;
  private _ownerEmail: string | undefined;
  private _framesRelayed = 0;

  // Guidance event buffer for buffered JSONL write to R2
  private guidanceEventLines: string[] = [];

  // Per-segment timing for accurate framerate in MP4 export
  private segFrameCount = 0;
  private segFirstTimestampMs = 0;
  private segLastTimestampMs = 0;

  // Per-chunk audio metadata for correct sample rate in MP4 export
  private chunkSampleRate = 0;
  private chunkChannels = 0;
  private chunkSampleCount = 0;

  // Accumulated segment/chunk manifests
  private videoManifest: VideoSegmentMeta[] = [];
  private audioManifest: AudioChunkMeta[] = [];

  constructor(sessionId: string, store: ObjectStore) {
    this.sessionId = sessionId;
    this.store = store;
  }

  get deviceInfo(): Record<string, string | null> {
    return this._deviceInfo;
  }

  set deviceInfo(info: Record<string, string | null>) {
    this._deviceInfo = info;
  }

  set accessLevel(level: string) {
    this._accessLevel = level;
  }

  set acl(entries: Array<{ userId: string; email: string; role: string }>) {
    this._acl = entries;
  }

  set ownerId(id: string | undefined) {
    this._ownerId = id;
  }

  set ownerEmail(email: string | undefined) {
    this._ownerEmail = email;
  }

  /** Set frames relayed to live viewers (for streaming vs recording drift tracking) */
  set framesRelayed(count: number) {
    this._framesRelayed = count;
  }

  async start(params: Record<string, string | null>) {
    this._deviceInfo = { ...params };

    // Detect existing recording in R2 and resume from last segment/chunk index
    try {
      const keys = await this.store.list(`sessions/${this.sessionId}/`) as string[];
      const segKeys = keys.filter(k => k.endsWith(".mjpeg")).sort();
      const audioKeys = keys.filter(k => k.endsWith(".pcm")).sort();

      if (segKeys.length > 0) {
        // Resume video segment index
        const lastSeg = segKeys[segKeys.length - 1];
        const segMatch = lastSeg.match(/seg-(\d+)\.mjpeg$/);
        if (segMatch) {
          this.segIndex = parseInt(segMatch[1]);
          this.flushedSegments = this.segIndex;
        }

        // Resume audio chunk index
        if (audioKeys.length > 0) {
          const lastChunk = audioKeys[audioKeys.length - 1];
          const chunkMatch = lastChunk.match(/chunk-(\d+)\.pcm$/);
          if (chunkMatch) {
            this.chunkIndex = parseInt(chunkMatch[1]);
          }
        }

        this.resumedFromExisting = true;
        // Mark as active so meta.json gets updated with correct startedAt
        this._active = true;
        this.startedAt = Date.now();
        this.lastFlush = this.startedAt;
        this.flushTimer = setInterval(() => this.tick(), SEGMENT_FLUSH_MS);

        // Read existing meta for startedAt and bytesToBucket
        const metaBuf = await this.store.get(`sessions/${this.sessionId}/meta.json`);
        if (metaBuf) {
          const existing = JSON.parse(new TextDecoder().decode(metaBuf));
          if (existing.startedAt) this.startedAt = new Date(existing.startedAt).getTime();
          if (existing.recording?.bytesToBucket) this.bytesToBucket = existing.recording.bytesToBucket;
          if (existing.recording?.audioChunks) {
            // Use whichever is larger: detected files or meta record
            this.chunkIndex = Math.max(this.chunkIndex, existing.recording.audioChunks);
          }
        }

        // Load existing manifest so the MP4 export sees the full history
        const manifestBuf = await this.store.get(`sessions/${this.sessionId}/manifest.json`);
        if (manifestBuf) {
          try {
            const existingManifest = JSON.parse(new TextDecoder().decode(manifestBuf));
            if (Array.isArray(existingManifest.videoSegments)) {
              this.videoManifest = existingManifest.videoSegments;
            }
            if (Array.isArray(existingManifest.audioChunks)) {
              this.audioManifest = existingManifest.audioChunks;
            }
          } catch { /* corrupt manifest — start fresh */ }
        }

        console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} resuming from seg ${this.segIndex}, chunk ${this.chunkIndex} (${segKeys.length} video, ${audioKeys.length} audio)`);
      } else {
        console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} created (recording starts on first frame)`);
      }
    } catch {
      console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} created (recording starts on first frame)`);
    }
  }

  /** Activate recording on first video frame — avoids empty shells from audio-only sessions */
  private ensureActive() {
    if (this._active) return;
    this._active = true;
    this.startedAt = Date.now();
    this.lastFlush = this.startedAt;
    this.flushTimer = setInterval(() => this.tick(), SEGMENT_FLUSH_MS);
    this.writeMeta(false);
    console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} recording activated`);
  }

  /** Resume an already-active recording (reconnected publisher) */
  private ensureResumed() {
    if (this._active) return;
    this._active = true;
    this.lastFlush = Date.now();
    this.flushTimer = setInterval(() => this.tick(), SEGMENT_FLUSH_MS);
    this.writeMeta(false);
    console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} recording resumed`);
  }

  appendVideo(frame: Uint8Array) {
    if (this.resumedFromExisting) this.ensureResumed(); else this.ensureActive();
    const jpeg = frame.length > HEADER_SIZE ? frame.subarray(HEADER_SIZE) : frame;
    this.videoParts.push(Buffer.from(jpeg));

    // Extract FRLY timestamp for timing metadata
    this.segFrameCount++;
    const header = parseHeader(frame);
    if (header) {
      if (this.segFrameCount === 1) this.segFirstTimestampMs = header.timestampMs;
      this.segLastTimestampMs = header.timestampMs;
    }
  }

  appendAudio(frame: Uint8Array) {
    // Buffer audio silently until first video frame activates the recorder
    // (unless resuming — audio can flow alongside existing video)
    if (!this._active && !this.resumedFromExisting) return;
    if (this.resumedFromExisting) this.ensureResumed();

    const header = parseAudioHeader(frame);
    const rawPcm = frame.length > AUDIO_HEADER_SIZE ? frame.subarray(AUDIO_HEADER_SIZE) : frame;

    if (header) {
      // Resample to 48kHz so all sources produce uniform PCM for concatenation
      const resampled = resamplePcm(rawPcm, header.sampleRate, TARGET_SAMPLE_RATE);
      this.audioParts.push(Buffer.from(resampled));
      this.chunkSampleRate = TARGET_SAMPLE_RATE;
      this.chunkChannels = header.channels;
      this.chunkSampleCount += Math.floor(resampled.length / (this.chunkChannels * 2));
    } else {
      // No FRAU header — assume already at target rate, push as-is
      this.audioParts.push(Buffer.from(rawPcm));
      this.chunkSampleRate = TARGET_SAMPLE_RATE;
      this.chunkSampleCount += Math.floor(rawPcm.length / 2);
    }
  }

  /** Append a bounding box annotation to the annotations JSONL sidecar file */
  appendBboxAnnotation(annotation: BboxAnnotation): void {
    const line = JSON.stringify(annotation) + "\n";
    const key = `sessions/${this.sessionId}/annotations.jsonl`;
    this.store.put(key, Buffer.from(line)).catch(err =>
      console.error(`[recorder] bbox annotation write failed for ${this.sessionId.slice(0, 8)}:`, err.message)
    );
  }

  /** Append a guidance event to the guidance.jsonl sidecar (buffered, flushed in tick) */
  appendGuidanceEvent(event: GuidanceEvent): void {
    this.guidanceEventLines.push(JSON.stringify(event));
  }

  private tick() {
    this.flushVideo();
    this.flushAudio();
    this.flushGuidanceEvents();
    this.writeManifest();  // persist manifest on every flush so it survives crashes
  }

  private flushVideo() {
    if (this.videoParts.length === 0) return;
    const data = Buffer.concat(this.videoParts);
    const frameCount = this.segFrameCount;
    const firstTs = this.segFirstTimestampMs;
    const lastTs = this.segLastTimestampMs;

    this.videoParts = [];
    this.segFrameCount = 0;
    this.segFirstTimestampMs = 0;
    this.segLastTimestampMs = 0;

    this.segIndex++;
    this.flushedSegments++;
    this.bytesToBucket += data.length;

    this.videoManifest.push({
      index: this.segIndex,
      frameCount,
      firstTimestampMs: firstTs,
      lastTimestampMs: lastTs,
      bytes: data.length,
    });
    if (this.videoManifest.length > MAX_MANIFEST_ENTRIES) {
      this.videoManifest = this.videoManifest.slice(-Math.floor(MAX_MANIFEST_ENTRIES / 2));
    }

    const key = `sessions/${this.sessionId}/video/seg-${this.segIndex.toString().padStart(4, "0")}.mjpeg`;
    this.store.put(key, data).then(() => {
      // On success, flush any previously failed parts
      if (this.failedVideoParts.length > 0) {
        const retry = Buffer.concat(this.failedVideoParts);
        this.failedVideoParts = [];
        this.store.put(`${key}.retry`, retry).catch(err => {
          console.error(`[recorder] retry video write failed:`, err.message);
          this.failedVideoParts.push(retry);
        });
      }
    }).catch(err => {
      console.error(`[recorder] video write failed, buffering for retry:`, err.message);
      this.failedVideoParts.push(data);
      if (this.failedVideoParts.length > MAX_FAILED_PARTS) {
        console.warn(`[recorder] Dropping oldest failed video part (${this.failedVideoParts[0].length} bytes)`);
        this.failedVideoParts.shift();
      }
    });
  }

  private flushAudio() {
    if (this.audioParts.length === 0) return;
    const data = Buffer.concat(this.audioParts);
    const sampleRate = this.chunkSampleRate || TARGET_SAMPLE_RATE;
    const channels = this.chunkChannels;
    const totalSamples = this.chunkSampleCount;

    this.audioParts = [];
    this.chunkSampleRate = 0;
    this.chunkChannels = 0;
    this.chunkSampleCount = 0;

    this.chunkIndex++;
    this.bytesToBucket += data.length;

    this.audioManifest.push({
      index: this.chunkIndex,
      sampleRate,
      channels,
      totalSamples,
      bytes: data.length,
    });
    if (this.audioManifest.length > MAX_MANIFEST_ENTRIES) {
      this.audioManifest = this.audioManifest.slice(-Math.floor(MAX_MANIFEST_ENTRIES / 2));
    }

    const key = `sessions/${this.sessionId}/audio/chunk-${this.chunkIndex.toString().padStart(4, "0")}.pcm`;
    this.store.put(key, data).catch(err => {
      console.error(`[recorder] audio write failed, buffering for retry:`, err.message);
      this.failedAudioParts.push(data);
      if (this.failedAudioParts.length > MAX_FAILED_PARTS) {
        console.warn(`[recorder] Dropping oldest failed audio part (${this.failedAudioParts[0].length} bytes)`);
        this.failedAudioParts.shift();
      }
    });
  }

  /** Flush buffered guidance events to guidance.jsonl sidecar (read-merge-write) */
  private flushGuidanceEvents(): void {
    if (this.guidanceEventLines.length === 0) return;
    const data = this.guidanceEventLines.join("\n") + "\n";
    this.guidanceEventLines = [];
    const key = `sessions/${this.sessionId}/guidance.jsonl`;
    // Append to existing file by reading first
    this.store.get(key).then(existing => {
      const prev = existing ? new TextDecoder().decode(existing) : "";
      this.store.put(key, Buffer.from(prev + data)).catch(err =>
        console.error(`[recorder] guidance flush failed for ${this.sessionId.slice(0, 8)}:`, err.message)
      );
    }).catch(() => {
      // File doesn't exist yet, just write
      this.store.put(key, Buffer.from(data)).catch(err =>
        console.error(`[recorder] guidance flush failed for ${this.sessionId.slice(0, 8)}:`, err.message)
      );
    });
  }

  async finish() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this._active) {
      this.flushVideo();
      this.flushAudio();
      this.flushGuidanceEvents();
      this.writeManifest();
      this.writeMeta(true);
      console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} finished: ${this.flushedSegments} video segs, ${this.chunkIndex} audio chunks, ${(this.bytesToBucket / 1048576).toFixed(2)} MB`);
    } else {
      console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} finished (never activated — no frames received)`);
    }
  }

  /** Write per-segment/chunk manifest for the MP4 export to use */
  private writeManifest() {
    // Compute actual framerate from video timestamps
    let actualFps = 15; // fallback
    const totalFrames = this.videoManifest.reduce((s, m) => s + m.frameCount, 0);
    const firstTs = this.videoManifest.length > 0 ? this.videoManifest[0].firstTimestampMs : 0;
    const lastTs = this.videoManifest.length > 0 ? this.videoManifest[this.videoManifest.length - 1].lastTimestampMs : 0;
    if (totalFrames > 1 && lastTs > firstTs) {
      actualFps = Math.round(totalFrames / ((lastTs - firstTs) / 1000) * 10) / 10;
    }

    // Determine dominant audio sample rate across all chunks
    let audioSampleRate = 48000; // fallback
    if (this.audioManifest.length > 0) {
      // Use the most common sample rate
      const rateCounts = new Map<number, number>();
      for (const c of this.audioManifest) {
        if (c.sampleRate > 0) {
          rateCounts.set(c.sampleRate, (rateCounts.get(c.sampleRate) || 0) + 1);
        }
      }
      let maxCount = 0;
      for (const [rate, count] of rateCounts) {
        if (count > maxCount) { maxCount = count; audioSampleRate = rate; }
      }
    }

    const manifest = {
      sessionId: this.sessionId,
      actualFps,
      audioSampleRate,
      totalFrames,
      videoSegments: this.videoManifest,
      audioChunks: this.audioManifest,
    };

    this.store.put(`sessions/${this.sessionId}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2))).catch(err =>
      console.error(`[recorder] manifest write failed for ${this.sessionId.slice(0, 8)}:`, err.message)
    );
  }

  private writeMeta(final: boolean) {
    // Compute content durations from manifest (not wall clock)
    let videoDurationMs = 0;
    let audioDurationMs = 0;
    const totalFrames = this.videoManifest.reduce((s, m) => s + m.frameCount, 0);

    if (this.videoManifest.length > 0) {
      const firstTs = this.videoManifest[0].firstTimestampMs;
      const lastTs = this.videoManifest[this.videoManifest.length - 1].lastTimestampMs;
      if (lastTs > firstTs) videoDurationMs = lastTs - firstTs;
    }

    for (const chunk of this.audioManifest) {
      if (chunk.sampleRate > 0 && chunk.totalSamples > 0) {
        audioDurationMs += Math.round((chunk.totalSamples / chunk.sampleRate) * 1000);
      }
    }

    const driftMs = audioDurationMs > 0 && videoDurationMs > 0
      ? audioDurationMs - videoDurationMs
      : 0;

    const meta = {
      sessionId: this.sessionId,
      startedAt: new Date(this.startedAt).toISOString(),
      ...(final ? { finishedAt: new Date().toISOString(), durationMs: Date.now() - this.startedAt } : {}),
      device: this._deviceInfo,
      accessLevel: this._accessLevel,
      acl: this._acl,
      ownerId: this._ownerId,
      ownerEmail: this._ownerEmail,
      recording: {
        segmentsWritten: this.flushedSegments,
        audioChunks: this.chunkIndex,
        bytesToBucket: this.bytesToBucket,
        totalFrames,
        videoDurationMs,
        audioDurationMs,
        driftMs,
        framesRelayed: this._framesRelayed,
      },
    };
    this.store.put(`sessions/${this.sessionId}/meta.json`, Buffer.from(JSON.stringify(meta, null, 2))).catch(err =>
      console.error(`[recorder] meta write failed for ${this.sessionId.slice(0, 8)}:`, err.message)
    );
  }

  getStats() {
    return {
      active: this._active,
      sessionId: this.sessionId,
      segmentsWritten: this.flushedSegments,
      audioChunks: this.chunkIndex,
      bytesToBucket: this.bytesToBucket,
    };
  }
}
