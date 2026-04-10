/**
 * Shared types and timing functions for frame relay
 */

export interface FrameTiming {
  lastSequence: number;
  lastTimestampMs: number;
  lastReceivedAt: number;
  jitterMs: number;
  fps: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  droppedFrames: number;
}

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

export function formatTiming(t: FrameTiming) {
  return {
    fps: Math.round(t.fps * 10) / 10,
    jitterMs: Math.round(t.jitterMs * 10) / 10,
    minIntervalMs: t.minIntervalMs === Infinity ? 0 : Math.round(t.minIntervalMs),
    maxIntervalMs: Math.round(t.maxIntervalMs),
    droppedFrames: t.droppedFrames,
  };
}
