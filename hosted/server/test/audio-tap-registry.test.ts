/**
 * Integration test: AudioTapBus wired into SessionRegistry
 *
 * When a publisher sends audio, the bus should dispatch to all taps.
 * The recorder and fanout remain as implicit taps via the bus.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { SessionRegistry } from "../src/session-registry.js";
import { AudioTapBus } from "../src/audio-tap.js";
import type { AudioFrame } from "../src/audio-tap.js";
import { MockObjectStore, buildFRAUFrame, buildFRLYFrame } from "./helpers.js";

describe("AudioTapBus + SessionRegistry integration", () => {
  let store: MockObjectStore;
  let registry: SessionRegistry;
  let audioBus: AudioTapBus;

  beforeEach(() => {
    store = new MockObjectStore();
    registry = new SessionRegistry(store as any);
    audioBus = new AudioTapBus();
  });

  test("custom tap receives audio frames published via bus", async () => {
    const { stream } = audioBus.subscribe();

    // Publish 3 audio frames through the bus
    for (let i = 0; i < 3; i++) {
      audioBus.publish(buildFRAUFrame({
        sequence: i,
        sampleRate: 48000,
        channels: 1,
        pcmPayload: new Uint8Array(1024),
      }));
    }

    // Read all 3 frames from the custom tap
    const frames: AudioFrame[] = [];
    const reader = stream[Symbol.asyncIterator]();
    for (let i = 0; i < 3; i++) {
      const { value, done } = await Promise.race([
        reader.next(),
        new Promise<IteratorResult<AudioFrame>>((resolve) =>
          setTimeout(() => resolve({ value: undefined as any, done: true }), 2000)
        ),
      ]);
      if (!done) frames.push(value);
    }

    expect(frames.length).toBe(3);
    expect(frames[0].sequence).toBe(0);
    expect(frames[1].sequence).toBe(1);
    expect(frames[2].sequence).toBe(2);
  });

  test("recorder still works when audio goes through bus", async () => {
    // Simulate: audio goes through bus AND to recorder (like server.ts would do)
    const sessionId = "integ-rec-" + crypto.randomUUID().slice(0, 8);
    const session = registry.getOrCreate(sessionId);

    // Start recorder manually
    const { SessionRecorder } = await import("../src/session-recorder.js");
    session.recorder = new SessionRecorder(sessionId, store as any);
    session.recorder.start({});

    // Activate recorder with a video frame (recorder only activates on video)
    session.recorder.appendVideo(buildFRLYFrame({}));

    // Publish audio through bus + forward to recorder
    for (let i = 0; i < 5; i++) {
      const frame = buildFRAUFrame({
        sampleRate: 8000,
        channels: 1,
        pcmPayload: new Uint8Array(512),
      });
      audioBus.publish(frame);       // taps get parsed frame
      session.recorder.appendAudio(frame); // recorder gets raw FRAU
    }

    await session.recorder.finish();

    // Verify recorder wrote audio chunks
    const audioKeys = await store.list(`sessions/${sessionId}/audio/`);
    const pcmKeys = audioKeys.filter(k => k.endsWith(".pcm"));
    expect(pcmKeys.length).toBeGreaterThanOrEqual(1);

    // Verify manifest has 8000 Hz sample rate
    const manifestBuf = await store.get(`sessions/${sessionId}/manifest.json`);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));
    expect(manifest.audioSampleRate).toBe(8000);
  });

  test("multiple custom taps all receive same frames", async () => {
    const tap1 = audioBus.subscribe();
    const tap2 = audioBus.subscribe();
    const tap3 = audioBus.subscribe();

    audioBus.publish(buildFRAUFrame({
      sequence: 1,
      sampleRate: 16000,
      channels: 1,
      pcmPayload: new Uint8Array(256),
    }));

    const readFirst = async (stream: AsyncIterable<AudioFrame>): Promise<AudioFrame> => {
      for await (const f of stream) return f;
      throw new Error("closed");
    };

    const [f1, f2, f3] = await Promise.all([
      Promise.race([readFirst(tap1.stream), new Promise<AudioFrame>((_, r) => setTimeout(() => r(new Error("t1 timeout")), 2000))]),
      Promise.race([readFirst(tap2.stream), new Promise<AudioFrame>((_, r) => setTimeout(() => r(new Error("t2 timeout")), 2000))]),
      Promise.race([readFirst(tap3.stream), new Promise<AudioFrame>((_, r) => setTimeout(() => r(new Error("t3 timeout")), 2000))]),
    ]);

    expect(f1.sampleRate).toBe(16000);
    expect(f2.sampleRate).toBe(16000);
    expect(f3.sampleRate).toBe(16000);
  });

  test("tap can be added/removed during active session", async () => {
    const permanentTap = audioBus.subscribe();

    // First frame — only permanent tap
    audioBus.publish(buildFRAUFrame({ sequence: 0, sampleRate: 48000, pcmPayload: new Uint8Array(64) }));

    // Add temporary tap
    const tempTap = audioBus.subscribe();
    expect(audioBus.tapCount()).toBe(2);

    // Second frame — both taps
    audioBus.publish(buildFRAUFrame({ sequence: 1, sampleRate: 48000, pcmPayload: new Uint8Array(64) }));

    // Remove temp tap
    audioBus.unsubscribe(tempTap.id);
    expect(audioBus.tapCount()).toBe(1);

    // Third frame — only permanent tap
    audioBus.publish(buildFRAUFrame({ sequence: 2, sampleRate: 48000, pcmPayload: new Uint8Array(64) }));

    // Read all from permanent tap — should get all 3
    const reader = permanentTap.stream[Symbol.asyncIterator]();
    let count = 0;
    for (let i = 0; i < 3; i++) {
      const r = await Promise.race([
        reader.next(),
        new Promise<IteratorResult<AudioFrame>>((resolve) =>
          setTimeout(() => resolve({ value: undefined as any, done: true }), 2000)
        ),
      ]);
      if (!r.done) count++;
    }
    expect(count).toBe(3);
  });
});
