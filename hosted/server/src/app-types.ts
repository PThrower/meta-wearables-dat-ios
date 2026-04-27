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

export type WorkflowNodeType = "camera-source" | "phone-mic-source" | "glasses-mic-source" | "gesture-source" | "text" | "s2s-live" | "s2s-rest" | "s2s-e4b" | "jepa-vision" | "deepgram-stt" | "jepa-trigger" | "timer-trigger" | "conditional" | "local-tts" | "tones" | "phone-speaker" | "glasses-speaker" | "overlays";

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

// --- Workflow Execution Controls ---

export type NodeExecutionState = "pending" | "running" | "paused" | "completed" | "skipped" | "errored" | "waiting";

export interface NodeExecutionInfo {
  nodeId: string;
  appId: string;
  nodeType: WorkflowNodeType;
  label: string;
  state: NodeExecutionState;
  startedAt: number | null;
  completedAt: number | null;
  error?: string;
}

export interface WorkflowInstanceState {
  workflowId: string;
  workflowName: string;
  sessionId: string;
  nodes: Map<string, NodeExecutionInfo>;
  activatedAt: number;
}

export type WorkflowControlAction = "pause_workflow" | "resume_workflow" | "stop_workflow" | "skip_node" | "redo_node" | "continue_node";

// --- Wire messages for workflow control ---

/** Client -> Server: request a control action */
export interface WorkflowControlMessage {
  type: "workflow_control";
  action: WorkflowControlAction;
  workflowId: string;
  nodeId?: string;
}

/** Server -> Client: broadcast node execution states */
export interface NodeStatesMessage {
  type: "node_states";
  workflowId: string;
  nodes: Array<{
    nodeId: string;
    appId: string;
    nodeType: WorkflowNodeType;
    label: string;
    state: NodeExecutionState;
    startedAt: number | null;
    completedAt: number | null;
    error?: string;
  }>;
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

// --- Flow Detection & Execution ---

/** Execution mode for multi-flow workflows */
export type FlowExecutionMode = "parallel" | "sequential" | "event-driven";

/** Trigger type for event-driven flow activation */
export type FlowTriggerType = "on_flow_complete" | "on_condition" | "on_timer" | "on_jepa_event";

/** Trigger configuration for event-driven flow activation */
export interface FlowTrigger {
  type: FlowTriggerType;
  /** on_flow_complete: which flow must finish first */
  sourceFlowId?: string;
  /** on_condition: compare a field from source flow's last output */
  condition?: {
    sourceFlowId: string;
    field: string;
    operator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
    value: number;
  };
  /** on_timer: interval-based activation (seconds) */
  intervalSec?: number;
  /** on_jepa_event: JEPA anomaly/action trigger */
  jepaEvent?: "anomaly" | "action" | "any";
  jepaConfidenceThreshold?: number;
}

/** Persisted per-workflow config for flow execution */
export interface FlowExecutionConfig {
  mode: FlowExecutionMode;
  /** Ordered flow IDs — meaningful when mode is "sequential" */
  flowOrder: string[];
  /** Per-flow triggers — only meaningful when mode is "event-driven" */
  flowTriggers?: Record<string, FlowTrigger>;
}

/** A detected flow = weakly connected component of the DAG */
export interface DetectedFlow {
  flowId: string;
  nodeIds: string[];
  edgeIds: string[];
  color: string;
  /** Human-readable label: first node type → last node type */
  label: string;
}
