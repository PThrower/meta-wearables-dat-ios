/**
 * SessionExport tests — JPEG extraction, thumbnail caching, export metadata
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  getSessionExportMeta,
  getSessionThumbnail,
  getGalleryData,
} from "../src/session-export.js";
import { MockObjectStore, buildFRLYFrame } from "./helpers.js";

// Helper: build a valid MJPEG buffer with N frames
function buildMjpeg(frameCount: number): Buffer {
  const frames: Buffer[] = [];
  for (let i = 0; i < frameCount; i++) {
    frames.push(Buffer.from([
      0xFF, 0xD8,                                 // SOI
      0xFF, 0xE0, 0x00, 0x02,                     // APP0
      ...Buffer.from(`frame${i}`),                 // payload
      0xFF, 0xD9,                                  // EOI
    ]));
  }
  return Buffer.concat(frames);
}

describe("getSessionExportMeta", () => {
  let store: MockObjectStore;

  beforeEach(() => {
    store = new MockObjectStore();
  });

  test("returns segment and audio counts", async () => {
    await store.put("sessions/s1/video/seg-0001.mjpeg", buildMjpeg(5));
    await store.put("sessions/s1/video/seg-0002.mjpeg", buildMjpeg(3));
    await store.put("sessions/s1/audio/chunk-0001.pcm", Buffer.alloc(1024));
    await store.put("sessions/s1/meta.json", Buffer.from(JSON.stringify({
      sessionId: "s1",
      recording: { segmentsWritten: 2, audioChunks: 1 },
    })));

    const meta = await getSessionExportMeta("s1", store as any);
    expect(meta.videoSegments).toBe(2);
    expect(meta.audioChunks).toBe(1);
    expect(meta.hasAudio).toBe(true);
    expect(meta.meta.sessionId).toBe("s1");
  });

  test("returns hasAudio false when no audio chunks", async () => {
    await store.put("sessions/s2/video/seg-0001.mjpeg", buildMjpeg(5));

    const meta = await getSessionExportMeta("s2", store as any);
    expect(meta.hasAudio).toBe(false);
    expect(meta.videoSegments).toBe(1);
  });
});

describe("getSessionThumbnail", () => {
  let store: MockObjectStore;

  beforeEach(() => {
    store = new MockObjectStore();
  });

  test("extracts first JPEG from MJPEG segment", async () => {
    const mjpeg = buildMjpeg(3);
    await store.put("sessions/s1/video/seg-0001.mjpeg", mjpeg);

    const thumb = await getSessionThumbnail("s1", store as any);
    expect(thumb).not.toBeNull();
    expect(thumb![0]).toBe(0xFF);
    expect(thumb![1]).toBe(0xD8);
    // Should end with EOI
    expect(thumb![thumb!.length - 2]).toBe(0xFF);
    expect(thumb![thumb!.length - 1]).toBe(0xD9);
  });

  test("returns null when no video segments exist", async () => {
    const thumb = await getSessionThumbnail("nonexistent", store as any);
    expect(thumb).toBeNull();
  });

  test("caches thumbnail to R2", async () => {
    await store.put("sessions/s1/video/seg-0001.mjpeg", buildMjpeg(2));

    await getSessionThumbnail("s1", store as any);

    // Second call should use cache
    const cached = await store.get("sessions/s1/thumb.jpg");
    expect(cached).not.toBeNull();
  });

  test("returns cached thumbnail on subsequent calls", async () => {
    const mjpeg = buildMjpeg(1);
    await store.put("sessions/s1/video/seg-0001.mjpeg", mjpeg);

    // First call populates cache
    const thumb1 = await getSessionThumbnail("s1", store as any);
    // Delete video to prove second call uses cache
    await store.delete("sessions/s1/video/seg-0001.mjpeg");

    const thumb2 = await getSessionThumbnail("s1", store as any);
    expect(thumb2).not.toBeNull();
    expect(thumb2!.length).toBe(thumb1!.length);
  });
});

describe("getGalleryData", () => {
  let store: MockObjectStore;

  beforeEach(() => {
    store = new MockObjectStore();
  });

  test("lists sessions sorted by most recent first", async () => {
    await store.put("sessions/old/meta.json", Buffer.from(JSON.stringify({
      startedAt: "2026-04-01T10:00:00.000Z",
      accessLevel: "public",
      recording: { segmentsWritten: 5 },
    })));
    await store.put("sessions/new/meta.json", Buffer.from(JSON.stringify({
      startedAt: "2026-04-09T15:00:00.000Z",
      accessLevel: "public",
      recording: { segmentsWritten: 3 },
    })));

    const gallery = await getGalleryData(store as any, new Set());
    expect(gallery.length).toBe(2);
    expect(gallery[0].sessionId).toBe("new");
    expect(gallery[1].sessionId).toBe("old");
  });

  test("marks live sessions", async () => {
    await store.put("sessions/live-one/meta.json", Buffer.from(JSON.stringify({
      startedAt: "2026-04-09T10:00:00.000Z",
      accessLevel: "public",
    })));

    const gallery = await getGalleryData(store as any, new Set(["live-one"]));
    expect(gallery[0].live).toBe(true);
  });

  test("detects cached exports", async () => {
    await store.put("sessions/s1/meta.json", Buffer.from(JSON.stringify({
      startedAt: "2026-04-09T10:00:00.000Z",
      accessLevel: "public",
    })));
    await store.put("sessions/s1/export.mp4", Buffer.alloc(1024));

    const gallery = await getGalleryData(store as any, new Set());
    expect(gallery[0].exportCached).toBe(true);
  });

  test("returns empty array when no sessions", async () => {
    const gallery = await getGalleryData(store as any, new Set());
    expect(gallery).toEqual([]);
  });
});
