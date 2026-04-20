/**
 * queries.ts — High-level database query functions for session lifecycle events
 *
 * These are called from session-registry.ts and server.ts via DbWriter.enqueue().
 * Each function returns a closure that performs the actual SQLite write.
 * All writes use sync bun:sqlite API inside DbWriter's transaction batch.
 */

import { getDbRaw } from "./connection.js";

const now = () => new Date().toISOString();

// --- Sessions ---

/** Create or update a session row */
export function upsertSession(params: {
  id: string;
  recordingId?: string;
  publisherUserId?: string;
  publisherDeviceId?: string;
  orgId?: string;
  status?: string;
  accessLevel?: string;
  ownerId?: string;
  ownerEmail?: string;
}) {
  return () => {
    const db = getDbRaw();
    const ts = now();
    db.prepare(`
      INSERT INTO sessions (id, recording_id, publisher_user_id, publisher_device_id, org_id, status, access_level, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        recording_id = COALESCE(excluded.recording_id, sessions.recording_id),
        publisher_user_id = COALESCE(excluded.publisher_user_id, sessions.publisher_user_id),
        publisher_device_id = COALESCE(excluded.publisher_device_id, sessions.publisher_device_id),
        status = COALESCE(excluded.status, sessions.status),
        access_level = COALESCE(excluded.access_level, sessions.access_level),
        updated_at = excluded.updated_at
    `).run(
      params.id,
      params.recordingId ?? null,
      params.publisherUserId ?? null,
      params.publisherDeviceId ?? null,
      params.orgId ?? null,
      params.status ?? "active",
      params.accessLevel ?? "link",
      ts,
      ts,
      ts,
    );
  };
}

/** Update session when publisher activates (standby -> active) */
export function activateSession(sessionId: string, recordingId: string) {
  return () => {
    const db = getDbRaw();
    db.prepare(`
      UPDATE sessions SET status = 'active', recording_id = ?, updated_at = ?
      WHERE id = ?
    `).run(recordingId, now(), sessionId);
  };
}

/** Finalize session on end -- set duration, frame count, etc. */
export function endSession(sessionId: string, params: {
  durationMs: number;
  totalFrames: number;
  totalBytes: number;
  audioChunks: number;
  peakViewers: number;
  resolutionW?: number;
  resolutionH?: number;
}) {
  return () => {
    const db = getDbRaw();
    db.prepare(`
      UPDATE sessions SET
        status = 'ended',
        ended_at = ?,
        duration_ms = ?,
        total_frames = ?,
        total_bytes = ?,
        audio_chunks = ?,
        peak_viewers = ?,
        resolution_w = ?,
        resolution_h = ?,
        r2_meta_written = 1,
        updated_at = ?
      WHERE id = ?
    `).run(
      now(),
      params.durationMs,
      params.totalFrames,
      params.totalBytes,
      params.audioChunks,
      params.peakViewers,
      params.resolutionW ?? null,
      params.resolutionH ?? null,
      now(),
      sessionId,
    );
  };
}

// --- Devices ---

/** Upsert device info on publisher connect */
export function upsertDevice(params: {
  id: string;
  name?: string;
  model?: string;
  systemVersion?: string;
  wearableType?: string;
  wearableId?: string;
  appVersion?: string;
  buildNumber?: string;
  status?: string;
  lastSessionId?: string;
}) {
  return () => {
    const db = getDbRaw();
    const ts = now();
    db.prepare(`
      INSERT INTO devices (id, name, model, system_version, wearable_type, wearable_id, app_version, build_number, status, last_seen_at, last_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(excluded.name, devices.name),
        model = COALESCE(excluded.model, devices.model),
        system_version = COALESCE(excluded.system_version, devices.system_version),
        wearable_type = COALESCE(excluded.wearable_type, devices.wearable_type),
        wearable_id = COALESCE(excluded.wearable_id, devices.wearable_id),
        app_version = COALESCE(excluded.app_version, devices.app_version),
        build_number = COALESCE(excluded.build_number, devices.build_number),
        status = excluded.status,
        last_seen_at = excluded.last_seen_at,
        last_session_id = COALESCE(excluded.last_session_id, devices.last_session_id),
        updated_at = excluded.updated_at
    `).run(
      params.id,
      params.name ?? null,
      params.model ?? null,
      params.systemVersion ?? null,
      params.wearableType ?? null,
      params.wearableId ?? null,
      params.appVersion ?? null,
      params.buildNumber ?? null,
      params.status ?? "online",
      ts,
      params.lastSessionId ?? null,
      ts,
      ts,
    );
  };
}

/** Update device status */
export function updateDeviceStatus(deviceId: string, status: string) {
  return () => {
    const db = getDbRaw();
    db.prepare(`
      UPDATE devices SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, now(), deviceId);
  };
}

// --- APNs Device Tokens ---

/** Store APNs device token for push notifications. Uses upsert so it works even if no device row exists yet. */
export function updateDeviceToken(deviceId: string, token: string) {
  return () => {
    const db = getDbRaw();
    db.prepare(`
      INSERT INTO devices (id, apns_device_token, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET apns_device_token = excluded.apns_device_token, updated_at = excluded.updated_at
    `).run(deviceId, token, now(), now());
  };
}

/** Retrieve APNs device token for a device */
export function getDeviceToken(deviceId: string): string | null {
  const db = getDbRaw();
  const row = db.prepare(
    "SELECT apns_device_token FROM devices WHERE id = ?"
  ).get(deviceId) as { apns_device_token: string | null } | undefined;
  return row?.apns_device_token ?? null;
}

/** Clear APNs device token (e.g. on Unregistered response from Apple) */
export function clearDeviceToken(deviceId: string) {
  return () => {
    const db = getDbRaw();
    db.prepare(`
      UPDATE devices SET apns_device_token = NULL, updated_at = ? WHERE id = ?
    `).run(now(), deviceId);
  };
}

/** List devices that have APNs tokens registered */
export function listDevicesWithTokens(): { id: string; name: string | null; model: string | null; hasToken: true }[] {
  const db = getDbRaw();
  return db.prepare(
    "SELECT id, name, model FROM devices WHERE apns_device_token IS NOT NULL AND length(apns_device_token) > 10 ORDER BY updated_at DESC"
  ).all() as { id: string; name: string | null; model: string | null; hasToken: true }[];
}

/** Find a device ID by its last known session ID (DB fallback for wake after restart) */
export function findDeviceBySessionDb(sessionId: string): string | null {
  const db = getDbRaw();
  const row = db.prepare(
    "SELECT id FROM devices WHERE last_session_id = ? AND apns_device_token IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
  ).get(sessionId) as { id: string } | undefined;
  return row?.id ?? null;
}

// --- Users ---

/** Upsert user on first auth */
export function upsertUser(params: {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}) {
  return () => {
    const db = getDbRaw();
    const ts = now();
    db.prepare(`
      INSERT INTO users (id, email, name, avatar_url, last_login_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        name = COALESCE(excluded.name, users.name),
        avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
        last_login_at = excluded.last_login_at,
        updated_at = excluded.updated_at
    `).run(params.id, params.email, params.name ?? null, params.avatarUrl ?? null, ts, ts, ts);
  };
}

// --- Session Viewers ---

/** Track viewer connection */
export function addViewer(params: {
  id: string;
  sessionId: string;
  userId?: string;
  clientIp?: string;
}) {
  return () => {
    const db = getDbRaw();
    const ts = now();
    db.prepare(`
      INSERT INTO session_viewers (id, session_id, user_id, connected_at, client_ip)
      VALUES (?, ?, ?, ?, ?)
    `).run(params.id, params.sessionId, params.userId ?? null, ts, params.clientIp ?? null);
  };
}

/** Track viewer disconnection */
export function removeViewer(viewerId: string, framesReceived: number, bytesReceived: number) {
  return () => {
    const db = getDbRaw();
    db.prepare(`
      UPDATE session_viewers SET
        disconnected_at = ?,
        frames_received = ?,
        bytes_received = ?
      WHERE id = ?
    `).run(now(), framesReceived, bytesReceived, viewerId);
  };
}

// --- Auth Revocations ---

/** Revoke a session token */
export function revokeToken(params: {
  tokenJti: string;
  userId: string;
  reason?: string;
  expiresAt: string;
}) {
  return () => {
    const db = getDbRaw();
    db.prepare(`
      INSERT INTO auth_revocations (token_jti, user_id, reason, revoked_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(params.tokenJti, params.userId, params.reason ?? null, now(), params.expiresAt);
  };
}

/** Check if a token is revoked (sync, called from auth hot path) */
export function isTokenRevoked(tokenJti: string): boolean {
  const db = getDbRaw();
  const row = db.prepare(
    "SELECT 1 FROM auth_revocations WHERE token_jti = ? AND expires_at > ?"
  ).get(tokenJti, now()) as unknown;
  return row !== null && row !== undefined;
}

// --- Session stats update (periodic) ---

/** Update running session stats from in-memory counters */
export function updateSessionStats(sessionId: string, params: {
  totalFrames: number;
  totalBytes: number;
  peakViewers: number;
  resolutionW?: number;
  resolutionH?: number;
}) {
  return () => {
    const db = getDbRaw();
    db.prepare(`
      UPDATE sessions SET
        total_frames = ?,
        total_bytes = ?,
        peak_viewers = ?,
        resolution_w = COALESCE(?, resolution_w),
        resolution_h = COALESCE(?, resolution_h),
        updated_at = ?
      WHERE id = ?
    `).run(
      params.totalFrames,
      params.totalBytes,
      params.peakViewers,
      params.resolutionW ?? null,
      params.resolutionH ?? null,
      now(),
      sessionId,
    );
  };
}
