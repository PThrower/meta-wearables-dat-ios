# PRD-P003: Data Models & Schema

**Product:** com.mwdat-ios / Relay Platform
**Owner:** @ebowwa
**Status:** Draft
**Last Updated:** 2026-04-18
**Depends On:** PRD-P002 (Database Selection -- SQLite recommended)

---

## Purpose

Define the data models, relationships, and schema for the structured database (SQLite via Drizzle ORM). This schema handles everything R2 cannot efficiently handle: indexed queries, cross-session analytics, device tracking, user/org management.

---

## Entity-Relationship Diagram

```
organizations
  |
  +---< memberships >--- users
  |                         |
  +---< devices             |
  |      |                  |
  |      +---< sessions >---+
  |               |
  |               +---< session_viewers
  |               +---< telemetry_events
  |               +---< alerts
  |
  +---< teams
         |
         +---< team_members >--- users
```

---

## Tables

### `organizations`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | UUID |
| name | TEXT | NOT NULL, UNIQUE | Organization display name |
| slug | TEXT | NOT NULL, UNIQUE | URL-safe identifier |
| plan | TEXT | DEFAULT 'free' | 'free', 'pilot', 'pro', 'enterprise' |
| settings | TEXT | DEFAULT '{}' | JSON blob for org-level config |
| created_at | TEXT | NOT NULL | ISO timestamp |
| updated_at | TEXT | NOT NULL | ISO timestamp |

### `users`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | Google OAuth `sub` |
| email | TEXT | NOT NULL, UNIQUE | Google email |
| name | TEXT | | Display name |
| avatar_url | TEXT | | Google profile picture |
| role | TEXT | DEFAULT 'viewer' | Global role: 'admin', 'operator', 'viewer' |
| last_login_at | TEXT | | ISO timestamp |
| created_at | TEXT | NOT NULL | ISO timestamp |
| updated_at | TEXT | NOT NULL | ISO timestamp |

### `memberships`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | UUID |
| user_id | TEXT | FK → users.id, NOT NULL | |
| org_id | TEXT | FK → organizations.id, NOT NULL | |
| role | TEXT | DEFAULT 'member' | 'admin', 'member', 'viewer' |
| joined_at | TEXT | NOT NULL | ISO timestamp |

UNIQUE(user_id, org_id)

### `teams`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | UUID |
| org_id | TEXT | FK → organizations.id, NOT NULL | |
| name | TEXT | NOT NULL | Team display name |
| created_at | TEXT | NOT NULL | ISO timestamp |

### `team_members`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| team_id | TEXT | FK → teams.id, NOT NULL | |
| user_id | TEXT | FK → users.id, NOT NULL | |
| role | TEXT | DEFAULT 'member' | 'lead', 'member' |

PK(team_id, user_id)

### `devices`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | Device hardware ID |
| name | TEXT | | Human-readable name ("Starlink") |
| model | TEXT | | "iPhone13,4", "iPhone14,2" etc. |
| system_version | TEXT | | iOS version |
| wearable_type | TEXT | | "ray-ban-meta" |
| wearable_id | TEXT | | Glasses serial/ID |
| assigned_user_id | TEXT | FK → users.id, NULL | Currently assigned worker |
| org_id | TEXT | FK → organizations.id, NULL | Owning organization |
| app_version | TEXT | | iOS app version |
| build_number | TEXT | | iOS build number |
| last_seen_at | TEXT | | ISO timestamp of last connection |
| last_session_id | TEXT | | Most recent session ID |
| status | TEXT | DEFAULT 'unknown' | 'online', 'standby', 'offline', 'unknown' |
| battery_level | INTEGER | | 0-100, if reported |
| created_at | TEXT | NOT NULL | First seen timestamp |
| updated_at | TEXT | NOT NULL | ISO timestamp |

Indexes: `idx_devices_org_id`, `idx_devices_assigned_user_id`, `idx_devices_status`, `idx_devices_last_seen`

### `sessions`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | Session UUID |
| recording_id | TEXT | UNIQUE | Stable R2 prefix (survives reconnections) |
| publisher_user_id | TEXT | FK → users.id, NULL | Who was streaming |
| publisher_device_id | TEXT | FK → devices.id, NULL | Which device |
| org_id | TEXT | FK → organizations.id, NULL | Owning org |
| status | TEXT | DEFAULT 'active' | 'active', 'standby', 'ended', 'expired' |
| access_level | TEXT | DEFAULT 'link' | 'public', 'link', 'private' |
| started_at | TEXT | NOT NULL | ISO timestamp |
| ended_at | TEXT | | ISO timestamp |
| duration_ms | INTEGER | | Computed on finish |
| total_frames | INTEGER | DEFAULT 0 | |
| total_bytes | INTEGER | DEFAULT 0 | |
| audio_chunks | INTEGER | DEFAULT 0 | |
| peak_viewers | INTEGER | DEFAULT 0 | |
| resolution_w | INTEGER | | |
| resolution_h | INTEGER | | |
| avg_fps | REAL | | Computed from manifest |
| audio_sample_rate | INTEGER | | Dominant sample rate |
| r2_meta_written | INTEGER | DEFAULT 0 | 1 if meta.json written to R2 |
| notes | TEXT | | Free-text notes |
| created_at | TEXT | NOT NULL | ISO timestamp |
| updated_at | TEXT | NOT NULL | ISO timestamp |

Indexes: `idx_sessions_publisher_user_id`, `idx_sessions_publisher_device_id`, `idx_sessions_org_id`, `idx_sessions_status`, `idx_sessions_started_at`, `idx_sessions_ended_at`

### `session_acls`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| session_id | TEXT | FK → sessions.id, NOT NULL | |
| user_id | TEXT | FK → users.id, NOT NULL | |
| email | TEXT | NOT NULL | Denormalized for fast lookup |
| role | TEXT | NOT NULL | 'owner', 'editor', 'viewer' |

PK(session_id, user_id)

### `session_viewers`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | UUID |
| session_id | TEXT | FK → sessions.id, NOT NULL | |
| user_id | TEXT | FK → users.id, NULL | NULL for anonymous viewers |
| connected_at | TEXT | NOT NULL | ISO timestamp |
| disconnected_at | TEXT | | ISO timestamp |
| frames_received | INTEGER | DEFAULT 0 | |
| bytes_received | INTEGER | DEFAULT 0 | |
| client_ip | TEXT | | For diagnostics |

### `auth_revocations`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| token_jti | TEXT | PK | JWT ID of revoked token |
| user_id | TEXT | NOT NULL | Who was revoked |
| reason | TEXT | | 'logout', 'admin', 'security' |
| revoked_at | TEXT | NOT NULL | ISO timestamp |
| expires_at | TEXT | NOT NULL | When the token naturally expires (cleanup) |

Index: `idx_auth_revocations_expires_at` (for cleanup of expired revocations)

### `share_tokens`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| token | TEXT | PK | Random share token |
| session_id | TEXT | FK → sessions.id, NOT NULL | |
| role | TEXT | DEFAULT 'viewer' | 'viewer' only for now |
| created_by | TEXT | FK → users.id, NOT NULL | |
| created_at | TEXT | NOT NULL | ISO timestamp |
| expires_at | TEXT | | NULL = never |
| revoked | INTEGER | DEFAULT 0 | Boolean |
| use_count | INTEGER | DEFAULT 0 | Times the link was used |

Index: `idx_share_tokens_session_id`, `idx_share_tokens_expires_at`

### `telemetry_counters`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| key | TEXT | PK | Counter name (e.g., 'total_frames_relayed') |
| value | INTEGER | NOT NULL | Current value |
| updated_at | TEXT | NOT NULL | ISO timestamp |

Counters:

| Key | Description |
|-----|-------------|
| sessions_started | Total sessions ever started |
| total_frames_relayed | Total FRLY frames relayed |
| total_dropped_frames | Frames dropped due to no viewers |
| peak_concurrent_viewers | All-time peak |
| viewers_rejected | Viewer connections rejected |
| publisher_reconnects | Publisher reconnection events |
| frames_throttled_wasm | Frames dropped by WASM throttle |
| frames_throttled_quality | Frames dropped by quality filter |

### `alerts`

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PK | UUID |
| session_id | TEXT | FK → sessions.id, NULL | |
| device_id | TEXT | FK → devices.id, NULL | |
| org_id | TEXT | FK → organizations.id, NULL | |
| type | TEXT | NOT NULL | 'device_offline', 'high_latency', 'error_rate', 'battery_low', 'custom' |
| severity | TEXT | DEFAULT 'info' | 'info', 'warning', 'critical' |
| message | TEXT | NOT NULL | Human-readable alert text |
| metadata | TEXT | DEFAULT '{}' | JSON blob with alert-specific data |
| acknowledged_by | TEXT | FK → users.id, NULL | Who acknowledged it |
| acknowledged_at | TEXT | | ISO timestamp |
| created_at | TEXT | NOT NULL | ISO timestamp |

Index: `idx_alerts_org_id`, `idx_alerts_type`, `idx_alerts_severity`, `idx_alerts_created_at`

---

## Drizzle Schema Example

```typescript
// src/db/schema.ts
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").default("free"),
  settings: text("settings").default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // Google sub
  email: text("email").notNull().unique(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  role: text("role").default("viewer"),
  lastLoginAt: text("last_login_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
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
  status: text("status").default("unknown"),
  batteryLevel: integer("battery_level"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  recordingId: text("recording_id").unique(),
  publisherUserId: text("publisher_user_id").references(() => users.id),
  publisherDeviceId: text("publisher_device_id").references(() => devices.id),
  orgId: text("org_id").references(() => organizations.id),
  status: text("status").default("active"),
  accessLevel: text("access_level").default("link"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  durationMs: integer("duration_ms"),
  totalFrames: integer("total_frames").default(0),
  totalBytes: integer("total_bytes").default(0),
  audioChunks: integer("audio_chunks").default(0),
  peakViewers: integer("peak_viewers").default(0),
  resolutionW: integer("resolution_w"),
  resolutionH: integer("resolution_h"),
  avgFps: real("avg_fps"),
  audioSampleRate: integer("audio_sample_rate"),
  r2MetaWritten: integer("r2_meta_written").default(0),
  notes: text("notes"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const authRevocations = sqliteTable("auth_revocations", {
  tokenJti: text("token_jti").primaryKey(),
  userId: text("user_id").notNull(),
  reason: text("reason"),
  revokedAt: text("revoked_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const telemetryCounters = sqliteTable("telemetry_counters", {
  key: text("key").primaryKey(),
  value: integer("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});
```

---

## Data Flow: Dual-Write Pattern

The relay server writes to both R2 and SQLite in parallel:

```
Publisher connects
       |
       v
  1. SQLite: INSERT INTO sessions (id, recording_id, publisher_device_id, ...)
  2. SQLite: INSERT INTO devices (id, ...) ON CONFLICT UPDATE last_seen_at, status='online'
       |
       v
  Session active (frames flowing)
       |
       +---> R2: appendVideo(), appendAudio() (existing)
       +---> SQLite: UPDATE sessions SET total_frames += 1, total_bytes += N  (batch every 60s)
       +---> SQLite: UPDATE telemetry_counters SET value += 1 WHERE key='total_frames_relayed'
       |
       v
  Session ends
       |
       +---> R2: finalize() -- write meta.json, manifest.json (existing)
       +---> SQLite: UPDATE sessions SET status='ended', ended_at=now, duration_ms=...
       +---> SQLite: UPDATE devices SET status='standby' WHERE id=deviceId
```

### Write Frequency

| Event | R2 Write | SQLite Write |
|-------|---------|-------------|
| Publisher connect | (none) | INSERT session, UPSERT device |
| Every 10s (flush) | PUT video/audio segments | (none) |
| Every 60s (stats) | (none) | UPDATE session counters |
| Guidance event | (buffered, flush every 10s) | (none -- stays in R2) |
| Annotation | (immediate) | (none -- stays in R2) |
| Session end | PUT meta.json, manifest.json | UPDATE session |
| Viewer connect | (none) | INSERT session_viewer |
| Viewer disconnect | (none) | UPDATE session_viewer |

SQLite write volume is low -- a few writes per session lifecycle, not per-frame. This keeps the single-writer SQLite constraint irrelevant.

---

## Query Examples

### Gallery (replaces R2 gallery index scan)

```sql
SELECT s.id, s.started_at, s.duration_ms, s.total_frames,
       d.name as device_name, d.model as device_model,
       u.name as publisher_name
FROM sessions s
LEFT JOIN devices d ON s.publisher_device_id = d.id
LEFT JOIN users u ON s.publisher_user_id = u.id
WHERE s.org_id = ?
  AND s.status = 'ended'
ORDER BY s.started_at DESC
LIMIT 50;
```

### Device fleet status (operator dashboard)

```sql
SELECT d.id, d.name, d.model, d.status, d.last_seen_at,
       u.name as assigned_user,
       s.id as active_session_id
FROM devices d
LEFT JOIN users u ON d.assigned_user_id = u.id
LEFT JOIN sessions s ON d.last_session_id = s.id AND s.status = 'active'
WHERE d.org_id = ?
ORDER BY d.status, d.last_seen_at DESC;
```

### Session analytics

```sql
SELECT DATE(s.started_at) as date,
       COUNT(*) as sessions,
       SUM(s.total_frames) as frames,
       SUM(s.duration_ms) / 3600000.0 as hours
FROM sessions s
WHERE s.org_id = ?
  AND s.started_at >= ?
GROUP BY DATE(s.started_at)
ORDER BY date DESC;
```

### Auth revocation check (replaces in-memory Set)

```sql
SELECT 1 FROM auth_revocations
WHERE token_jti = ? AND expires_at > datetime('now');
```

---

## Migration from R2-Only

The transition is additive, not destructive:

1. **Phase 1:** Deploy SQLite alongside R2. On session start/end, write to both. Gallery still reads from R2.
2. **Phase 2:** Backfill SQLite from existing R2 `meta.json` files (one-time script).
3. **Phase 3:** Switch gallery reads to SQLite. R2 gallery index code becomes fallback.
4. **Phase 4:** Add device/user/org tables. Wire up on publisher connect/viewer auth.

No data is deleted from R2 during migration. The R2 structure remains the source of truth for binary data.

---

## Package Structure

```
hosted/server/
  src/
    db/
      schema.ts        -- Drizzle schema definitions
      migrate.ts        -- Migration runner
      connection.ts     -- bun:sqlite + Drizzle setup
      queries/
        sessions.ts     -- Session CRUD
        devices.ts      -- Device registry queries
        users.ts        -- User management queries
        analytics.ts    -- Aggregate analytics queries
        auth.ts         -- Revocation list queries
      migrations/
        0001_initial.sql
        0002_organizations.sql
        ...
```
