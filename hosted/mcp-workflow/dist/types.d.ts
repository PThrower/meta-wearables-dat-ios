/**
 * Shared types for the MWDAT workflow MCP server.
 * Mirrors the relay server's workflow API types from hosted/web-platform/src/core/api-client.ts
 */
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
    type: string;
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
export type FlowExecutionMode = "parallel" | "sequential" | "event-driven";
export interface FlowTrigger {
    type: "on_flow_complete" | "on_condition" | "on_timer" | "on_jepa_event";
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
export interface FlowExecutionConfig {
    mode: FlowExecutionMode;
    flowOrder: string[];
    flowTriggers?: Record<string, FlowTrigger>;
}
export interface WorkflowSettings {
    onDisconnect: "stop" | "pause" | "continue";
    onReconnect: "restart" | "resume" | "noop";
    autoDeactivateMin: number | null;
    maxSessionDuration: number | null;
    recordingEnabled: boolean;
    viewerAccess: "owner" | "team" | "public";
    telemetryIntervalSec: number;
    wakeOnActivate: boolean;
    autoStartStream: boolean;
    targetDeviceId: string | null;
}
export interface WorkflowDetail {
    id: string;
    name: string;
    description: string;
    status: "draft" | "published" | "archived";
    ownerId: string | null;
    nodes: WorkflowNodeDef[];
    edges: WorkflowEdgeDef[];
    canvasViewport: {
        x: number;
        y: number;
        zoom: number;
    };
    flowConfig: FlowExecutionConfig | null;
    settings: WorkflowSettings | null;
    createdAt: string;
    updatedAt: string;
}
export type StructuralRole = "source" | "reference" | "processor" | "trigger" | "transform" | "sink" | "gating";
export type ActivationMode = "ai" | "jepa" | "stt" | "passthrough" | "vision" | "enhance" | "sensor" | "speech" | "tracking" | "measure" | "palantir" | "yolo" | "gating" | null;
export type ConfigFieldSchema = {
    kind: "text";
    key: string;
    label: string;
    placeholder?: string;
} | {
    kind: "textarea";
    key: string;
    label: string;
    rows?: number;
    placeholder?: string;
} | {
    kind: "select";
    key: string;
    label: string;
    options: Array<{
        value: string;
        label: string;
    }>;
} | {
    kind: "range";
    key: string;
    label: string;
    min: number;
    max: number;
    step: number;
    unit?: string;
} | {
    kind: "checkbox";
    key: string;
    label: string;
} | {
    kind: "number";
    key: string;
    label: string;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
} | {
    kind: "checkbox-group";
    key: string;
    label: string;
    fields: Array<{
        key: string;
        label: string;
    }>;
} | {
    kind: "geofence-map";
    key: string;
    label: string;
} | {
    kind: "zones";
    key: string;
    label: string;
} | {
    kind: "section";
    label: string;
    fields: ConfigFieldSchema[];
} | {
    kind: "conditional";
    condition: Record<string, unknown>;
    fields: ConfigFieldSchema[];
};
export interface ConnectionOverride {
    condition: Record<string, unknown>;
    label?: string;
    subtitle?: string;
    color?: {
        fill: string;
        header: string;
        stroke: string;
    };
    extraAllowedTargets?: string[];
}
export interface SubnodeDefinition {
    type: string;
    label: string;
    subtitle: string;
    color: {
        fill: string;
        header: string;
        stroke: string;
    };
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
    color: {
        fill: string;
        header: string;
        stroke: string;
    };
    allowedTargets: string[];
    role: StructuralRole;
    activationMode: ActivationMode;
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
export interface ActivationResult {
    appId: string;
    status: string;
    conflict?: {
        activeAppId: string | null;
        status: string;
        activatedAt: number | undefined;
    };
}
export interface ActiveSession {
    id: string;
    live: boolean;
    publisherConnected: boolean;
    publisherStandby: boolean;
    viewerCount: number;
    uptimeMs: number;
    activeWorkflowId: string | null;
    createdAt: number | undefined;
    lastActivityAt: number | undefined;
    state: string;
    linkState: string;
    device: {
        deviceId: string | null;
        deviceName: string | null;
        deviceModel: string | null;
        wearableType: string | null;
        systemVersion: string | null;
        appVersion: string | null;
        buildNumber: string | null;
    } | null;
    battery: {
        level: number | null;
        state: string | null;
        lowPowerMode: boolean;
    } | null;
    frames: {
        frameCount: number;
        totalBytes: number;
        audioCount: number;
        audioBytes: number;
    } | null;
}
export interface NodeStateInfo {
    nodeId: string;
    nodeType: string;
    label: string;
    state: string;
    startedAt: number | null;
    completedAt: number | null;
    error?: string;
}
export interface NodeExecutionLogEntry {
    id: string;
    sessionId: string;
    workflowId: string;
    nodeId: string;
    appId: string | null;
    nodeType: string;
    state: string;
    action: string;
    error: string | null;
    triggeredBy: string | null;
    timestampMs: number;
}
export interface NodeStatesResponse {
    sessionId: string;
    workflowId: string | null;
    workflowName: string | null;
    activatedAt: number | null;
    nodes: NodeStateInfo[];
    log: NodeExecutionLogEntry[];
}
export interface SessionTelemetry {
    sessionId: string;
    publisher: {
        connected: boolean;
        standby?: boolean;
        frameCount?: number;
        totalBytes?: number;
        audioCount?: number;
        audioBytes?: number;
        timing?: Record<string, unknown>;
        lastHeader?: {
            width: number;
            height: number;
            quality: number;
        } | null;
        battery?: {
            level: number | null;
            state: string | null;
            lowPowerMode: boolean;
        };
    };
    ai: {
        status: Record<string, unknown>;
        telemetry: Record<string, unknown>;
        eventHistory: Record<string, unknown>[];
    };
}
export interface SessionInfo {
    sessionId: string;
    live: boolean;
    activeWorkflowId?: string | null;
    viewerCount?: number;
    uptimeMs?: number;
    publisherStandby?: boolean;
    device?: {
        deviceId?: string;
        deviceName?: string;
        deviceModel?: string;
        wearableType?: string;
    };
}
//# sourceMappingURL=types.d.ts.map