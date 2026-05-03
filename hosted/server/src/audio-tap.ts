/**
 * AudioTapBus — pluggable audio tap system for the relay server
 *
 * Mirrors the iOS AudioEventBus pattern: pub/sub with AsyncIterable streams.
 * Subscribers (taps) receive parsed AudioFrame objects with FRAU header decoded.
 *
 * Uses a push queue per subscriber (not ReadableStream) for reliable delivery.
 *
 * Usage:
 *   const bus = new AudioTapBus();
 *   const { id, stream } = bus.subscribe();
 *   bus.publish(frauFrameBytes);  // dispatches to all taps
 *   bus.unsubscribe(id);
 *
 * Taps can be: recording, viewer fanout, transcription, VU meter, etc.
 */

import { parseAudioHeader } from "./protocol.js";

export interface AudioFrame {
  sessionId?: string;
  codecType: number;
  sequence: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  timestampMs: number;
  /** Raw payload bytes — PCM i16 LE when !isOpus, Opus-encoded when isOpus */
  pcm: Uint8Array;
  isOpus?: boolean;
}

interface TapSubscriber {
  id: string;
  queue: AudioFrame[];
  waiting: ((frame: AudioFrame | null) => void) | null;
  closed: boolean;
}

const MAX_TAP_QUEUE_SIZE = 1000; // Drop oldest frames when queue exceeds this

export class AudioTapBus {
  private taps = new Map<string, TapSubscriber>();
  private callbacks = new Map<string, (frame: AudioFrame) => void>();

  /**
   * Subscribe with a callback — synchronous, no async iteration.
   * Best for WebSocket dispatch, logging, monitoring.
   * Returns unsubscribe function.
   */
  onFrame(callback: (frame: AudioFrame) => void): () => void {
    const id = crypto.randomUUID();
    this.callbacks.set(id, callback);
    return () => { this.callbacks.delete(id); };
  }

  subscribe(): { id: string; stream: AsyncIterable<AudioFrame> } {
    const id = crypto.randomUUID();
    const tap: TapSubscriber = { id, queue: [], waiting: null, closed: false };
    this.taps.set(id, tap);

    const stream: AsyncIterable<AudioFrame> & AsyncIterator<AudioFrame> = {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        // If items queued, return immediately
        if (tap.queue.length > 0) {
          const value = tap.queue.shift()!;
          return { value, done: false };
        }
        // If closed, signal end
        if (tap.closed) {
          return { value: undefined as any, done: true as const };
        }
        // Wait for next frame
        return new Promise<{ value: AudioFrame; done: false } | { value: undefined; done: true }>((resolve) => {
          tap.waiting = (frame) => {
            if (frame === null) {
              resolve({ value: undefined as any, done: true as const });
            } else {
              resolve({ value: frame, done: false });
            }
          };
        });
      },
      async return() {
        return { value: undefined as any, done: true as const };
      },
    };

    return { id, stream };
  }

  unsubscribe(id: string) {
    const tap = this.taps.get(id);
    if (tap) {
      tap.closed = true;
      if (tap.waiting) {
        tap.waiting(null);
        tap.waiting = null;
      }
      this.taps.delete(id);
    }
  }

  publish(rawFrame: Uint8Array, sessionId?: string) {
    const audioFrame = this.parseFRAU(rawFrame);
    if (!audioFrame) return; // not a valid FRAU frame, skip
    audioFrame.sessionId = sessionId;

    // Dispatch to async iterable subscribers
    for (const tap of this.taps.values()) {
      if (tap.closed) continue;
      if (tap.waiting) {
        const resolve = tap.waiting;
        tap.waiting = null;
        resolve(audioFrame);
      } else {
        if (tap.queue.length >= MAX_TAP_QUEUE_SIZE) {
          // Drop oldest frame to prevent unbounded growth
          tap.queue.shift();
        }
        tap.queue.push(audioFrame);
      }
    }

    // Dispatch to callback subscribers (synchronous)
    for (const cb of this.callbacks.values()) {
      try { cb(audioFrame); } catch {}
    }
  }

  tapCount(): number {
    return this.taps.size + this.callbacks.size;
  }

  private parseFRAU(buf: Uint8Array): AudioFrame | null {
    const hdr = parseAudioHeader(buf);
    if (!hdr) return null;
    return {
      sessionId: undefined,
      codecType: hdr.codecType,
      sequence: hdr.sequence,
      sampleRate: hdr.sampleRate,
      channels: hdr.channels,
      bitsPerSample: hdr.bitsPerSample,
      timestampMs: hdr.timestampMs,
      pcm: hdr.payload,
      isOpus: hdr.isOpus,
    };
  }
}
