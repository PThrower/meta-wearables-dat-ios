/**
 * Wire protocol constants and pure functions for caringmind-frame-relay
 *
 * FRLY: video frames  [4B "FRLY"][8B sequence][4B width][4B height][1B quality][8B timestamp_ms][JPEG payload]
 * FRAU: audio frames  [4B "FRAU"][...audio header...][PCM payload]
 */

import type { FrameTiming } from "./types.js";

// --- Header sizes ---

export const HEADER_SIZE = 29;       // FRLY video header
export const AUDIO_HEADER_SIZE = 29; // FRAU audio header

// --- Magic bytes ---

export const FRLY_MAGIC = [0x46, 0x52, 0x4c, 0x59]; // "FRLY"
export const FRAU_MAGIC = [0x46, 0x52, 0x41, 0x55]; // "FRAU"

// --- Timing ---

export function freshTiming(): FrameTiming {
  return {
    lastSequence: 0,
    lastTimestampMs: 0,
    lastReceivedAt: 0,
    jitterMs: 0,
    fps: 0,
    minIntervalMs: Infinity,
    maxIntervalMs: 0,
    droppedFrames: 0,
  };
}

export function updateTiming(t: FrameTiming, sequence: number, timestampMs: number): FrameTiming {
  const now = Date.now();
  if (t.lastReceivedAt > 0) {
    const interval = now - t.lastReceivedAt;
    // Skip same-tick frames (interval=0) to avoid Infinity FPS poisoning the EMA
    if (interval > 0) {
      const instantFps = 1000 / interval;
      t.fps = t.fps === 0 ? instantFps : t.fps * 0.9 + instantFps * 0.1;
      if (interval < t.minIntervalMs) t.minIntervalMs = interval;
      if (interval > t.maxIntervalMs) t.maxIntervalMs = interval;
    }
    // Jitter = EMA of absolute deviation from mean interval
    if (t.minIntervalMs < Infinity && t.maxIntervalMs > 0) {
      const avg = (t.minIntervalMs + t.maxIntervalMs) / 2;
      const jitter = Math.abs(interval - avg);
      t.jitterMs = t.jitterMs === 0 ? jitter : t.jitterMs * 0.9 + jitter * 0.1;
    }

    // Detect dropped frames (sequence gaps)
    const expectedSeq = t.lastSequence + 1;
    if (sequence > expectedSeq) {
      t.droppedFrames += sequence - expectedSeq;
    }
  }
  t.lastSequence = sequence;
  t.lastTimestampMs = timestampMs;
  t.lastReceivedAt = now;
  return t;
}

// --- Frame parsing ---

export function parseHeader(buf: Uint8Array) {
  if (buf.length < HEADER_SIZE) return null;
  if (buf[0] !== 0x46 || buf[1] !== 0x52 || buf[2] !== 0x4c || buf[3] !== 0x59) return null;
  const view = new DataView(buf.buffer, buf.byteOffset);
  return {
    sequence: Number(view.getBigUint64(4, true)),
    width: view.getUint32(12, true),
    height: view.getUint32(16, true),
    quality: buf[20],
    timestampMs: Number(view.getBigUint64(21, true)),
  };
}

export function isAudioFrame(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x46 && buf[1] === 0x52 && buf[2] === 0x41 && buf[3] === 0x55;
}

export function isVideoFrame(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x46 && buf[1] === 0x52 && buf[2] === 0x4c && buf[3] === 0x59;
}

// --- Formatting ---

export function formatTiming(t: FrameTiming) {
  return {
    fps: Math.round(t.fps * 10) / 10,
    jitterMs: Math.round(t.jitterMs * 10) / 10,
    minIntervalMs: t.minIntervalMs === Infinity ? 0 : Math.round(t.minIntervalMs),
    maxIntervalMs: Math.round(t.maxIntervalMs),
    droppedFrames: t.droppedFrames,
  };
}
