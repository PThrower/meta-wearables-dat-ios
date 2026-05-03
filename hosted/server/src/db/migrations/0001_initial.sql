-- 0001_initial.sql — Core tables for structured persistence
-- Binary data (video, audio, exports) stays in R2. This handles indexed metadata.

-- Users: populated on first Google OAuth login
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Organizations: companies/teams using the platform
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free',
  settings TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Memberships: user-org relationships
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL,
  UNIQUE(user_id, org_id)
);

-- Teams: sub-groups within organizations
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Team members
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (team_id, user_id)
);

-- Devices: hardware that connects to the relay
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT,
  model TEXT,
  system_version TEXT,
  wearable_type TEXT,
  wearable_id TEXT,
  assigned_user_id TEXT REFERENCES users(id),
  org_id TEXT REFERENCES organizations(id),
  app_version TEXT,
  build_number TEXT,
  last_seen_at TEXT,
  last_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  battery_level INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_org ON devices(org_id);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);

-- Sessions: indexed metadata for fast gallery/analytics queries
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  recording_id TEXT UNIQUE,
  publisher_user_id TEXT REFERENCES users(id),
  publisher_device_id TEXT REFERENCES devices(id),
  org_id TEXT REFERENCES organizations(id),
  status TEXT NOT NULL DEFAULT 'active',
  access_level TEXT NOT NULL DEFAULT 'link',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  total_frames INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  audio_chunks INTEGER NOT NULL DEFAULT 0,
  peak_viewers INTEGER NOT NULL DEFAULT 0,
  resolution_w INTEGER,
  resolution_h INTEGER,
  avg_fps REAL,
  audio_sample_rate INTEGER,
  r2_meta_written INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(publisher_user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(publisher_device_id);
CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

-- Session ACLs: per-session access control list
CREATE TABLE IF NOT EXISTS session_acls (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  UNIQUE(session_id, user_id)
);

-- Session viewers: connection tracking
CREATE TABLE IF NOT EXISTS session_viewers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  user_id TEXT REFERENCES users(id),
  connected_at TEXT NOT NULL,
  disconnected_at TEXT,
  frames_received INTEGER NOT NULL DEFAULT 0,
  bytes_received INTEGER NOT NULL DEFAULT 0,
  client_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_viewers_session ON session_viewers(session_id);

-- Auth revocations: survives server restart
CREATE TABLE IF NOT EXISTS auth_revocations (
  token_jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reason TEXT,
  revoked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revocations_expires ON auth_revocations(expires_at);

-- Share tokens
CREATE TABLE IF NOT EXISTS share_tokens (
  token TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_session ON share_tokens(session_id);
CREATE INDEX IF NOT EXISTS idx_share_tokens_expires ON share_tokens(expires_at);

-- Telemetry counters: cumulative, survives restart
CREATE TABLE IF NOT EXISTS telemetry_counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- Seed telemetry counters
INSERT OR IGNORE INTO telemetry_counters (key, value, updated_at) VALUES
  ('sessions_started', 0, datetime('now')),
  ('total_frames_relayed', 0, datetime('now')),
  ('total_dropped_frames', 0, datetime('now')),
  ('peak_concurrent_viewers', 0, datetime('now')),
  ('viewers_rejected', 0, datetime('now')),
  ('publisher_reconnects', 0, datetime('now')),
  ('frames_throttled_wasm', 0, datetime('now')),
  ('frames_throttled_quality', 0, datetime('now'));

-- Alerts
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  device_id TEXT REFERENCES devices(id),
  org_id TEXT REFERENCES organizations(id),
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  acknowledged_by TEXT REFERENCES users(id),
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_org ON alerts(org_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
