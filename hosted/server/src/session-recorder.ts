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
import { HEADER_SIZE, parseAudioHeader, parseHeader } from "./protocol.js";

const SEGMENT_FLUSH_MS = 10_000; // flush buffered data every 10s

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

  start(params: Record<string, string | null>) {
    this._deviceInfo = { ...params };
    console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} created (recording starts on first frame)`);
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

  appendVideo(frame: Uint8Array) {
    this.ensureActive();
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
    if (!this._active) return;
    const pcm = frame.length > 29 ? frame.subarray(29) : frame;
    this.audioParts.push(Buffer.from(pcm));

    // Extract FRAU header metadata for sample rate / channels
    const header = parseAudioHeader(frame);
    if (header) {
      this.chunkSampleRate = header.sampleRate;
      this.chunkChannels = header.channels;
      // PCM 16-bit LE: 2 bytes per sample per channel
      this.chunkSampleCount += Math.floor(pcm.length / (this.chunkChannels * 2));
    }
  }

  private tick() {
    this.flushVideo();
    this.flushAudio();
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
    });
  }

  private flushAudio() {
    if (this.audioParts.length === 0) return;
    const data = Buffer.concat(this.audioParts);
    const sampleRate = this.chunkSampleRate;
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

    const key = `sessions/${this.sessionId}/audio/chunk-${this.chunkIndex.toString().padStart(4, "0")}.pcm`;
    this.store.put(key, data).catch(err => {
      console.error(`[recorder] audio write failed, buffering for retry:`, err.message);
      this.failedAudioParts.push(data);
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
