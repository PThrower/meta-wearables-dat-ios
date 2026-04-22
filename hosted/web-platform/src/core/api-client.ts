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

/** Fetch platform stats */
export function fetchStats(): Promise<StatsResponse | null> {
  return apiGet<StatsResponse>("/stats");
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
