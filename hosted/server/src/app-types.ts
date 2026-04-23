/**
 * App/Layer type definitions for the relay server
 *
 * Three-tier architecture: Primitives → Capabilities → Apps
 * Primitives are swappable building blocks (e.g., S2S model, hand pose detector).
 * Apps compose primitives into user-facing experiences.
 */

// --- Primitives ---

export interface PrimitiveIO {
  format: string;
  sampleRate?: number;
}

export interface PrimitiveDefinition {
  id: string;
  inputs: PrimitiveIO[];
  outputs: PrimitiveIO[];
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

// --- Workflow Builder ---

export type WorkflowNodeType = "camera-source" | "s2s-live" | "s2s-rest" | "s2s-e4b" | "output";

/** Output channel routing for workflow output nodes */
export interface OutputConfig {
  viewers: boolean;   // Fan out guidance events to viewer WebSockets
  overlays: boolean;  // Render bbox annotations on viewer video canvas
  speaker: boolean;   // Push AI audio to publisher (glasses/phone speakers)
  recording: boolean; // Persist guidance events + annotations to R2/S3
}

export interface WorkflowNodeDef {
  id: string;
  type: WorkflowNodeType;
  label: string;
  config: Record<string, unknown>;
  positionX: number;
  positionY: number;
}

export interface WorkflowEdgeDef {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  ownerId: string | null;
  status: "draft" | "published" | "archived";
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
  canvasViewport: { x: number; y: number; zoom: number };
  createdAt: string;
  updatedAt: string;
}
