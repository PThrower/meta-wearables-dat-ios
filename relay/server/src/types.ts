/**
 * Shared types for caringmind-frame-relay
 *
 * Extracted from server.ts for multi-session support.
 */

import type { ServerWebSocket } from "bun";

// --- WebSocket Data Type (Bun.serve generic) ---

export interface WsData {
  role: string;
  clientIp: string;
  sessionId: string;    // session this connection belongs to
  viewerId?: string;
}

// --- Quality Presets ---

export type QualityPreset = "high" | "medium" | "low" | "mini";

export const QUALITY_PRESETS: Record<QualityPreset, { maxFps: number; minIntervalMs: number; label: string }> = {
  high:   { maxFps: 30, minIntervalMs: 33,  label: "High (30 FPS)" },
  medium: { maxFps: 15, minIntervalMs: 67,  label: "Medium (15 FPS)" },
  low:    { maxFps: 8,  minIntervalMs: 125, label: "Low (8 FPS)" },
  mini:   { maxFps: 4,  minIntervalMs: 250, label: "Mini (4 FPS)" },
};

export const DEFAULT_QUALITY: QualityPreset = "high";

// --- Frame Timing ---

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

// --- Publisher ---

export interface Publisher {
  ws: ServerWebSocket<WsData>;
  id: string;
  connected: number;
  frameCount: number;
  totalBytes: number;
  audioCount: number;
  audioBytes: number;
  timing: FrameTiming;
  lastHeader: { width: number; height: number; quality: number } | null;
  clientIp: string;
  deviceId: string | null;
  deviceName: string | null;
  wearableId: string | null;
  wearableType: string | null;
  deviceModel: string | null;
  systemVersion: string | null;
}

// --- Viewer ---

export interface Viewer {
  ws: ServerWebSocket<WsData>;
  connected: number;
  frameCount: number;
  totalBytes: number;
  timing: FrameTiming;
  quality: QualityPreset;
  lastSentAt: number;
  throttledCount: number;
  clientIp: string;
}

// --- Session (multi-session support) ---

export interface SessionMetadata {
  deviceName: string | null;
  deviceModel: string | null;
  deviceId: string | null;
  systemVersion: string | null;
  wearableType: string | null;
  resolution: { width: number; height: number } | null;
}

export interface Session {
  id: string;
  publisher: Publisher | null;
  viewers: Map<string, Viewer>;
  recorder: import("./session-recorder.js").SessionRecorder | null;
  wasmThrottle: any;            // FrameRelay instance, lazy-initialized
  createdAt: number;
  lastActivityAt: number;
  metadata: SessionMetadata;
}
