/**
 * schema.ts — Drizzle ORM schema for caringmind-frame-relay
 *
 * SQLite tables for structured data that R2 cannot efficiently handle:
 * session metadata, device registry, users, auth revocations, telemetry.
 *
 * Binary data (video segments, audio chunks, MP4 exports) stays in R2.
 */

import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";

// --- Users ---

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),             // Google OAuth sub
  email: text("email").notNull().unique(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  role: text("role").notNull().default("viewer"),  // admin, operator, viewer
  lastLoginAt: text("last_login_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// --- Organizations ---

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("free"),  // free, pilot, pro, enterprise
  settings: text("settings").default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const memberships = sqliteTable("memberships", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  role: text("role").notNull().default("member"),  // admin, member, viewer
  joinedAt: text("joined_at").notNull(),
}, (t) => [
  uniqueIndex("idx_memberships_user_org").on(t.userId, t.orgId),
]);

// --- Teams ---

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const teamMembers = sqliteTable("team_members", {
  teamId: text("team_id").notNull().references(() => teams.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull().default("member"),  // lead, member
}, (t) => [
  index("idx_team_members_team").on(t.teamId),
]);

// --- Devices ---

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),             // Hardware device ID
  name: text("name"),
  model: text("model"),
  systemVersion: text("system_version"),
  wearableType: text("wearable_type"),
  wearableId: text("wearable_id"),
  assignedUserId: text("assigned_user_id").references(() => users.id),
  orgId: text("org_id").references(() => organizations.id),
  appVersion: text("app_version"),
  buildNumber: text("build_number"),
  lastSeenAt: text("last_seen_at"),
  lastSessionId: text("last_session_id"),
  status: text("status").notNull().default("unknown"),  // online, standby, offline, unknown
  batteryLevel: integer("battery_level"),
  apnsDeviceToken: text("apns_device_token"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idx_devices_org").on(t.orgId),
  index("idx_devices_user").on(t.assignedUserId),
  index("idx_devices_status").on(t.status),
  index("idx_devices_last_seen").on(t.lastSeenAt),
]);

// --- Sessions ---

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  recordingId: text("recording_id").unique(),  // Stable R2 prefix
  publisherUserId: text("publisher_user_id").references(() => users.id),
  publisherDeviceId: text("publisher_device_id").references(() => devices.id),
  orgId: text("org_id").references(() => organizations.id),
  status: text("status").notNull().default("active"),  // active, standby, ended, expired
  accessLevel: text("access_level").notNull().default("link"),  // public, link, private
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  durationMs: integer("duration_ms"),
  totalFrames: integer("total_frames").notNull().default(0),
  totalBytes: integer("total_bytes").notNull().default(0),
  audioChunks: integer("audio_chunks").notNull().default(0),
  peakViewers: integer("peak_viewers").notNull().default(0),
  resolutionW: integer("resolution_w"),
  resolutionH: integer("resolution_h"),
  avgFps: real("avg_fps"),
  audioSampleRate: integer("audio_sample_rate"),
  r2MetaWritten: integer("r2_meta_written").notNull().default(0),
  notes: text("notes"),
  state: text("state").notNull().default("active"),  // created, standby, active, paused, orphaned, ended, expired
  stateEnteredAt: text("state_entered_at"),
  dropReason: text("drop_reason"),
  ephemeral: integer("ephemeral").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idx_sessions_user").on(t.publisherUserId),
  index("idx_sessions_device").on(t.publisherDeviceId),
  index("idx_sessions_org").on(t.orgId),
  index("idx_sessions_status").on(t.status),
  index("idx_sessions_started").on(t.startedAt),
]);

// --- Session ACLs ---

export const sessionAcls = sqliteTable("session_acls", {
  sessionId: text("session_id").notNull().references(() => sessions.id),
  userId: text("user_id").notNull().references(() => users.id),
  email: text("email").notNull(),
  role: text("role").notNull(),  // owner, editor, viewer
}, (t) => [
  uniqueIndex("idx_session_acls_pk").on(t.sessionId, t.userId),
]);

// --- Session Viewers ---

export const sessionViewers = sqliteTable("session_viewers", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  userId: text("user_id").references(() => users.id),
  connectedAt: text("connected_at").notNull(),
  disconnectedAt: text("disconnected_at"),
  framesReceived: integer("frames_received").notNull().default(0),
  bytesReceived: integer("bytes_received").notNull().default(0),
  clientIp: text("client_ip"),
}, (t) => [
  index("idx_viewers_session").on(t.sessionId),
]);

// --- Auth Revocations ---

export const authRevocations = sqliteTable("auth_revocations", {
  tokenJti: text("token_jti").primaryKey(),
  userId: text("user_id").notNull(),
  reason: text("reason"),
  revokedAt: text("revoked_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (t) => [
  index("idx_revocations_expires").on(t.expiresAt),
]);

// --- Share Tokens ---

export const shareTokens = sqliteTable("share_tokens", {
  token: text("token").primaryKey(),
  sessionId: text("session_id").notNull().references(() => sessions.id),
  role: text("role").notNull().default("viewer"),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  revoked: integer("revoked").notNull().default(0),
  useCount: integer("use_count").notNull().default(0),
}, (t) => [
  index("idx_share_tokens_session").on(t.sessionId),
  index("idx_share_tokens_expires").on(t.expiresAt),
]);

// --- Telemetry Counters ---

export const telemetryCounters = sqliteTable("telemetry_counters", {
  key: text("key").primaryKey(),
  value: integer("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// --- Alerts ---

export const alerts = sqliteTable("alerts", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").references(() => sessions.id),
  deviceId: text("device_id").references(() => devices.id),
  orgId: text("org_id").references(() => organizations.id),
  type: text("type").notNull(),      // device_offline, high_latency, error_rate, battery_low, custom
  severity: text("severity").notNull().default("info"),  // info, warning, critical
  message: text("message").notNull(),
  metadata: text("metadata").default("{}"),
  acknowledgedBy: text("acknowledged_by").references(() => users.id),
  acknowledgedAt: text("acknowledged_at"),
  createdAt: text("created_at").notNull(),
}, (t) => [
  index("idx_alerts_org").on(t.orgId),
  index("idx_alerts_type").on(t.type),
  index("idx_alerts_severity").on(t.severity),
  index("idx_alerts_created").on(t.createdAt),
]);

// --- Workflows ---

export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  ownerId: text("owner_id"),
  status: text("status").notNull().default("draft"),  // draft, published, archived
  canvasViewport: text("canvas_viewport").default('{"x":0,"y":0,"zoom":1}'),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  index("idx_workflows_owner").on(t.ownerId),
  index("idx_workflows_status").on(t.status),
]);

export const workflowNodes = sqliteTable("workflow_nodes", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  type: text("type").notNull(),  // camera-source, phone-mic-source, glasses-mic-source, gesture-source, text, s2s-live, s2s-rest, s2s-e4b, jepa-vision, etc.
  label: text("label").notNull().default(""),
  config: text("config").notNull().default("{}"),
  positionX: real("position_x").notNull().default(0),
  positionY: real("position_y").notNull().default(0),
}, (t) => [
  index("idx_wf_nodes").on(t.workflowId),
]);

export const workflowEdges = sqliteTable("workflow_edges", {
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  sourceNodeId: text("source_node_id").notNull(),
  targetNodeId: text("target_node_id").notNull(),
}, (t) => [
  index("idx_wf_edges").on(t.workflowId),
]);

// --- Activation Audit Log ---

export const activationLog = sqliteTable("activation_log", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  workflowId: text("workflow_id").references(() => workflows.id),
  appId: text("app_id"),                    // Virtual app ID (wf-*)
  activatedBy: text("activated_by"),        // User ID or "system"
  deactivatedBy: text("deactivated_by"),    // User ID or "system" (set on deactivation)
  overrodeAppId: text("overrode_app_id"),   // Previous app ID if this was an override
  reason: text("reason"),                   // Human-readable reason
  status: text("status").notNull().default("active"),  // active, deactivated, overridden, error
  activatedAt: text("activated_at").notNull(),
  deactivatedAt: text("deactivated_at"),
}, (t) => [
  index("idx_activation_log_session").on(t.sessionId),
  index("idx_activation_log_workflow").on(t.workflowId),
  index("idx_activation_log_activated_by").on(t.activatedBy),
  index("idx_activation_log_status").on(t.status),
]);

// --- Node Execution Log ---

export const nodeExecutionLog = sqliteTable("node_execution_log", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  workflowId: text("workflow_id").notNull(),
  nodeId: text("node_id").notNull(),
  appId: text("app_id"),
  nodeType: text("node_type").notNull(),
  state: text("state").notNull(),  // pending, running, paused, completed, skipped, errored, waiting
  action: text("action").notNull(), // activate, pause, resume, stop, skip, redo, continue, error
  error: text("error"),
  triggeredBy: text("triggered_by"), // viewer, publisher, system, auto
  timestampMs: integer("timestamp_ms").notNull(),
}, (t) => [
  index("idx_node_exec_session").on(t.sessionId),
  index("idx_node_exec_workflow").on(t.workflowId),
  index("idx_node_exec_node").on(t.nodeId),
  index("idx_node_exec_timestamp").on(t.timestampMs),
]);

// --- Device Build History ---

export const deviceBuildHistory = sqliteTable("device_build_history", {
  id: text("id").primaryKey(),
  deviceId: text("device_id").notNull().references(() => devices.id),
  appVersion: text("app_version").notNull(),
  buildNumber: text("build_number").notNull(),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (t) => [
  uniqueIndex("idx_build_history_unique").on(t.deviceId, t.appVersion, t.buildNumber),
  index("idx_build_history_device").on(t.deviceId),
  index("idx_build_history_last_seen").on(t.lastSeenAt),
]);
