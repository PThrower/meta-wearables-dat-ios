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
    deviceName?: string;
    deviceModel?: string;
    wearableType?: string;
  };
  access?: string;
  owner?: string;
  viewerCount?: number;
  uptimeMs?: number;
}

export interface DeviceInfo {
  device_id: string;
  deviceName?: string;
  deviceModel?: string;
  device_model?: string;
  apnsToken?: string;
  lastSeen?: string;
  online?: boolean;
  battery?: number;
  storage?: { used: number; total: number };
  signalStrength?: number;
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
      console.warn(`[api] POST ${url} returned ${res.status}`);
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
      console.warn(`[api] PUT ${url} returned ${res.status}`);
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
    return r.map(s => ({
      sessionId: (s.id ?? s.sessionId) as string,
      live: s.live as boolean,
      startedAt: (s.startedAt ?? (s.metadata as Record<string,string>)?.startedAt) as string | undefined,
      device: (s.metadata as Record<string, unknown>) ?? s.device as SessionInfo["device"],
      viewerCount: s.viewerCount as number | undefined,
      uptimeMs: s.uptimeMs as number | undefined,
    }));
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

// --- Workflow types ---

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
  type: "stream-input" | "text" | "s2s-live" | "s2s-rest" | "s2s-e4b" | "output";
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
  createdAt: string;
  updatedAt: string;
}

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
  nodes?: Array<{ id: string; type: string; label?: string; config?: string; positionX?: number; positionY?: number }>;
  edges?: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
}): Promise<WorkflowDetail | null> {
  return apiPut<WorkflowDetail>(`/workflows/${id}`, data);
}

/** Delete a workflow */
export function deleteWorkflow(id: string): Promise<{ ok: boolean } | null> {
  return apiDelete<{ ok: boolean }>(`/workflows/${id}`);
}

/** Activate a workflow against a session */
export function activateWorkflow(workflowId: string, sessionId: string): Promise<{ appId: string; status: string } | null> {
  return apiPost<{ appId: string; status: string }>(`/workflows/${workflowId}/activate`, { sessionId });
}

/** Fetch available primitives */
export function fetchPrimitives(): Promise<Array<{ id: string; name: string; icon: string }>> {
  return apiGet<Array<{ id: string; name: string; icon: string }>>("/primitives").then(r => r ?? []);
}
