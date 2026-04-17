/**
 * Protocol tests — FRLY/FRAU parsing, timing, formatting
 */

import { describe, test, expect } from "bun:test";
import {
  HEADER_SIZE,
  AUDIO_HEADER_SIZE,
  FRLY_MAGIC,
  FRAU_MAGIC,
  freshTiming,
  updateTiming,
  parseHeader,
  isVideoFrame,
  isAudioFrame,
  formatTiming,
} from "../src/protocol.js";
import { buildFRLYFrame, buildFRAUFrame } from "./helpers.js";

// --- Constants ---

describe("protocol constants", () => {
  test("HEADER_SIZE is 36 (FRLY v1)", () => {
    expect(HEADER_SIZE).toBe(36);
  });

  test("AUDIO_HEADER_SIZE is 36 (FRAU v1)", () => {
    expect(AUDIO_HEADER_SIZE).toBe(36);
  });

  test("FRLY magic bytes spell FRLY", () => {
    expect(FRLY_MAGIC).toEqual([0x46, 0x52, 0x4c, 0x59]);
  });

  test("FRAU magic bytes spell FRAU", () => {
    expect(FRAU_MAGIC).toEqual([0x46, 0x52, 0x41, 0x55]);
  });
});

// --- Frame detection ---

describe("isVideoFrame", () => {
  test("detects FRLY frame", () => {
    const frame = buildFRLYFrame({});
    expect(isVideoFrame(frame)).toBe(true);
  });

  test("rejects FRAU frame", () => {
    const frame = buildFRAUFrame({});
    expect(isVideoFrame(frame)).toBe(false);
  });

  test("rejects too-short buffer", () => {
    expect(isVideoFrame(new Uint8Array(3))).toBe(false);
  });

  test("rejects empty buffer", () => {
    expect(isVideoFrame(new Uint8Array(0))).toBe(false);
  });
});

describe("isAudioFrame", () => {
  test("detects FRAU frame", () => {
    const frame = buildFRAUFrame({});
    expect(isAudioFrame(frame)).toBe(true);
  });

  test("rejects FRLY frame", () => {
    const frame = buildFRLYFrame({});
    expect(isAudioFrame(frame)).toBe(false);
  });

  test("rejects too-short buffer", () => {
    expect(isAudioFrame(new Uint8Array(3))).toBe(false);
  });
});

// --- Header parsing ---

describe("parseHeader", () => {
  test("extracts all FRLY header fields", () => {
    const frame = buildFRLYFrame({
      sequence: 42,
      width: 1280,
      height: 720,
      quality: 90,
      timestampMs: 1700000000123,
    });

    const header = parseHeader(frame);
    expect(header).not.toBeNull();
    expect(header!.sequence).toBe(42);
    expect(header!.width).toBe(1280);
    expect(header!.height).toBe(720);
    expect(header!.quality).toBe(90);
    expect(header!.timestampMs).toBe(1700000000123);
  });

  test("returns null for buffer too short", () => {
    expect(parseHeader(new Uint8Array(10))).toBeNull();
  });

  test("returns null for wrong magic bytes", () => {
    const buf = new Uint8Array(HEADER_SIZE);
    buf[0] = 0x00; buf[1] = 0x00; buf[2] = 0x00; buf[3] = 0x00;
    expect(parseHeader(buf)).toBeNull();
  });

  test("returns null for FRAU frame (wrong magic for video parser)", () => {
    const frame = buildFRAUFrame({});
    expect(parseHeader(frame)).toBeNull();
  });

  test("round-trips sequence number at max safe value", () => {
    const frame = buildFRLYFrame({ sequence: Number.MAX_SAFE_INTEGER });
    const header = parseHeader(frame);
    expect(header!.sequence).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// --- Timing ---

describe("freshTiming", () => {
  test("returns initial state", () => {
    const t = freshTiming();
    expect(t.lastSequence).toBe(0);
    expect(t.lastTimestampMs).toBe(0);
    expect(t.lastReceivedAt).toBe(0);
    expect(t.fps).toBe(0);
    expect(t.jitterMs).toBe(0);
    expect(t.minIntervalMs).toBe(Infinity);
    expect(t.maxIntervalMs).toBe(0);
    expect(t.droppedFrames).toBe(0);
  });
});

describe("updateTiming", () => {
  test("updates sequence and timestamp on first call", () => {
    const t = freshTiming();
    updateTiming(t, 1, 1000);
    expect(t.lastSequence).toBe(1);
    expect(t.lastTimestampMs).toBe(1000);
    expect(t.lastReceivedAt).toBeGreaterThan(0);
    expect(t.fps).toBe(0); // no fps until second frame
  });

  test("updates sequence on subsequent frames", () => {
    const t = freshTiming();
    updateTiming(t, 1, 1000);
    updateTiming(t, 2, 2000);
    expect(t.lastSequence).toBe(2);
    expect(t.lastTimestampMs).toBe(2000);
    // Note: FPS uses Date.now() intervals, may be 0 in same-tick tests
  });

  test("detects dropped frames from sequence gaps", () => {
    const t = freshTiming();
    updateTiming(t, 1, 1000);
    updateTiming(t, 5, 2000); // gap: 2,3,4 missing
    expect(t.droppedFrames).toBe(3);
  });

  test("does not count as dropped when sequential", () => {
    const t = freshTiming();
    updateTiming(t, 1, 1000);
    updateTiming(t, 2, 2000);
    expect(t.droppedFrames).toBe(0);
  });
});

describe("formatTiming", () => {
  test("rounds fps and jitter to 1 decimal", () => {
    const t = freshTiming();
    t.fps = 23.456;
    t.jitterMs = 12.789;
    t.minIntervalMs = 40.123;
    t.maxIntervalMs = 50.987;
    const formatted = formatTiming(t);
    expect(formatted.fps).toBe(23.5);
    expect(formatted.jitterMs).toBe(12.8);
    expect(formatted.minIntervalMs).toBe(40);
    expect(formatted.maxIntervalMs).toBe(51);
  });

  test("converts Infinity minIntervalMs to 0", () => {
    const t = freshTiming();
    const formatted = formatTiming(t);
    expect(formatted.minIntervalMs).toBe(0);
  });
});
