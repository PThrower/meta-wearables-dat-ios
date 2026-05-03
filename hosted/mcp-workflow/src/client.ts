/**
 * HTTP client for the MWDAT relay server's workflow REST API.
 */

import type {
  WorkflowSummary,
  WorkflowDetail,
  NodeDefinition,
  ActivationResult,
  SessionInfo,
  ActiveSession,
  NodeStatesResponse,
  SessionTelemetry,
} from "./types.js";

const DEFAULT_URL = "https://relay.simulationapi.com";

function baseUrl(): string {
  return process.env.MWDAT_RELAY_URL ?? DEFAULT_URL;
}

class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`API ${status}: ${body.slice(0, 200)}`);
    this.name = "ApiError";
  }
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text);
  }

  return (await res.json()) as T;
}

// --- Workflow CRUD ---

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  return request<WorkflowSummary[]>("GET", "/workflows");
}

export async function getWorkflow(id: string): Promise<WorkflowDetail> {
  return request<WorkflowDetail>("GET", `/workflows/${id}`);
}

export async function createWorkflow(data: {
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
  edges?: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
}): Promise<WorkflowDetail> {
  return request<WorkflowDetail>("POST", "/workflows", data);
}

export async function updateWorkflow(
  id: string,
  data: {
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
    edges?: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
  },
): Promise<WorkflowDetail> {
  return request<WorkflowDetail>("PUT", `/workflows/${id}`, data);
}

export async function deleteWorkflow(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("DELETE", `/workflows/${id}`);
}

// --- Activation ---

export async function activateWorkflow(
  workflowId: string,
  sessionId?: string,
  options?: { override?: boolean; reason?: string; deviceId?: string },
): Promise<ActivationResult> {
  const body: Record<string, unknown> = {};
  if (sessionId) body.sessionId = sessionId;
  if (options?.deviceId) body.deviceId = options.deviceId;
  if (options?.override) body.override = options.override;
  if (options?.reason) body.reason = options.reason;

  const res = await fetch(`${baseUrl()}/workflows/${workflowId}/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (res.status === 409) {
    return { appId: "", status: "conflict", conflict: data.conflict as ActivationResult["conflict"] };
  }
  if (!res.ok) throw new ApiError(res.status, JSON.stringify(data));
  return data as unknown as ActivationResult;
}

// --- Node Definitions ---

let nodeDefsCache: NodeDefinition[] | null = null;
let nodeDefsCacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

export async function getNodeDefinitions(
  forceRefresh = false,
): Promise<NodeDefinition[]> {
  if (!forceRefresh && nodeDefsCache && Date.now() - nodeDefsCacheTime < CACHE_TTL) {
    return nodeDefsCache;
  }
  const defs = await request<NodeDefinition[]>("GET", "/api/node-definitions");
  nodeDefsCache = defs;
  nodeDefsCacheTime = Date.now();
  return defs;
}

// --- Sessions ---

export async function listSessions(): Promise<SessionInfo[]> {
  const raw = await request<Record<string, unknown>[]>("GET", "/sessions");
  return raw.map((s) => ({
    sessionId: (s.id ?? s.sessionId) as string,
    live: s.live as boolean,
    activeWorkflowId: (s.activeWorkflowId ?? null) as string | null | undefined,
    viewerCount: s.viewerCount as number | undefined,
    uptimeMs: s.uptimeMs as number | undefined,
    publisherStandby: s.publisherStandby as boolean | undefined,
    device: s.metadata
      ? {
          deviceId: (s.metadata as Record<string, string>).deviceId,
          deviceName: (s.metadata as Record<string, string>).deviceName,
          deviceModel: (s.metadata as Record<string, string>).deviceModel,
          wearableType: (s.metadata as Record<string, string>).wearableType,
        }
      : (s.device as SessionInfo["device"]),
  }));
}

// --- Runtime Observability ---

export async function getActiveSessions(): Promise<ActiveSession[]> {
  return request<ActiveSession[]>("GET", "/sessions/active");
}

export async function getNodeStates(sessionId: string, limit = 100): Promise<NodeStatesResponse> {
  return request<NodeStatesResponse>("GET", `/sessions/${sessionId}/node-states?limit=${limit}`);
}

export async function getSessionTelemetry(sessionId: string): Promise<SessionTelemetry> {
  return request<SessionTelemetry>("GET", `/sessions/${sessionId}/telemetry`);
}

export async function deactivateWorkflow(sessionId: string): Promise<{ ok: boolean; sessionId: string; deactivatedWorkflowId: string }> {
  return request<{ ok: boolean; sessionId: string; deactivatedWorkflowId: string }>("POST", `/sessions/${sessionId}/deactivate`);
}
