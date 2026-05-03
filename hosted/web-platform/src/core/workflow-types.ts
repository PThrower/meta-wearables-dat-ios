/**
 * Canonical workflow types — shared across workflow editor, live viewer, and dashboard.
 *
 * Previously defined inline in api-client.ts. Extracted for discoverability and
 * single-source-of-truth across all consumers (pages/workflow/, live/, hosted/server).
 */

// ── Workflow document ──

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  status: "draft" | "published" | "archived";
  ownerId: string | null;
  nodeCount: number;
  updatedAt: string;
}

export interface WorkflowNodeDef {
  id: string;
  type: string;  // resolved from node-definitions registry
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

export interface WorkflowDetail {
  id: string;
  name: string;
  description: string;
  status: "draft" | "published" | "archived";
  ownerId: string | null;
  nodes: WorkflowNodeDef[];
  edges: WorkflowEdgeDef[];
  canvasViewport: { x: number; y: number; zoom: number };
  flowConfig: FlowExecutionConfig | null;
  settings: WorkflowSettings | null;
  createdAt: string;
  updatedAt: string;
}

// ── Flow execution ──

/** Execution mode for multi-flow workflows */
export type FlowExecutionMode = "parallel" | "sequential" | "event-driven";

/** Trigger type for event-driven flow activation */
export type FlowTriggerType = "on_flow_complete" | "on_condition" | "on_timer" | "on_jepa_event";

/** Trigger configuration for event-driven flow activation */
export interface FlowTrigger {
  type: FlowTriggerType;
  sourceFlowId?: string;
  condition?: {
    sourceFlowId: string;
    field: string;
    operator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
    value: number;
  };
  intervalSec?: number;
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

// ── Workflow settings ──

/** Workflow-level settings — applies to the entire session lifecycle */
export interface WorkflowSettings {
  onDisconnect: "stop" | "pause" | "continue";
  onReconnect: "restart" | "resume" | "noop";
  autoDeactivateMin: number | null;
  maxSessionDuration: number | null;
  recordingEnabled: boolean;
  viewerAccess: "owner" | "team" | "public";
  telemetryIntervalSec: number;
  // Device wake & stream
  wakeOnActivate: boolean;
  autoStartStream: boolean;
  targetDeviceId: string | null;
}

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  onDisconnect: "stop",
  onReconnect: "restart",
  autoDeactivateMin: null,
  maxSessionDuration: null,
  recordingEnabled: true,
  viewerAccess: "owner",
  telemetryIntervalSec: 10,
  wakeOnActivate: false,
  autoStartStream: false,
  targetDeviceId: null,
};

// ── Node definitions (schema-driven workflow UI) ──

export type ConnectionCondition =
  | { upstream: string[] }
  | { downstream: string[] }
  | { notConnected: string[] }
  | { upstreamAll: string[] };

export type ConfigFieldSchema =
  | { kind: "text"; key: string; label: string; placeholder?: string }
  | { kind: "textarea"; key: string; label: string; rows?: number; placeholder?: string }
  | { kind: "select"; key: string; label: string; options: Array<{ value: string; label: string }> }
  | { kind: "range"; key: string; label: string; min: number; max: number; step: number; unit?: string }
  | { kind: "checkbox"; key: string; label: string }
  | { kind: "toggle"; key: string; label: string; description?: string }
  | { kind: "number"; key: string; label: string; min?: number; max?: number; step?: number; placeholder?: string }
  | { kind: "checkbox-group"; key: string; label: string; fields: Array<{ key: string; label: string }> }
  | { kind: "geofence-map"; key: string; label: string }
  | { kind: "zones"; key: string; label: string }
  | { kind: "section"; label: string; fields: ConfigFieldSchema[] }
  | { kind: "conditional"; condition: ConnectionCondition; fields: ConfigFieldSchema[] };

export interface ConnectionOverride {
  condition: ConnectionCondition;
  label?: string;
  subtitle?: string;
  color?: { fill: string; header: string; stroke: string };
  extraAllowedTargets?: string[];
}

export interface SubnodeDefinition {
  type: string;
  label: string;
  subtitle: string;
  color: { fill: string; header: string; stroke: string };
  allowedTargets: string[];
  allowedSources: string[];
  configSchema: ConfigFieldSchema[];
  defaultConfig: Record<string, unknown>;
  defaultLabel: string;
  runtime: ("mobile" | "server")[];
}

export interface NodeDefinition {
  type: string;
  label: string;
  subtitle: string;
  color: { fill: string; header: string; stroke: string };
  allowedTargets: string[];
  role: "source" | "processor" | "reference" | "trigger" | "transform" | "sink" | "gating";
  activationMode: "ai" | "jepa" | "stt" | "passthrough" | "vision" | "enhance" | "sensor" | "speech" | "tracking" | "measure" | "palantir" | "yolo" | null;
  binding: string | null;
  defaultModel: string | null;
  configSchema: ConfigFieldSchema[];
  defaultConfig: Record<string, unknown>;
  defaultLabel: string;
  runtime: ("mobile" | "server")[];
  parentType?: string;
  allowedSources?: string[];
  subnodes?: SubnodeDefinition[];
  connectionOverrides?: ConnectionOverride[];
}
