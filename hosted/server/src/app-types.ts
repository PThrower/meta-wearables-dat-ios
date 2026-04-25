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

export type WorkflowNodeType = "stream-input" | "text" | "s2s-live" | "s2s-rest" | "s2s-e4b" | "jepa-vision" | "jepa-trigger" | "timer-trigger" | "conditional" | "local-tts" | "tones" | "phone-speaker" | "glasses-speaker" | "overlays";

/** JEPA vision node config -- provider-abstraction for continuous stream understanding */
export interface JEPANodeConfig {
  /** Provider: "modal" (cloud GPU), "coreml" (on-device Apple Silicon), "onnx" (on-device Android) */
  provider: "modal" | "coreml" | "onnx";
  /** Deployment tier: "cloud" runs on remote GPU, "mobile" runs on-device */
  tier: "cloud" | "mobile";
  /** Model variant (e.g., "vjepa2-vitl-fpc16-384") */
  model: string;
  /** GPU type for cloud tier (e.g., "A10G", "A100-80GB", "H100") -- ignored for mobile */
  gpu: string;
  /** Frames per clip (16 or 64) */
  clipLength: number;
  /** Frames per second sampled from stream */
  sampleFps: number;
  /** Encoder input resolution (256 or 384) */
  resolution: number;
  /** Task heads to enable */
  tasks: JEPATaskType[];
}

export interface JEPATaskType {
  type: "action-classification" | "anomaly-detection" | "prediction" | "embedding-extraction";
  labels?: string[];
  threshold?: number;
}

/** Input modality config — each publisher stream is a toggleable modality */
export interface InputConfig {
  video: boolean;                        // Forward video frames to AI
  phoneMic: boolean;                     // Forward phone mic audio (codecType 0, 48kHz)
  glassesMic: boolean;                   // Forward glasses HFP mic audio (codecType 1, 8kHz)
  gestures: boolean;                     // Forward gesture triggers to AI
  visionFps: number;                     // Frames/sec forwarded to AI
}

/** Output channel routing for workflow output nodes */
export interface OutputConfig {
  viewers: boolean;   // Fan out guidance events to viewer WebSockets
  overlays: boolean;  // Render bbox annotations on viewer video canvas
  speaker: boolean;   // Push AI audio to publisher (glasses/phone speakers)
  speakerTarget?: "phone" | "glasses";  // Which speaker to route to (resolved from downstream sink nodes)
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

// --- Activation Guard ---

export interface ActivationConflict {
  activeAppId: string | null;
  activeAppName: string | null;
  activatedBy: string | null;
  activatedAt: string | null;
  locked: boolean;
}

export interface ActivationResult {
  appId: string;
  status: string;
  conflict?: ActivationConflict;
}

export type ActivationPolicy = "allow" | "reject" | "override";

export interface LifecyclePolicy {
  onDisconnect: "stop" | "pause" | "continue";
  onReconnect: "resume" | "restart" | "noop";
  autoDeactivateMin: number | null;  // null = never
}
