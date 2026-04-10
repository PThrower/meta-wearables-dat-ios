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

import { AUDIO_HEADER_SIZE } from "./protocol.js";

export interface AudioFrame {
  codecType: number;
  sequence: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  timestampMs: number;
  pcm: Uint8Array;
}

interface TapSubscriber {
  id: string;
  queue: AudioFrame[];
  waiting: ((frame: AudioFrame | null) => void) | null;
  closed: boolean;
}

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

  publish(rawFrame: Uint8Array) {
    const audioFrame = this.parseFRAU(rawFrame);
    if (!audioFrame) return; // not a valid FRAU frame, skip

    // Dispatch to async iterable subscribers
    for (const tap of this.taps.values()) {
      if (tap.closed) continue;
      if (tap.waiting) {
        const resolve = tap.waiting;
        tap.waiting = null;
        resolve(audioFrame);
      } else {
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
    if (buf.length < AUDIO_HEADER_SIZE) return null;
    // Verify FRAU magic
    if (buf[0] !== 0x46 || buf[1] !== 0x52 || buf[2] !== 0x41 || buf[3] !== 0x55) return null;

    const view = new DataView(buf.buffer, buf.byteOffset);
    return {
      codecType: buf[4],
      sequence: Number(view.getBigUint64(5, true)),
      sampleRate: view.getUint32(13, true),
      channels: view.getUint16(17, true),
      bitsPerSample: view.getUint16(19, true),
      timestampMs: Number(view.getBigUint64(21, true)),
      pcm: buf.subarray(AUDIO_HEADER_SIZE),
    };
  }
}
