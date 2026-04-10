/**
 * AudioTapBus tests — TDD for pluggable audio tap system
 *
 * Contract:
 *   - subscribe() returns { id, stream } where stream is AsyncIterable<AudioFrame>
 *   - publish(frame) dispatches to all active subscribers
 *   - unsubscribe(id) removes subscriber, closes its stream
 *   - AudioFrame = { codecType, sequence, sampleRate, channels, bitsPerSample, timestampMs, pcm }
 *   - publish() accepts raw FRAU bytes and parses the header for the tap
 *
 * Current hardcoded taps (fanout + recorder) become the first two tap consumers.
 * Future taps: transcription, VU meter, audio analysis, forwarding.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { buildFRAUFrame } from "./helpers.js";

// Import will fail until we implement AudioTapBus — that's the point (RED phase)
import { AudioTapBus } from "../src/audio-tap.js";
import type { AudioFrame } from "../src/audio-tap.js";

describe("AudioTapBus", () => {
  let bus: AudioTapBus;

  beforeEach(() => {
    bus = new AudioTapBus();
  });

  // --- Subscribe / Publish ---

  describe("subscribe + publish", () => {
    test("delivers parsed AudioFrame to single subscriber", async () => {
      const { id, stream } = bus.subscribe();

      const pcmData = new Uint8Array(512);
      const frauFrame = buildFRAUFrame({
        codecType: 0,
        sequence: 42,
        sampleRate: 8000,
        channels: 1,
        bitsPerSample: 16,
        timestampMs: 1700000000123,
        pcmPayload: pcmData,
      });

      bus.publish(frauFrame);

      // Read from async iterable with timeout
      const reader = stream[Symbol.asyncIterator]();
      const result = await Promise.race([
        reader.next(),
        new Promise<IteratorResult<AudioFrame>>((resolve) =>
          setTimeout(() => resolve({ value: undefined as any, done: true }), 2000)
        ),
      ]);

      expect(result.done).toBe(false);
      expect(result.value.codecType).toBe(0);
      expect(result.value.sequence).toBe(42);
      expect(result.value.sampleRate).toBe(8000);
      expect(result.value.channels).toBe(1);
      expect(result.value.bitsPerSample).toBe(16);
      expect(result.value.timestampMs).toBe(1700000000123);
      expect(result.value.pcm.length).toBe(512);
    });

    test("delivers to multiple subscribers", async () => {
      const sub1 = bus.subscribe();
      const sub2 = bus.subscribe();

      const frauFrame = buildFRAUFrame({
        sampleRate: 48000,
        channels: 1,
        pcmPayload: new Uint8Array(1024),
      });

      bus.publish(frauFrame);

      const readFrame = async (stream: AsyncIterable<AudioFrame>): Promise<AudioFrame> => {
        for await (const frame of stream) return frame;
        throw new Error("stream closed");
      };

      const [f1, f2] = await Promise.all([
        Promise.race([
          readFrame(sub1.stream),
          new Promise<AudioFrame>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
        ]),
        Promise.race([
          readFrame(sub2.stream),
          new Promise<AudioFrame>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
        ]),
      ]);

      expect(f1.sampleRate).toBe(48000);
      expect(f2.sampleRate).toBe(48000);
    });
  });

  // --- Unsubscribe ---

  describe("unsubscribe", () => {
    test("removes subscriber — no more frames after unsubscribe", async () => {
      const { id, stream } = bus.subscribe();

      // Publish one frame, read it
      bus.publish(buildFRAUFrame({ sampleRate: 8000, pcmPayload: new Uint8Array(128) }));
      const reader = stream[Symbol.asyncIterator]();
      const first = await reader.next();
      expect(first.done).toBe(false);

      // Unsubscribe
      bus.unsubscribe(id);

      // Publish another frame — should NOT reach this subscriber
      bus.publish(buildFRAUFrame({ sampleRate: 48000, pcmPayload: new Uint8Array(128) }));

      // The stream should eventually end or not deliver
      const second = await Promise.race([
        reader.next(),
        new Promise<IteratorResult<AudioFrame>>((resolve) =>
          setTimeout(() => resolve({ value: undefined as any, done: true }), 500)
        ),
      ]);
      // Either done=true (stream closed) or the frame didn't arrive (timeout → done=true)
      expect(second.done).toBe(true);
    });

    test("does not affect other subscribers", async () => {
      const sub1 = bus.subscribe();
      const sub2 = bus.subscribe();

      bus.unsubscribe(sub1.id);

      // sub2 should still work
      bus.publish(buildFRAUFrame({ sampleRate: 16000, pcmPayload: new Uint8Array(64) }));

      const readFrame = async (stream: AsyncIterable<AudioFrame>): Promise<AudioFrame> => {
        for await (const frame of stream) return frame;
        throw new Error("stream closed");
      };

      const frame = await Promise.race([
        readFrame(sub2.stream),
        new Promise<AudioFrame>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]);
      expect(frame.sampleRate).toBe(16000);
    });
  });

  // --- Active tap count ---

  describe("tapCount", () => {
    test("tracks active subscriber count", () => {
      expect(bus.tapCount()).toBe(0);

      const s1 = bus.subscribe();
      expect(bus.tapCount()).toBe(1);

      const s2 = bus.subscribe();
      expect(bus.tapCount()).toBe(2);

      bus.unsubscribe(s1.id);
      expect(bus.tapCount()).toBe(1);

      bus.unsubscribe(s2.id);
      expect(bus.tapCount()).toBe(0);
    });
  });

  // --- Frame parsing edge cases ---

  describe("frame parsing", () => {
    test("handles non-FRAU frame gracefully (no magic)", () => {
      const garbage = new Uint8Array(100);
      // Should not throw — just ignore
      expect(() => bus.publish(garbage)).not.toThrow();
    });

    test("handles FRAU frame with empty PCM payload", async () => {
      const { stream } = bus.subscribe();
      const frauFrame = buildFRAUFrame({
        sampleRate: 48000,
        pcmPayload: new Uint8Array(0),
      });

      bus.publish(frauFrame);

      const reader = stream[Symbol.asyncIterator]();
      const result = await Promise.race([
        reader.next(),
        new Promise<IteratorResult<AudioFrame>>((resolve) =>
          setTimeout(() => resolve({ value: undefined as any, done: true }), 2000)
        ),
      ]);

      expect(result.done).toBe(false);
      expect(result.value.pcm.length).toBe(0);
    });

    test("preserves 8kHz HFP sample rate through tap", async () => {
      const { stream } = bus.subscribe();
      bus.publish(buildFRAUFrame({
        sampleRate: 8000,
        channels: 1,
        pcmPayload: new Uint8Array(2048),
      }));

      const reader = stream[Symbol.asyncIterator]();
      const { value } = await reader.next();
      expect(value.sampleRate).toBe(8000);
    });

    test("preserves 16kHz wideband HFP sample rate", async () => {
      const { stream } = bus.subscribe();
      bus.publish(buildFRAUFrame({
        sampleRate: 16000,
        channels: 1,
        pcmPayload: new Uint8Array(2048),
      }));

      const reader = stream[Symbol.asyncIterator]();
      const { value } = await reader.next();
      expect(value.sampleRate).toBe(16000);
    });

    test("preserves 48kHz built-in mic sample rate", async () => {
      const { stream } = bus.subscribe();
      bus.publish(buildFRAUFrame({
        sampleRate: 48000,
        channels: 1,
        pcmPayload: new Uint8Array(4096),
      }));

      const reader = stream[Symbol.asyncIterator]();
      const { value } = await reader.next();
      expect(value.sampleRate).toBe(48000);
    });
  });

  // --- Sequential frame delivery ---

  describe("ordering", () => {
    test("delivers frames in order", async () => {
      const { stream } = bus.subscribe();

      for (let i = 0; i < 10; i++) {
        bus.publish(buildFRAUFrame({
          sequence: i,
          sampleRate: 48000,
          pcmPayload: new Uint8Array(64),
        }));
      }

      const reader = stream[Symbol.asyncIterator]();
      for (let i = 0; i < 10; i++) {
        const { value } = await reader.next();
        expect(value.sequence).toBe(i);
      }
    });
  });
});
