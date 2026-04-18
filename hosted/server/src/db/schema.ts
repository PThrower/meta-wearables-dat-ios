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
