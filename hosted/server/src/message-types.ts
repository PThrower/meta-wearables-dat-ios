/**
 * message-types.ts
 *
 * Typed interfaces for JSON messages relayed between iOS publisher and
 * viewers through the server. Used by server dispatch handlers to avoid
 * inline `as` casts and provide type-safe field access.
 */

// --- STT Result ---

export interface SttResultMessage {
  type: "stt_result";
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
  error?: string;
  alternatives?: Array<{ text: string; confidence: number }>;
  words?: Array<{ word: string; startTimeMs: number; endTimeMs: number; confidence: number }>;
}

// --- VAD Result ---

export interface VadResultMessage {
  type: "vad_result";
  eventType: string; // "speech_start" | "speech_end" | "speech_active" | "error"
  isSpeech: boolean;
  energyDb?: number;
  durationMs?: number;
  confidence?: number;
  error?: string;
}

// --- Vision Result ---

export interface VisionResultMessage {
  type: "vision_result";
  nodeId: string;
  nodeType: string;
  results: unknown[];
  error?: string;
}

// --- Sensor Result ---

export interface SensorResultMessage {
  type: "sensor_result";
  nodeId?: string;
  sensorType: string;
  [key: string]: unknown;
}

// --- Type Guards ---

export function isSttResult(msg: unknown): msg is SttResultMessage {
  return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "stt_result";
}

export function isVadResult(msg: unknown): msg is VadResultMessage {
  return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "vad_result";
}

export function isVisionResult(msg: unknown): msg is VisionResultMessage {
  return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "vision_result";
}

export function isSensorResult(msg: unknown): msg is SensorResultMessage {
  return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).type === "sensor_result";
}
