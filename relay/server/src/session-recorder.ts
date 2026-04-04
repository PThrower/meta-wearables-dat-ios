/**
 * SessionRecorder — records video/audio segments to S3 via @ebowwa/object-store
 *
 * Extracted from server.ts for multi-session support.
 * Each session gets its own recorder instance.
 */

import type { ObjectStore } from "@ebowwa/object-store";
import { HEADER_SIZE } from "./protocol.js";

const SEGMENT_FLUSH_MS = 10_000; // flush buffered data every 10s

export class SessionRecorder {
  readonly sessionId: string;
  private store: ObjectStore;
  private videoParts: Buffer[] = [];
  private audioParts: Buffer[] = [];
  private segIndex = 0;
  private chunkIndex = 0;
  private lastFlush = Date.now();
  private startedAt: number = 0;
  private flushedSegments = 0;
  private bytesToBucket = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private _deviceInfo: Record<string, string | null> = {};

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

  start(params: Record<string, string | null>) {
    this.startedAt = Date.now();
    this.lastFlush = this.startedAt;
    this._deviceInfo = { ...params };
    this.writeMeta(false);
    this.flushTimer = setInterval(() => this.tick(), SEGMENT_FLUSH_MS);
    console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} started`);
  }

  appendVideo(frame: Uint8Array) {
    const jpeg = frame.length > HEADER_SIZE ? frame.subarray(HEADER_SIZE) : frame;
    this.videoParts.push(Buffer.from(jpeg));
  }

  appendAudio(frame: Uint8Array) {
    const pcm = frame.length > HEADER_SIZE ? frame.subarray(HEADER_SIZE) : frame;
    this.audioParts.push(Buffer.from(pcm));
  }

  private tick() {
    this.flushVideo();
    this.flushAudio();
  }

  private flushVideo() {
    if (this.videoParts.length === 0) return;
    const data = Buffer.concat(this.videoParts);
    this.videoParts = [];
    this.segIndex++;
    this.flushedSegments++;
    this.bytesToBucket += data.length;
    const key = `sessions/${this.sessionId}/video/seg-${this.segIndex.toString().padStart(4, "0")}.mjpeg`;
    this.store.put(key, data).catch(err =>
      console.error(`[recorder] video write failed:`, err.message)
    );
  }

  private flushAudio() {
    if (this.audioParts.length === 0) return;
    const data = Buffer.concat(this.audioParts);
    this.audioParts = [];
    this.chunkIndex++;
    this.bytesToBucket += data.length;
    const key = `sessions/${this.sessionId}/audio/chunk-${this.chunkIndex.toString().padStart(4, "0")}.pcm`;
    this.store.put(key, data).catch(err =>
      console.error(`[recorder] audio write failed:`, err.message)
    );
  }

  async finish() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushVideo();
    this.flushAudio();
    this.writeMeta(true);
    console.log(`[recorder] Session ${this.sessionId.slice(0, 8)} finished: ${this.flushedSegments} video segs, ${this.chunkIndex} audio chunks, ${(this.bytesToBucket / 1048576).toFixed(2)} MB`);
  }

  private writeMeta(final: boolean) {
    const meta = {
      sessionId: this.sessionId,
      startedAt: new Date(this.startedAt).toISOString(),
      ...(final ? { finishedAt: new Date().toISOString(), durationMs: Date.now() - this.startedAt } : {}),
      device: this._deviceInfo,
      recording: {
        segmentsWritten: this.flushedSegments,
        audioChunks: this.chunkIndex,
        bytesToBucket: this.bytesToBucket,
      },
    };
    this.store.put(`sessions/${this.sessionId}/meta.json`, Buffer.from(JSON.stringify(meta, null, 2))).catch(err =>
      console.error(`[recorder] meta write failed:`, err.message)
    );
  }

  getStats() {
    return {
      active: true,
      sessionId: this.sessionId,
      segmentsWritten: this.flushedSegments,
      audioChunks: this.chunkIndex,
      bytesToBucket: this.bytesToBucket,
    };
  }
}
