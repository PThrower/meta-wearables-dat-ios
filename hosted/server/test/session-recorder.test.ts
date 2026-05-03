/**
 * SessionRecorder tests — recording, manifest generation, A/V sync metadata
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { SessionRecorder } from "../src/session-recorder.js";
import { MockObjectStore, buildFRLYFrame, buildFRAUFrame } from "./helpers.js";

describe("SessionRecorder", () => {
  let store: MockObjectStore;
  let recorder: SessionRecorder;

  beforeEach(() => {
    store = new MockObjectStore();
    recorder = new SessionRecorder("test-session-001", store as any);
    recorder.start({});
  });

  // --- Video recording ---

  describe("appendVideo", () => {
    test("stores JPEG payload stripped of FRLY header", async () => {
      const frame = buildFRLYFrame({ sequence: 1 });
      recorder.appendVideo(frame);
      await recorder.finish();

      const keys = await store.list("sessions/test-session-001/video/");
      expect(keys.length).toBeGreaterThanOrEqual(1);

      const seg = await store.get(keys[0]);
      expect(seg).not.toBeNull();
      // Should start with JPEG SOI marker, not FRLY magic
      expect(seg![0]).toBe(0xFF);
      expect(seg![1]).toBe(0xD8);
    });

    test("stores raw JPEG when frame has no FRLY header", async () => {
      const rawJpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
      recorder.appendVideo(rawJpeg);
      await recorder.finish();

      const keys = await store.list("sessions/test-session-001/video/");
      expect(keys.length).toBeGreaterThanOrEqual(1);
      const seg = await store.get(keys[0]);
      expect(seg![0]).toBe(0xFF);
      expect(seg![1]).toBe(0xD8);
    });
  });

  // --- Audio recording ---

  describe("appendAudio", () => {
    test("stores PCM payload stripped of FRAU header (resampled to 48kHz)", async () => {
      const pcmData = new Uint8Array(2048); // 1024 samples at 8kHz
      const frame = buildFRAUFrame({
        sampleRate: 8000,
        channels: 1,
        pcmPayload: pcmData,
      });
      recorder.appendVideo(buildFRLYFrame({})); // activate recorder
      recorder.appendAudio(frame);
      await recorder.finish();

      const keys = await store.list("sessions/test-session-001/audio/");
      expect(keys.length).toBeGreaterThanOrEqual(1);

      const chunk = await store.get(keys[0]);
      expect(chunk).not.toBeNull();
      // 1024 samples at 8kHz resampled to 48kHz: 1024 * 6 = 6144 samples * 2 = 12288 bytes
      expect(chunk!.length).toBe(12288);
      // Should NOT start with FRAU magic
      expect(chunk![0]).not.toBe(0x46);
    });

    test("stores raw PCM when frame has no FRAU header", async () => {
      const rawPcm = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      recorder.appendVideo(buildFRLYFrame({})); // activate recorder
      recorder.appendAudio(rawPcm);
      await recorder.finish();

      const keys = await store.list("sessions/test-session-001/audio/");
      expect(keys.length).toBeGreaterThanOrEqual(1);
      const chunk = await store.get(keys[0]);
      expect(chunk!.length).toBe(4);
    });
  });

  // --- Manifest generation (A/V sync fix) ---

  describe("manifest.json", () => {
    test("computes actualFps from frame timestamps", async () => {
      const baseTs = 1000_000;
      // Simulate ~23 fps: 23 frames over 1 second
      for (let i = 0; i < 23; i++) {
        const frame = buildFRLYFrame({
          sequence: i,
          timestampMs: baseTs + i * 43, // ~43ms apart = ~23.2 fps
        });
        recorder.appendVideo(frame);
      }
      await recorder.finish();

      const manifestBuf = await store.get("sessions/test-session-001/manifest.json");
      expect(manifestBuf).not.toBeNull();
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));

      // 23 frames / ~0.964s = ~23.9 fps, rounded to 1 decimal
      expect(manifest.actualFps).toBeGreaterThan(20);
      expect(manifest.actualFps).toBeLessThan(25);
      expect(manifest.totalFrames).toBe(23);
    });

    test("captures sample rate from FRAU header (always 48000 after resampling)", async () => {
      // All frames in one flush cycle → single chunk with resampled rate
      recorder.appendVideo(buildFRLYFrame({})); // activate recorder
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 8000,
        channels: 1,
        pcmPayload: new Uint8Array(512),
      }));
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 8000,
        channels: 1,
        pcmPayload: new Uint8Array(512),
      }));
      await recorder.finish();

      const manifestBuf = await store.get("sessions/test-session-001/manifest.json");
      expect(manifestBuf).not.toBeNull();
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));
      // Resampled to 48kHz regardless of source rate
      expect(manifest.audioSampleRate).toBe(48000);
    });

    test("defaults to 48000 when no audio chunks", async () => {
      recorder.appendVideo(buildFRLYFrame({}));
      await recorder.finish();

      const manifestBuf = await store.get("sessions/test-session-001/manifest.json");
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));
      expect(manifest.audioSampleRate).toBe(48000);
    });

    test("defaults to 15 fps for single frame", async () => {
      recorder.appendVideo(buildFRLYFrame({ timestampMs: 1000 }));
      await recorder.finish();

      const manifestBuf = await store.get("sessions/test-session-001/manifest.json");
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));
      expect(manifest.actualFps).toBe(15); // fallback
    });

    test("records video segment metadata with timestamps", async () => {
      recorder.appendVideo(buildFRLYFrame({ sequence: 1, timestampMs: 1000 }));
      recorder.appendVideo(buildFRLYFrame({ sequence: 2, timestampMs: 1043 }));
      recorder.appendVideo(buildFRLYFrame({ sequence: 3, timestampMs: 1086 }));
      await recorder.finish();

      const manifestBuf = await store.get("sessions/test-session-001/manifest.json");
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));
      expect(manifest.videoSegments.length).toBeGreaterThanOrEqual(1);

      const seg = manifest.videoSegments[0];
      expect(seg.frameCount).toBe(3);
      expect(seg.firstTimestampMs).toBe(1000);
      expect(seg.lastTimestampMs).toBe(1086);
      expect(seg.bytes).toBeGreaterThan(0);
    });

    test("records audio chunk metadata with resampled sample rate", async () => {
      recorder.appendVideo(buildFRLYFrame({})); // activate recorder
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 16000,
        channels: 1,
        pcmPayload: new Uint8Array(512),
      }));
      await recorder.finish();

      const manifestBuf = await store.get("sessions/test-session-001/manifest.json");
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));
      expect(manifest.audioChunks.length).toBeGreaterThanOrEqual(1);

      const chunk = manifest.audioChunks[0];
      expect(chunk.sampleRate).toBe(48000); // resampled from 16kHz → 48kHz
      expect(chunk.channels).toBe(1);
    });
  });

  // --- meta.json ---

  describe("meta.json", () => {
    test("writes final meta with duration", async () => {
      recorder.appendVideo(buildFRLYFrame({}));
      await recorder.finish();

      const metaBuf = await store.get("sessions/test-session-001/meta.json");
      expect(metaBuf).not.toBeNull();
      const meta = JSON.parse(new TextDecoder().decode(metaBuf!));
      expect(meta.sessionId).toBe("test-session-001");
      expect(meta.finishedAt).toBeDefined();
      expect(meta.durationMs).toBeGreaterThanOrEqual(0);
      expect(meta.recording.segmentsWritten).toBeGreaterThanOrEqual(1);
    });

    test("writes initial meta on activation", async () => {
      recorder.appendVideo(buildFRLYFrame({}));

      const metaBuf = await store.get("sessions/test-session-001/meta.json");
      expect(metaBuf).not.toBeNull();
      const meta = JSON.parse(new TextDecoder().decode(metaBuf!));
      expect(meta.startedAt).toBeDefined();
      expect(meta.finishedAt).toBeUndefined(); // not finished yet
    });
  });

  // --- getStats ---

  describe("getStats", () => {
    test("returns inactive stats before frames", () => {
      const stats = recorder.getStats();
      expect(stats.active).toBe(false);
      expect(stats.sessionId).toBe("test-session-001");
    });

    test("returns active stats after first frame", () => {
      recorder.appendVideo(buildFRLYFrame({}));
      const stats = recorder.getStats();
      expect(stats.active).toBe(true);
    });
  });

  // --- Full pipeline: 8kHz HFP audio + 23fps video ---

  describe("HFP glasses scenario", () => {
    test("correctly records 8kHz/16bit HFP audio with 23fps video", async () => {
      const baseTs = 5_000_000;

      // Simulate 3 seconds of video at ~23 fps
      for (let i = 0; i < 69; i++) {
        recorder.appendVideo(buildFRLYFrame({
          sequence: i,
          timestampMs: baseTs + i * 43,
        }));
      }

      // Simulate 3 seconds of 8kHz HFP audio
      // At 8kHz, 1024 samples = 128ms per chunk, ~23 chunks for 3s
      for (let i = 0; i < 23; i++) {
        recorder.appendAudio(buildFRAUFrame({
          sampleRate: 8000,
          channels: 1,
          pcmPayload: new Uint8Array(2048), // 1024 samples * 2 bytes
          timestampMs: baseTs + i * 128,
        }));
      }

      await recorder.finish();

      const manifestBuf = await store.get("sessions/test-session-001/manifest.json");
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));

      // FPS should be ~23, not the old hardcoded 15
      expect(manifest.actualFps).toBeGreaterThan(20);
      expect(manifest.actualFps).toBeLessThan(25);

      // Audio resampled to 48kHz regardless of source rate
      expect(manifest.audioSampleRate).toBe(48000);

      expect(manifest.totalFrames).toBe(69);
    });

    test("correctly records 48kHz built-in mic audio", async () => {
      // Simulate 1 second of video
      for (let i = 0; i < 24; i++) {
        recorder.appendVideo(buildFRLYFrame({
          sequence: i,
          timestampMs: 10_000 + i * 42,
        }));
      }

      // Simulate 1 second of 48kHz built-in mic
      for (let i = 0; i < 47; i++) {
        recorder.appendAudio(buildFRAUFrame({
          sampleRate: 48000,
          channels: 1,
          pcmPayload: new Uint8Array(2048),
        }));
      }

      await recorder.finish();

      const manifestBuf = await store.get("sessions/test-session-001/manifest.json");
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));

      expect(manifest.actualFps).toBeGreaterThan(20);
      expect(manifest.audioSampleRate).toBe(48000);
    });
  });

  // --- Resampling tests ---

  describe("PCM resampling", () => {
    test("resamples 8kHz to 48kHz (6x expansion)", async () => {
      recorder.appendVideo(buildFRLYFrame({}));
      // 512 bytes of PCM at 8kHz = 256 samples
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 8000,
        channels: 1,
        pcmPayload: new Uint8Array(512),
      }));
      await recorder.finish();

      const keys = await store.list("sessions/test-session-001/audio/");
      const chunk = await store.get(keys[0]);
      // 256 samples * 6 = 1536 samples * 2 bytes = 3072 bytes
      expect(chunk!.length).toBe(3072);

      const manifestBuf = await store.get("sessions/test-session-001/manifest.json");
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));
      expect(manifest.audioSampleRate).toBe(48000);
    });

    test("resamples 16kHz to 48kHz (3x expansion)", async () => {
      recorder.appendVideo(buildFRLYFrame({}));
      // 512 bytes of PCM at 16kHz = 256 samples
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 16000,
        channels: 1,
        pcmPayload: new Uint8Array(512),
      }));
      await recorder.finish();

      const keys = await store.list("sessions/test-session-001/audio/");
      const chunk = await store.get(keys[0]);
      // 256 samples * 3 = 768 samples * 2 bytes = 1536 bytes
      expect(chunk!.length).toBe(1536);
    });

    test("passes through 48kHz unchanged", async () => {
      recorder.appendVideo(buildFRLYFrame({}));
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 48000,
        channels: 1,
        pcmPayload: new Uint8Array(512),
      }));
      await recorder.finish();

      const keys = await store.list("sessions/test-session-001/audio/");
      const chunk = await store.get(keys[0]);
      expect(chunk!.length).toBe(512); // passthrough, no expansion
    });

    test("mixed-rate session always records 48000", async () => {
      recorder.appendVideo(buildFRLYFrame({}));

      // Phone mic at 48kHz
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 48000,
        channels: 1,
        pcmPayload: new Uint8Array(512),
      }));
      // Glasses HFP at 8kHz
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 8000,
        channels: 1,
        pcmPayload: new Uint8Array(512),
      }));
      // TTS at 22050Hz
      recorder.appendAudio(buildFRAUFrame({
        sampleRate: 22050,
        channels: 1,
        pcmPayload: new Uint8Array(512),
      }));

      await recorder.finish();

      const manifestBuf = await store.get("sessions/test-session-001/manifest.json");
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf!));
      expect(manifest.audioSampleRate).toBe(48000);

      // All chunks should have sampleRate 48000
      for (const chunk of manifest.audioChunks) {
        expect(chunk.sampleRate).toBe(48000);
      }
    });
  });
});
