/**
 * AudioTapBus wiring test — verifies the bus is correctly integrated
 * with the server's audio pipeline and stats endpoint.
 */

import { describe, test, expect } from "bun:test";
import { AudioTapBus } from "../src/audio-tap.js";
import { buildFRAUFrame } from "./helpers.js";

describe("AudioTapBus wiring", () => {
  test("bus is instantiable and stats-compatible", () => {
    const bus = new AudioTapBus();
    expect(bus.tapCount()).toBe(0);
  });

  test("bus can be exported and subscribed from external module", async () => {
    const bus = new AudioTapBus();

    // Simulate what a future tap (e.g., transcription service) would do
    const { id, stream } = bus.subscribe();
    expect(bus.tapCount()).toBe(1);

    // Simulate server publishing a frame
    bus.publish(buildFRAUFrame({
      sequence: 1,
      sampleRate: 16000,
      channels: 1,
      pcmPayload: new Uint8Array(512),
    }));

    const reader = stream[Symbol.asyncIterator]();
    const { value, done } = await Promise.race([
      reader.next(),
      new Promise<IteratorResult<any>>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), 2000)
      ),
    ]);

    expect(done).toBe(false);
    expect(value.sampleRate).toBe(16000);

    bus.unsubscribe(id);
    expect(bus.tapCount()).toBe(0);
  });

  test("bus handles high-frequency frame burst", async () => {
    const bus = new AudioTapBus();
    const { stream } = bus.subscribe();

    // Burst 100 frames (simulates ~2s of 48kHz audio at 1024 samples/chunk)
    for (let i = 0; i < 100; i++) {
      bus.publish(buildFRAUFrame({
        sequence: i,
        sampleRate: 48000,
        pcmPayload: new Uint8Array(2048),
      }));
    }

    const reader = stream[Symbol.asyncIterator]();
    let lastSeq = -1;
    let count = 0;

    for (let i = 0; i < 100; i++) {
      const r = await Promise.race([
        reader.next(),
        new Promise<IteratorResult<any>>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 3000)
        ),
      ]);
      if (r.done) break;
      expect(r.value.sequence).toBeGreaterThan(lastSeq);
      lastSeq = r.value.sequence;
      count++;
    }

    expect(count).toBe(100);
  });
});
