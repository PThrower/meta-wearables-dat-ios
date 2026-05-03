/**
 * HTTP client for the MWDAT relay server's workflow REST API.
 */
import type { WorkflowSummary, WorkflowDetail, NodeDefinition, ActivationResult, SessionInfo } from "./types.js";
export declare function listWorkflows(): Promise<WorkflowSummary[]>;
export declare function getWorkflow(id: string): Promise<WorkflowDetail>;
export declare function createWorkflow(data: {
    name: string;
    description?: string;
    nodes?: Array<{
        id: string;
        type: string;
        label?: string;
        config?: string;
        positionX?: number;
        positionY?: number;
    }>;
    edges?: Array<{
        id: string;
        sourceNodeId: string;
        targetNodeId: string;
    }>;
}): Promise<WorkflowDetail>;
export declare function updateWorkflow(id: string, data: {
    name?: string;
    description?: string;
    status?: string;
    canvasViewport?: string;
    flowConfig?: unknown;
    settings?: unknown;
    nodes?: Array<{
        id: string;
        type: string;
        label?: string;
        config?: string;
        positionX?: number;
        positionY?: number;
    }>;
    edges?: Array<{
        id: string;
        sourceNodeId: string;
        targetNodeId: string;
    }>;
}): Promise<WorkflowDetail>;
export declare function deleteWorkflow(id: string): Promise<{
    ok: boolean;
}>;
export declare function activateWorkflow(workflowId: string, sessionId?: string, options?: {
    override?: boolean;
    reason?: string;
    deviceId?: string;
}): Promise<ActivationResult>;
export declare function getNodeDefinitions(forceRefresh?: boolean): Promise<NodeDefinition[]>;
export declare function listSessions(): Promise<SessionInfo[]>;
//# sourceMappingURL=client.d.ts.map