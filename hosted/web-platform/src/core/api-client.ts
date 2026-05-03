/**
 * API client — typed wrappers around fetch for relay server endpoints.
 * Reuses authFetch from auth/core.js for token-aware requests.
 */

import { authFetch } from "../auth.js";

export interface StatsResponse {
  activeSessions?: number;
  active_sessions?: number;
  totalSessions?: number;
  total_sessions?: number;
  totalDevices?: number;
  total_devices?: number;
  totalBytesSent?: number;
  bytes_sent?: number;
  uptime?: number;
  guidanceEvents?: number;
  guidance_events?: number;
}

export interface SessionInfo {
  sessionId: string;
  live: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  videoDurationMs?: number;
  audioDurationMs?: number;
  driftMs?: number;
  framesRelayed?: number;
  framesRecorded?: number;
  hasThumbnail?: boolean;
  segments?: number;
  device?: {
    deviceId?: string;
    deviceName?: string;
    deviceModel?: string;
    wearableType?: string;
  };
  wearable?: {
    wearableId?: string;
    wearableType?: string;
  } | null;
  access?: string;
  owner?: string;
  viewerCount?: number;
  uptimeMs?: number;
  activeWorkflowId?: string | null;
  publisherStandby?: boolean;
}

export interface DeviceInfo {
  device_id: string;
  deviceName?: string;
  deviceModel?: string;
  device_model?: string;
  systemVersion?: string;
  appVersion?: string;
  buildNumber?: string;
  apnsToken?: string;
  lastSeen?: string;
  online?: boolean;
  battery?: number;
  storage?: { used: number; total: number };
  signalStrength?: number;
}

export interface BuildHistoryEntry {
  appVersion: string;
  buildNumber: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AppInfo {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  active?: boolean;
  config?: {
    model?: string;
    voice?: string;
    gestures?: string[];
  };
}

export interface GuidanceHistoryEvent {
  type: string;
  content: string;
  confidence: number;
  source: string;
  trigger: string;
  timestampMs: number;
}

/** Typed GET request */
export async function apiGet<T>(url: string): Promise<T | null> {
  try {
    const res = await authFetch(url);
    if (!res.ok) {
      console.warn(`[api] GET ${url} returned ${res.status}`);
      return null;
    }
    return await res.json() as T;
  } catch (err) {
    console.warn(`[api] GET ${url} failed:`, err);
    return null;
  }
}

/** Typed POST request */
export async function apiPost<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await authFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`[api] POST ${url} returned ${res.status}:`, errBody);
      return null;
    }
    return await res.json() as T;
  } catch (err) {
    console.warn(`[api] POST ${url} failed:`, err);
    return null;
  }
}

/** Typed PUT request */
export async function apiPut<T>(url: string, body: unknown): Promise<T | null> {
  try {
    const res = await authFetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`[api] PUT ${url} returned ${res.status}:`, errBody);
      return null;
    }
    return await res.json() as T;
  } catch (err) {
    console.warn(`[api] PUT ${url} failed:`, err);
    return null;
  }
}

/** Typed DELETE request */
export async function apiDelete<T>(url: string): Promise<T | null> {
  try {
    const res = await authFetch(url, { method: "DELETE" });
    if (!res.ok) {
      console.warn(`[api] DELETE ${url} returned ${res.status}`);
      return null;
    }
    return await res.json() as T;
  } catch (err) {
    console.warn(`[api] DELETE ${url} failed:`, err);
    return null;
  }
}

/** Fetch platform stats and flatten from nested server response */
export async function fetchStats(): Promise<StatsResponse | null> {
  const raw = await apiGet<Record<string, unknown>>("/stats");
  if (!raw) return null;

  const server = raw.server as Record<string, unknown> | undefined;
  const hosted = server?.hosted as Record<string, unknown> | undefined;
  const relay = hosted?.relay as Record<string, unknown> | undefined;
  const sessions = relay?.sessions as Record<string, number> | undefined;
  const connections = relay?.connections as Record<string, number> | undefined;
  const metrics = (server?.metrics as Record<string, unknown>)?.aggregate as Record<string, unknown> | undefined;
  const bandwidth = metrics?.bandwidth as Record<string, number> | undefined;
  const frames = metrics?.frames as Record<string, number> | undefined;

  return {
    activeSessions: sessions?.active,
    totalSessions: sessions?.started,
    totalDevices: connections?.publishers,
    totalBytesSent: bandwidth ? Math.round(((bandwidth.publisherInMB ?? 0) + (bandwidth.viewerOutMB ?? 0)) * 1048576) : undefined,
    uptime: server?.uptimeMs as number | undefined,
    guidanceEvents: frames?.relayed,
  };
}

/** Fetch active sessions — maps /sessions `id` field to `sessionId` */
export function fetchSessions(): Promise<SessionInfo[]> {
  return apiGet<Record<string, unknown>[]>("/sessions").then(r => {
    if (!r) return [];
    return r.map(s => {
      const meta = s.metadata as Record<string, string> | undefined;
      return {
        sessionId: (s.id ?? s.sessionId) as string,
        live: s.live as boolean,
        startedAt: (s.startedAt ?? meta?.startedAt) as string | undefined,
        device: meta
          ? { deviceId: meta.deviceId, deviceName: meta.deviceName, deviceModel: meta.deviceModel, wearableType: meta.wearableType }
          : s.device as SessionInfo["device"],
        viewerCount: s.viewerCount as number | undefined,
        uptimeMs: s.uptimeMs as number | undefined,
        activeWorkflowId: (s.activeWorkflowId ?? null) as string | null | undefined,
        publisherStandby: s.publisherStandby as boolean | undefined,
      };
    });
  });
}

/** Fetch all gallery sessions (recorded + live) */
export function fetchGallery(): Promise<SessionInfo[]> {
  return apiGet<SessionInfo[]>("/gallery/api").then(r => Array.isArray(r) ? r : []);
}

/** Fetch registered devices */
export function fetchDevices(): Promise<DeviceInfo[]> {
  return apiGet<{ devices: DeviceInfo[] } | DeviceInfo[]>("/api/registered-devices")
    .then(r => {
      if (!r) return [];
      return Array.isArray(r) ? r : r.devices ?? [];
    });
}

/** Fetch build history for a specific device */
export function fetchDeviceBuildHistory(deviceId: string): Promise<BuildHistoryEntry[]> {
  return apiGet<{ builds: BuildHistoryEntry[] }>(`/api/devices/${encodeURIComponent(deviceId)}/build-history`)
    .then(r => r?.builds ?? []);
}

/** Bulk delete devices from fleet. Devices re-register on reconnect. */
export async function deleteDevices(deviceIds: string[]): Promise<{ ok: boolean; deleted: number } | null> {
  try {
    const res = await authFetch("/api/devices", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceIds }),
    });
    if (!res.ok) {
      console.warn(`[api] DELETE /api/devices returned ${res.status}`);
      return null;
    }
    return await res.json() as { ok: boolean; deleted: number };
  } catch (err) {
    console.warn("[api] DELETE /api/devices failed:", err);
    return null;
  }
}

/** Fetch AI apps */
export function fetchApps(): Promise<AppInfo[]> {
  return apiGet<{ apps: AppInfo[] } | AppInfo[]>("/apps")
    .then(r => {
      if (!r) return [];
      return Array.isArray(r) ? r : r.apps ?? [];
    });
}

/** Fetch guidance history for a session */
export function fetchGuidanceHistory(sessionId: string): Promise<GuidanceHistoryEvent[]> {
  return apiGet<GuidanceHistoryEvent[]>(`/session/${sessionId}/guidance/history`)
    .then(r => r ?? []);
}

/** HTML escape utility */
export function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** Format uptime from seconds */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Format ISO timestamp to locale time */
export function formatTime(iso?: string): string {
  if (!iso) return "--";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return "--"; }
}

/** Format ISO timestamp to locale datetime */
export function formatDateTime(iso?: string): string {
  if (!iso) return "--";
  try {
    return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }) +
      " " + new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return "--"; }
}

/** Format bytes to human readable */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb > 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb > 1) return `${mb.toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// --- Workflow types (centralized in workflow-types.ts) ---

import type {
  WorkflowSummary,
  WorkflowNodeDef,
  WorkflowEdgeDef,
  WorkflowDetail,
  FlowExecutionMode,
  FlowTriggerType,
  FlowTrigger,
  FlowExecutionConfig,
  DetectedFlow,
  WorkflowSettings,
  ConnectionCondition,
  ConfigFieldSchema,
  ConnectionOverride,
  SubnodeDefinition,
  NodeDefinition,
} from "./workflow-types.js";

export type {
  WorkflowSummary,
  WorkflowNodeDef,
  WorkflowEdgeDef,
  WorkflowDetail,
  FlowExecutionMode,
  FlowTriggerType,
  FlowTrigger,
  FlowExecutionConfig,
  DetectedFlow,
  WorkflowSettings,
  ConnectionCondition,
  ConfigFieldSchema,
  ConnectionOverride,
  SubnodeDefinition,
  NodeDefinition,
} from "./workflow-types.js";

export { DEFAULT_WORKFLOW_SETTINGS } from "./workflow-types.js";

// --- Workflow API ---

/** Fetch all workflows */
export function fetchWorkflows(): Promise<WorkflowSummary[]> {
  return apiGet<WorkflowSummary[]>("/workflows").then(r => r ?? []);
}

/** Fetch a single workflow */
export function fetchWorkflow(id: string): Promise<WorkflowDetail | null> {
  return apiGet<WorkflowDetail>(`/workflows/${id}`);
}

/** Create a new workflow */
export function createWorkflow(data: {
  name: string;
  description?: string;
  nodes?: Array<{ id: string; type: string; label?: string; config?: string; positionX?: number; positionY?: number }>;
  edges?: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
}): Promise<WorkflowDetail | null> {
  return apiPost<WorkflowDetail>("/workflows", data);
}

/** Update a workflow */
export function updateWorkflow(id: string, data: {
  name?: string;
  description?: string;
  status?: string;
  canvasViewport?: string;
  flowConfig?: FlowExecutionConfig | null;
  settings?: WorkflowSettings | null;
  nodes?: Array<{ id: string; type: string; label?: string; config?: string; positionX?: number; positionY?: number }>;
  edges?: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
}): Promise<WorkflowDetail | null> {
  return apiPut<WorkflowDetail>(`/workflows/${id}`, data);
}

/** Delete a workflow */
export function deleteWorkflow(id: string): Promise<{ ok: boolean } | null> {
  return apiDelete<{ ok: boolean }>(`/workflows/${id}`);
}

/** Activate a workflow against a session (with conflict detection) or wake a device */
export async function activateWorkflow(
  workflowId: string,
  sessionId?: string,
  options?: { override?: boolean; reason?: string; deviceId?: string },
): Promise<{ appId: string; status: string; conflict?: { activeAppId: string | null; status: string; activatedAt: number | undefined } } | null> {
  try {
    const body: Record<string, unknown> = {};
    if (sessionId) body.sessionId = sessionId;
    if (options?.deviceId) body.deviceId = options.deviceId;
    if (options?.override) body.override = options.override;
    if (options?.reason) body.reason = options.reason;
    const res = await authFetch(`/workflows/${workflowId}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as any;
    if (res.status === 409) {
      return { appId: "", status: "conflict", conflict: data.conflict };
    }
    if (!res.ok) return null;
    return data;
  } catch (err) {
    console.warn("[api] activateWorkflow failed:", err);
    return null;
  }
}

/** Start camera stream on a session's publisher (independent of workflow activation) */
export async function startStream(sessionId: string): Promise<{ ok: boolean; sessionId?: string; error?: string } | null> {
  try {
    const res = await authFetch(`/session/${sessionId}/start-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json() as any;
    if (!res.ok) return { ok: false, error: data.error ?? "Failed to start stream" };
    return data;
  } catch (err) {
    console.warn("[api] startStream failed:", err);
    return null;
  }
}

/** Stop camera stream on a session's publisher */
export async function stopStream(sessionId: string): Promise<{ ok: boolean; sessionId?: string; error?: string } | null> {
  try {
    const res = await authFetch(`/session/${sessionId}/stop-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json() as any;
    if (!res.ok) return { ok: false, error: data.error ?? "Failed to stop stream" };
    return data;
  } catch (err) {
    console.warn("[api] stopStream failed:", err);
    return null;
  }
}

/** Wake a device via APNs push */
export async function wakeDevice(deviceId: string): Promise<{ ok: boolean; error?: string } | null> {
  try {
    const res = await authFetch("/api/wake-device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
    const data = await res.json() as any;
    if (!res.ok) return { ok: false, error: data.error ?? "Wake failed" };
    return data;
  } catch (err) {
    console.warn("[api] wakeDevice failed:", err);
    return null;
  }
}

/** Fetch available primitives */
export function fetchPrimitives(): Promise<Array<{ id: string; name: string; icon: string }>> {
  return apiGet<Array<{ id: string; name: string; icon: string }>>("/primitives").then(r => r ?? []);
}

// --- Node Definitions (types re-exported from workflow-types.ts) ---

export async function fetchNodeDefinitions(): Promise<NodeDefinition[]> {
  const defs = await apiGet<NodeDefinition[]>("/api/node-definitions");
  return defs ?? [];
}
