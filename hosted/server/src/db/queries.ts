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
  batteryLevel?: number;
  status?: string;
  lastSessionId?: string;
}) {
  return () => {
    const db = getDbRaw();
    const ts = now();
    db.prepare(`
      INSERT INTO devices (id, name, model, system_version, wearable_type, wearable_id, app_version, build_number, battery_level, status, last_seen_at, last_session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = COALESCE(excluded.name, devices.name),
        model = COALESCE(excluded.model, devices.model),
        system_version = COALESCE(excluded.system_version, devices.system_version),
        wearable_type = COALESCE(excluded.wearable_type, devices.wearable_type),
        wearable_id = COALESCE(excluded.wearable_id, devices.wearable_id),
        app_version = COALESCE(excluded.app_version, devices.app_version),
        build_number = COALESCE(excluded.build_number, devices.build_number),
        battery_level = COALESCE(excluded.battery_level, devices.battery_level),
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
      params.batteryLevel ?? null,
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

/** List all known devices with full metadata for the fleet dashboard */
export function listAllDevices(): Array<{
  id: string;
  name: string | null;
  model: string | null;
  systemVersion: string | null;
  wearableType: string | null;
  appVersion: string | null;
  buildNumber: string | null;
  batteryLevel: number | null;
  status: string | null;
  lastSeenAt: string | null;
  hasApnsToken: boolean;
}> {
  const db = getDbRaw();
  return db.prepare(`
    SELECT id, name, model, system_version, wearable_type, app_version, build_number,
      battery_level, status, last_seen_at,
      CASE WHEN apns_device_token IS NOT NULL AND length(apns_device_token) > 10 THEN 1 ELSE 0 END as hasApnsToken
    FROM devices
    ORDER BY updated_at DESC
  `).all() as any[];
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

// --- Workflows ---

/** Insert a new workflow with its nodes and edges */
export function insertWorkflow(params: {
  id: string;
  name: string;
  description?: string;
  ownerId?: string;
  status?: string;
  canvasViewport?: string;
  nodes: Array<{ id: string; type: string; label?: string; config?: string; positionX?: number; positionY?: number }>;
  edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
}) {
  return () => {
    const db = getDbRaw();
    const ts = now();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO workflows (id, name, description, owner_id, status, canvas_viewport, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.id,
        params.name,
        params.description ?? "",
        params.ownerId ?? null,
        params.status ?? "draft",
        params.canvasViewport ?? '{"x":0,"y":0,"zoom":1}',
        ts,
        ts,
      );
      const nodeStmt = db.prepare(
        "INSERT INTO workflow_nodes (id, workflow_id, type, label, config, position_x, position_y) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const n of params.nodes) {
        nodeStmt.run(n.id, params.id, n.type, n.label ?? "", n.config ?? "{}", n.positionX ?? 0, n.positionY ?? 0);
      }
      const edgeStmt = db.prepare(
        "INSERT INTO workflow_edges (id, workflow_id, source_node_id, target_node_id) VALUES (?, ?, ?, ?)"
      );
      for (const e of params.edges) {
        edgeStmt.run(e.id, params.id, e.sourceNodeId, e.targetNodeId);
      }
    })();
  };
}

/** Update workflow metadata and replace nodes/edges atomically */
export function updateWorkflow(id: string, params: {
  name?: string;
  description?: string;
  status?: string;
  canvasViewport?: string;
  flowConfig?: string | null;
  settings?: string | null;
  nodes?: Array<{ id: string; type: string; label?: string; config?: string; positionX?: number; positionY?: number }>;
  edges?: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
}) {
  return () => {
    const db = getDbRaw();
    const ts = now();
    db.transaction(() => {
      // Build dynamic SET clause — only update flow_config when explicitly provided
      const setParts = [
        "name = COALESCE(?, name)",
        "description = COALESCE(?, description)",
        "status = COALESCE(?, status)",
        "canvas_viewport = COALESCE(?, canvas_viewport)",
        "updated_at = ?",
      ];
      const values: (string | null)[] = [
        params.name ?? null,
        params.description ?? null,
        params.status ?? null,
        params.canvasViewport ?? null,
        ts,
      ];

      if (params.flowConfig !== undefined) {
        setParts.splice(4, 0, "flow_config = ?");
        values.splice(4, 0, params.flowConfig ?? null);
      }

      if (params.settings !== undefined) {
        setParts.splice(5, 0, "settings = ?");
        values.splice(5, 0, params.settings ?? null);
      }

      db.prepare(`UPDATE workflows SET ${setParts.join(", ")} WHERE id = ?`)
        .run(...values, id);

      if (params.nodes) {
        db.prepare("DELETE FROM workflow_nodes WHERE workflow_id = ?").run(id);
        const nodeStmt = db.prepare(
          "INSERT INTO workflow_nodes (id, workflow_id, type, label, config, position_x, position_y) VALUES (?, ?, ?, ?, ?, ?, ?)"
        );
        for (const n of params.nodes) {
          nodeStmt.run(n.id, id, n.type, n.label ?? "", n.config ?? "{}", n.positionX ?? 0, n.positionY ?? 0);
        }
      }
      if (params.edges) {
        db.prepare("DELETE FROM workflow_edges WHERE workflow_id = ?").run(id);
        const edgeStmt = db.prepare(
          "INSERT INTO workflow_edges (id, workflow_id, source_node_id, target_node_id) VALUES (?, ?, ?, ?)"
        );
        for (const e of params.edges) {
          edgeStmt.run(e.id, id, e.sourceNodeId, e.targetNodeId);
        }
      }
    })();
  };
}

/** Delete a workflow (CASCADE removes nodes + edges) */
export function deleteWorkflow(id: string) {
  return () => {
    const db = getDbRaw();
    db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  };
}

/** Get a single workflow by ID */
export function getWorkflow(id: string): {
  id: string; name: string; description: string; ownerId: string | null;
  status: string; canvasViewport: string; flowConfig: string | null; settings: string | null; createdAt: string; updatedAt: string;
} | null {
  const db = getDbRaw();
  return db.prepare(`
    SELECT id, name, description, owner_id as ownerId, status,
      canvas_viewport as canvasViewport, flow_config as flowConfig, settings,
      created_at as createdAt, updated_at as updatedAt
    FROM workflows WHERE id = ?
  `).get(id) as any ?? null;
}

/** List all workflows with node counts */
export function listWorkflows(): Array<{
  id: string; name: string; description: string; status: string;
  ownerId: string | null; nodeCount: number; updatedAt: string;
}> {
  const db = getDbRaw();
  return db.prepare(`
    SELECT w.id, w.name, w.description, w.status, w.owner_id as ownerId,
      COUNT(n.id) as nodeCount, w.updated_at as updatedAt
    FROM workflows w
    LEFT JOIN workflow_nodes n ON n.workflow_id = w.id
    GROUP BY w.id
    ORDER BY w.updated_at DESC
  `).all() as any[];
}

/** Get all nodes for a workflow */
export function getWorkflowNodes(workflowId: string): Array<{
  id: string; workflowId: string; type: string; label: string;
  config: string; positionX: number; positionY: number;
}> {
  const db = getDbRaw();
  return db.prepare(`
    SELECT id, workflow_id as workflowId, type, label, config,
      position_x as positionX, position_y as positionY
    FROM workflow_nodes WHERE workflow_id = ?
  `).all(workflowId) as any[];
}

/** Get all edges for a workflow */
export function getWorkflowEdges(workflowId: string): Array<{
  id: string; workflowId: string; sourceNodeId: string; targetNodeId: string;
}> {
  const db = getDbRaw();
  return db.prepare(`
    SELECT id, workflow_id as workflowId,
      source_node_id as sourceNodeId, target_node_id as targetNodeId
    FROM workflow_edges WHERE workflow_id = ?
  `).all(workflowId) as any[];
}

// --- Session State Machine ---

/** Update session state (new state machine). Maps to legacy status column too. */
export function updateSessionState(sessionId: string, state: string, dropReason?: string) {
  return () => {
    const db = getDbRaw();
    const ts = now();
    // Map new state to legacy status
    const legacyStatus = state === "paused" ? "standby"
      : state === "ended" ? "ended"
      : state === "expired" ? "expired"
      : "active";
    db.prepare(`
      UPDATE sessions SET state = ?, state_entered_at = ?, drop_reason = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(state, ts, dropReason ?? null, legacyStatus, ts, sessionId);
  };
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

// --- Activation Audit Log ---

/** Get the current active activation for a session (for conflict detection) */
export function getActiveActivation(sessionId: string): {
  id: string;
  sessionId: string;
  workflowId: string | null;
  appId: string | null;
  activatedBy: string | null;
  activatedAt: string;
} | null {
  const db = getDbRaw();
  return db.prepare(`
    SELECT id, session_id as sessionId, workflow_id as workflowId,
      app_id as appId, activated_by as activatedBy, activated_at as activatedAt
    FROM activation_log
    WHERE session_id = ? AND status = 'active'
    ORDER BY activated_at DESC LIMIT 1
  `).get(sessionId) as any ?? null;
}

/** Get the current active activation for a workflow (for stream control) */
export function getActiveActivationForWorkflow(workflowId: string): {
  id: string;
  sessionId: string;
  workflowId: string;
  appId: string | null;
  activatedAt: string;
} | null {
  const db = getDbRaw();
  return db.prepare(`
    SELECT id, session_id as sessionId, workflow_id as workflowId,
      app_id as appId, activated_at as activatedAt
    FROM activation_log
    WHERE workflow_id = ? AND status = 'active'
      AND overridden_at IS NULL
    ORDER BY activated_at DESC LIMIT 1
  `).get(workflowId) as any ?? null;
}

/** Insert a new activation log entry */
export function insertActivation(params: {
  id: string;
  sessionId: string;
  workflowId?: string;
  appId?: string;
  activatedBy?: string;
  overrodeAppId?: string;
  reason?: string;
}) {
  return () => {
    const db = getDbRaw();
    const ts = now();
    db.prepare(`
      INSERT INTO activation_log (id, session_id, workflow_id, app_id, activated_by, overrode_app_id, reason, status, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(
      params.id,
      params.sessionId,
      params.workflowId ?? null,
      params.appId ?? null,
      params.activatedBy ?? null,
      params.overrodeAppId ?? null,
      params.reason ?? null,
      ts,
    );
  };
}

/** Mark previous activation as overridden (for override flow) */
export function overrideActivation(activationId: string, deactivatedBy: string) {
  return () => {
    const db = getDbRaw();
    db.prepare(`
      UPDATE activation_log SET
        status = 'overridden',
        deactivated_by = ?,
        deactivated_at = ?
      WHERE id = ?
    `).run(deactivatedBy, now(), activationId);
  };
}

/** Deactivate the current activation for a session (normal deactivation) */
export function deactivateActivation(sessionId: string, deactivatedBy: string) {
  return () => {
    const db = getDbRaw();
    db.prepare(`
      UPDATE activation_log SET
        status = 'deactivated',
        deactivated_by = ?,
        deactivated_at = ?
      WHERE session_id = ? AND status = 'active'
    `).run(deactivatedBy, now(), sessionId);
  };
}

// --- Device Build History ---

/** Record a build sighting — upsert on (device_id, app_version, build_number) */
export function recordBuildSighting(params: {
  deviceId: string;
  appVersion: string;
  buildNumber: string;
}) {
  return () => {
    const db = getDbRaw();
    const ts = now();
    const id = `${params.deviceId}-${params.appVersion}-${params.buildNumber}`;
    db.prepare(`
      INSERT INTO device_build_history (id, device_id, app_version, build_number, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id, app_version, build_number) DO UPDATE SET
        last_seen_at = excluded.last_seen_at
    `).run(id, params.deviceId, params.appVersion, params.buildNumber, ts, ts);
  };
}

// --- Device Deletion ---

/** Delete a single device and its build history. Nullifies FK references in sessions/alerts. */
export function deleteDevice(deviceId: string) {
  return () => {
    const db = getDbRaw();
    db.transaction(() => {
      db.prepare("UPDATE sessions SET publisher_device_id = NULL WHERE publisher_device_id = ?").run(deviceId);
      db.prepare("UPDATE alerts SET device_id = NULL WHERE device_id = ?").run(deviceId);
      db.prepare("DELETE FROM device_build_history WHERE device_id = ?").run(deviceId);
      db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
    })();
  };
}

/** Bulk delete devices and their build history. */
export function deleteDevices(deviceIds: string[]) {
  return () => {
    const db = getDbRaw();
    db.transaction(() => {
      for (const id of deviceIds) {
        db.prepare("UPDATE sessions SET publisher_device_id = NULL WHERE publisher_device_id = ?").run(id);
        db.prepare("UPDATE alerts SET device_id = NULL WHERE device_id = ?").run(id);
        db.prepare("DELETE FROM device_build_history WHERE device_id = ?").run(id);
        db.prepare("DELETE FROM devices WHERE id = ?").run(id);
      }
    })();
  };
}

/** Get build history for a specific device */
export function getDeviceBuildHistory(deviceId: string): Array<{
  appVersion: string;
  buildNumber: string;
  firstSeenAt: string;
  lastSeenAt: string;
}> {
  const db = getDbRaw();
  return db.prepare(`
    SELECT app_version as appVersion, build_number as buildNumber,
      first_seen_at as firstSeenAt, last_seen_at as lastSeenAt
    FROM device_build_history
    WHERE device_id = ?
    ORDER BY last_seen_at DESC
  `).all(deviceId) as any[];
}

// --- Node Execution Log ---

/** Insert a node execution log entry */
export function insertNodeExecutionLog(params: {
  id: string;
  sessionId: string;
  workflowId: string;
  nodeId: string;
  appId?: string;
  nodeType: string;
  state: string;
  action: string;
  error?: string;
  triggeredBy?: string;
}) {
  return () => {
    const db = getDbRaw();
    db.prepare(`
      INSERT INTO node_execution_log (id, session_id, workflow_id, node_id, app_id, node_type, state, action, error, triggered_by, timestamp_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.id,
      params.sessionId,
      params.workflowId,
      params.nodeId,
      params.appId ?? null,
      params.nodeType,
      params.state,
      params.action,
      params.error ?? null,
      params.triggeredBy ?? null,
      Date.now(),
    );
  };
}

/** Get recent node execution log entries for a session */
export function getNodeExecutionLog(sessionId: string, limit = 100): Array<{
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
}> {
  const db = getDbRaw();
  return db.prepare(`
    SELECT id, session_id as sessionId, workflow_id as workflowId, node_id as nodeId,
      app_id as appId, node_type as nodeType, state, action, error,
      triggered_by as triggeredBy, timestamp_ms as timestampMs
    FROM node_execution_log
    WHERE session_id = ?
    ORDER BY timestamp_ms DESC
    LIMIT ?
  `).all(sessionId, limit) as any[];
}
