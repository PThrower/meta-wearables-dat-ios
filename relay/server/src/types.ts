/**
 * Shared types for caringmind-frame-relay
 *
 * Server-specific types stay here. Protocol types imported from @ebowwa/relay-protocol.
 */

import type { ServerWebSocket } from "bun";
import type { FrameTiming as FrameTimingType, QualityPreset as QualityPresetType } from "@ebowwa/relay-protocol";
import { QUALITY_PRESETS, DEFAULT_QUALITY } from "@ebowwa/relay-protocol";

// --- Protocol types from shared package ---

export type FrameTiming = FrameTimingType;
export type QualityPreset = QualityPresetType;
export { QUALITY_PRESETS, DEFAULT_QUALITY };

// --- WebSocket Data Type (Bun.serve generic) ---

export interface WsData {
  role: string;
  clientIp: string;
  sessionId: string;    // session this connection belongs to
  viewerId?: string;
  userId?: string;      // Google sub (user ID) from verified token
  email?: string;       // Google email from verified token
  unsub?: () => void;   // Audio tap unsubscribe callback
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
  audioTaps: Map<number, { count: number; bytes: number; sampleRate: number; lastAt: number }>;
  timing: FrameTiming;
  lastHeader: { width: number; height: number; quality: number } | null;
  clientIp: string;
  deviceId: string | null;
  deviceName: string | null;
  wearableId: string | null;
  wearableType: string | null;
  deviceModel: string | null;
  systemVersion: string | null;
  appVersion: string | null;
  buildNumber: string | null;
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
  gitCommit: string | null;
  buildVersion: string | null;
}

// --- Session (multi-session support) ---

export interface SessionMetadata {
  deviceName: string | null;
  deviceModel: string | null;
  deviceId: string | null;
  systemVersion: string | null;
  wearableType: string | null;
  resolution: { width: number; height: number } | null;
  ownerEmail: string | null;
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
  ownerId?: string;             // Google sub (user ID) of session creator
  ownerEmail?: string;          // Google email of session creator
  isPublic: boolean;            // if false, only owner can view
}
