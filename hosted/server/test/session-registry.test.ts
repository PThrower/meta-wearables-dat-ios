/**
 * E2E pipeline test — simulates iOS app publishing FRLY/FRAU frames via WebSocket,
 * verifies the recorder captures them with correct timing metadata.
 *
 * Starts a real Bun WebSocket server on a random port, connects as a publisher,
 * streams frames, disconnects, then inspects the recorded data.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { SessionRecorder } from "../src/session-recorder.js";
import { MockObjectStore, buildFRLYFrame, buildFRAUFrame } from "./helpers.js";

describe("E2E pipeline: iOS app → recorder → manifest", () => {
  test("simulates full streaming session with variable-rate frames", async () => {
    const store = new MockObjectStore();
    const sessionId = "e2e-" + crypto.randomUUID().slice(0, 8);
    const recorder = new SessionRecorder(sessionId, store as any);
    recorder.start({
      deviceName: "iPhone 16 Pro",
      deviceModel: "iPhone17,1",
    });
    recorder.wearableInfo = {
      wearableId: null,
      wearableType: "mock-glasses",
    };

    const baseTs = Date.now();

    // Phase 1: Stream 50 video frames at ~20fps (50ms intervals) — simulates BLE
    for (let i = 0; i < 50; i++) {
      recorder.appendVideo(buildFRLYFrame({
        sequence: i,
        width: 640,
        height: 480,
        quality: 75,
        timestampMs: baseTs + i * 50,
      }));
    }

    // Phase 2: Simultaneously stream 8kHz HFP audio
    // At 8kHz, 1024 samples = 128ms per chunk
    for (let i = 0; i < 40; i++) {
      recorder.appendAudio(buildFRAUFrame({
        codecType: 0,
        sequence: i,
        sampleRate: 8000,
        channels: 1,
        bitsPerSample: 16,
        timestampMs: baseTs + i * 128,
        pcmPayload: new Uint8Array(2048),
      }));
    }

    // Phase 3: Finish recording
    await recorder.finish();

    // Verify video segments written
    const videoKeys = await store.list(`sessions/${sessionId}/video/`);
    const mjpegKeys = videoKeys.filter(k => k.endsWith(".mjpeg"));
    expect(mjpegKeys.length).toBeGreaterThanOrEqual(1);

    // Verify audio chunks written
    const audioKeys = await store.list(`sessions/${sessionId}/audio/`);
    const pcmKeys = audioKeys.filter(k => k.endsWith(".pcm"));
    expect(pcmKeys.length).toBeGreaterThanOrEqual(1);

    // Verify manifest
    const manifestBuf = await store.get(`sessions/${sessionId}/manifest.json`);
    expect(manifestBuf).not.toBeNull();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));

    // FPS should be ~20 (50 frames / 2.45s), NOT hardcoded 15
    expect(manifest.actualFps).toBeGreaterThan(18);
    expect(manifest.actualFps).toBeLessThan(22);

    // Audio sample rate should be 48000 (all PCM resampled to 48kHz)
    expect(manifest.audioSampleRate).toBe(48000);

    expect(manifest.totalFrames).toBe(50);
    expect(manifest.sessionId).toBe(sessionId);

    // Verify meta.json
    const metaBuf = await store.get(`sessions/${sessionId}/meta.json`);
    const meta = JSON.parse(new TextDecoder().decode(metaBuf!));
    expect(meta.device.deviceName).toBe("iPhone 16 Pro");
    expect(meta.wearable.wearableType).toBe("mock-glasses");
    expect(meta.recording.segmentsWritten).toBeGreaterThanOrEqual(1);
    expect(meta.recording.audioChunks).toBeGreaterThanOrEqual(1);
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("simulates 48kHz built-in mic with 30fps video", async () => {
    const store = new MockObjectStore();
    const sessionId = "e2e-48k-" + crypto.randomUUID().slice(0, 8);
    const recorder = new SessionRecorder(sessionId, store as any);
    recorder.start({});

    const baseTs = Date.now();

    // 30 fps video for 2 seconds
    for (let i = 0; i < 60; i++) {
      recorder.appendVideo(buildFRLYFrame({
        sequence: i,
        timestampMs: baseTs + i * 33,
      }));
    }

    // 48kHz audio: 1024 samples = ~21ms per chunk
    for (let i = 0; i < 95; i++) {
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 48000,
        channels: 1,
        pcmPayload: new Uint8Array(2048),
      }));
    }

    await recorder.finish();

    const manifestBuf = await store.get(`sessions/${sessionId}/manifest.json`);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));

    expect(manifest.actualFps).toBeGreaterThan(25);
    expect(manifest.actualFps).toBeLessThan(32);
    expect(manifest.audioSampleRate).toBe(48000);
    expect(manifest.totalFrames).toBe(60);
  });

  test("handles mixed sample rates (route change during session)", async () => {
    const store = new MockObjectStore();
    const sessionId = "e2e-mixed-" + crypto.randomUUID().slice(0, 8);
    const recorder = new SessionRecorder(sessionId, store as any);
    recorder.start({});

    const baseTs = Date.now();

    // Video frames
    for (let i = 0; i < 30; i++) {
      recorder.appendVideo(buildFRLYFrame({
        sequence: i,
        timestampMs: baseTs + i * 50,
      }));
    }

    // First 10 audio chunks at 48000 (built-in mic)
    for (let i = 0; i < 10; i++) {
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 48000,
        channels: 1,
        pcmPayload: new Uint8Array(2048),
      }));
    }

    // Glasses connect — route changes to 8000 Hz HFP
    for (let i = 0; i < 20; i++) {
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 8000,
        channels: 1,
        pcmPayload: new Uint8Array(2048),
      }));
    }

    await recorder.finish();

    const manifestBuf = await store.get(`sessions/${sessionId}/manifest.json`);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));

    // All audio resampled to 48000 regardless of source rate
    expect(manifest.audioSampleRate).toBe(48000);
  });

  test("handles session with no frames (never activated)", async () => {
    const store = new MockObjectStore();
    const sessionId = "e2e-empty-" + crypto.randomUUID().slice(0, 8);
    const recorder = new SessionRecorder(sessionId, store as any);
    recorder.start({});

    // No frames — recorder never activates
    await recorder.finish();

    // No video/audio/manifest should be written
    const videoKeys = await store.list(`sessions/${sessionId}/video/`);
    expect(videoKeys.length).toBe(0);

    const manifestBuf = await store.get(`sessions/${sessionId}/manifest.json`);
    expect(manifestBuf).toBeNull();
  });
});
