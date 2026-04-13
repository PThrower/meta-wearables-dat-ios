/**
 * App/Layer type definitions for the relay server
 *
 * Three-tier architecture: Primitives → Capabilities → Apps
 * Primitives are swappable building blocks (e.g., S2S model, hand pose detector).
 * Apps compose primitives into user-facing experiences.
 */

// --- Primitives ---

export interface PrimitiveDefinition {
  id: string;
  input: { format: string; sampleRate?: number };
  output: { format: string };
}

// --- Apps ---

export interface AppConfig {
  model?: string;
  voice?: string;
  visionFps?: number;
  gestures?: string[];
  [key: string]: unknown;
}

export interface AppDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  binding: string;          // primitive ID this app binds to
  systemPrompt: string;
  config: AppConfig;
}

// --- Pipeline (runtime) ---

export interface AppPipeline {
  appId: string;
  primitiveId: string;
}

// --- Control events (gestures, etc.) ---

export interface ControlEvent {
  type: string;             // "gesture" | "activate_app" | "deactivate_app" | "app_status"
  gesture?: string;         // "thumbs_up" | "thumbs_down" | "open_palm" | "pointing"
  appId?: string;
  confidence?: number;
  timestampMs?: number;
}

// --- Apps config file schema ---

export interface AppsConfig {
  primitives: PrimitiveDefinition[];
  apps: AppDefinition[];
}
