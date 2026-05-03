# PRD-P004: Migration & Implementation Strategy

**Product:** com.mwdat-ios / Relay Platform
**Owner:** @ebowwa
**Status:** Draft
**Last Updated:** 2026-04-18
**Depends On:** PRD-P002 (SQLite recommended), PRD-P003 (Data Models)

---

## Purpose

Define the phased implementation plan for adding SQLite to the relay server without disrupting the live system. Each phase is independently deployable and reversible.

---

## Guiding Principles

1. **Additive only.** No R2 code is removed during migration. SQLite is added alongside.
2. **Shadow writes first.** Write to both R2 and SQLite before switching reads.
3. **Backfill from R2.** Existing session data in R2 is migrated into SQLite via one-time script.
4. **Feature-flagged reads.** Gallery reads switch to SQLite behind a flag, with R2 fallback.
5. **Zero downtime.** Each phase deploys without stopping the server (Bun hot-reload via Caddy).

---

## Phase 0: Foundation (Prerequisite)

**Goal:** Add `bun:sqlite` and Drizzle ORM to the project.

### Tasks

| Task | Description |
|------|-------------|
| Install Drizzle | `bun add drizzle-orm` + `bun add -d drizzle-kit` |
| Create `src/db/` | schema.ts, connection.ts, migrate.ts |
| Drizzle config | `drizzle.config.ts` pointing to `/var/lib/caringmind/relay.db` |
| Initial migration | `0001_initial.sql` with sessions, devices, auth_revocations, telemetry_counters tables |
| Migration runner | Script that runs pending migrations on server startup |
| Backup cron | Daily: `sqlite3 relay.db ".backup backup.db"` + gzip + `bun run upload-backup.ts` to R2 |
| WAL mode | `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` on connection |

### Acceptance Criteria

- Server starts, creates `relay.db` if not exists, runs migrations
- Empty tables exist, no errors
- Backup cron uploads `.gz` to R2 `backups/relay-YYYY-MM-DD.db.gz`

### Risk: None. No existing code is touched.

---

## Phase 1: Shadow Writes

**Goal:** Every session lifecycle event that currently touches R2 also writes to SQLite.

### Tasks

| Task | Current Code | SQLite Addition |
|------|-------------|-----------------|
| Session create | `SessionRegistry.getOrCreate()` | `db.insert(sessions).values({...})` |
| Publisher claim | `SessionRegistry.claimPublisher()` | `db.insert(devices).values({...}).onConflictUpdate()` + `db.update(sessions).set({publisherDeviceId})` |
| Session activate | `SessionRegistry.activatePublisher()` | `db.update(sessions).set({status: 'active'})` |
| Session end | `SessionRecorder.finish()` | `db.update(sessions).set({status: 'ended', endedAt, durationMs, totalFrames, totalBytes})` |
| Device last seen | `Publisher` connect in `server.ts` | `db.update(devices).set({lastSeenAt, status: 'online'})` |
| Viewer connect | Viewer `open()` in `server.ts` | `db.insert(sessionViewers).values({...})` |
| Viewer disconnect | Viewer `close()` in `server.ts` | `db.update(sessionViewers).set({disconnectedAt, framesReceived})` |
| Counter increment | In-memory vars in `SessionRegistry` | `db.update(telemetryCounters).set({value: sql\`value + 1\`})` batched every 60s |
| Auth revocation | `revokedTokens.add(jti)` in `permissions.ts` | `db.insert(authRevocations).values({tokenJti, ...})` |

### Implementation Approach

Wrap SQLite writes in a `DbWriter` class that:
- Queues writes and batch-commits every 5 seconds (reduces WAL flush frequency)
- Catches and logs SQLite errors without blocking the relay pipeline
- Exposes a `health()` method for monitoring

```typescript
class DbWriter {
  private queue: Array<() => Promise<void>> = [];
  private timer: Timer | null = null;

  enqueue(fn: () => Promise<void>) {
    this.queue.push(fn);
  }

  private async flush() {
    const batch = this.queue.splice(0);
    for (const fn of batch) {
      try { await fn(); }
      catch (e) { console.error("[db] write failed:", e); }
    }
  }

  start() {
    this.timer = setInterval(() => this.flush(), 5_000);
  }
}
```

### Acceptance Criteria

- Deploy to production, stream a session
- Verify SQLite `sessions` table has a row with correct data
- Verify SQLite `devices` table has a row with correct device info
- Verify SQLite `telemetry_counters` table is incrementing
- R2 recording is unaffected (meta.json, segments still written)
- No latency regression on frame relay path

### Rollback: Remove the `DbWriter` calls. No data loss -- R2 is untouched.

---

## Phase 2: Backfill

**Goal:** Migrate all existing R2 session data into SQLite.

### Tasks

| Task | Description |
|------|-------------|
| Backfill script | `bun run backfill-sessions.ts` |
| List all R2 sessions | `store.list("sessions/")` → filter `meta.json` keys |
| Read each `meta.json` | Parallel reads with concurrency limit (50 concurrent) |
| Parse and insert | Map `SessionMeta` → SQLite `sessions` row |
| Extract device data | Map `meta.device` → SQLite `devices` row (upsert) |
| Extract user data | Map `meta.ownerId/ownerEmail` → SQLite `users` row (upsert) |
| Idempotent | Script can be run multiple times (INSERT OR IGNORE on session ID) |
| Verification | Compare R2 session count vs SQLite session count |

### Acceptance Criteria

- All historical sessions from R2 appear in SQLite `sessions` table
- All unique devices appear in SQLite `devices` table
- All unique users (from ownerEmail) appear in SQLite `users` table
- Counts match between R2 listing and SQLite queries

### Rollback: `DELETE FROM sessions WHERE id IN (...)`. Or drop and re-run migration.

---

## Phase 3: Read Switch

**Goal:** Gallery and API endpoints read from SQLite instead of R2.

### Tasks

| Task | Current Code | SQLite Replacement |
|------|-------------|-------------------|
| Gallery listing | `sessionStore.galleryCached()` → R2 scan | `db.select().from(sessions).where(...)` |
| Session list | `sessionStore.getSessionIds()` → R2 scan | `db.select({id: sessions.id}).from(sessions)` |
| Session info | `sessionStore.getMeta()` → R2 GET | `db.select().from(sessions).where({id})` + R2 for binary data |
| Device list | Not possible | `db.select().from(devices).where({orgId})` |
| Auth revocation check | `revokedTokens.has(jti)` in-memory Set | `db.select().from(authRevocations).where({tokenJti})` |
| Stats endpoint | In-memory counters | `db.select().from(telemetryCounters)` |

### Feature Flag

```typescript
const USE_SQLITE_GALLERY = process.env.DB_GALLERY === "true";

async function getGallery(opts) {
  if (USE_SQLITE_GALLERY) {
    return getGalleryFromDb(opts);
  }
  return sessionStore.galleryCached(opts);
}
```

Deploy with `DB_GALLERY=false` first, then switch to `true` via Doppler.

### Acceptance Criteria

- Gallery page loads from SQLite (verify with query logging)
- Gallery page renders identical results to R2-based gallery
- Session info API returns same data
- Auth revocation check works from SQLite
- `/api/v1/stats` returns cumulative (not reset) counters

### Rollback: Set `DB_GALLERY=false` in Doppler. Gallery falls back to R2.

---

## Phase 4: User & Org Management

**Goal:** Add organization and team tables. Wire up user auto-creation on first Google OAuth.

### Tasks

| Task | Description |
|------|-------------|
| Org tables migration | `0002_organizations.sql` with organizations, memberships, teams, team_members |
| User auto-creation | On Google OAuth callback: `INSERT OR IGNORE INTO users (id, email, name)` |
| Default org | Create "Personal" org for solo users; allow org creation flow |
| Device assignment | Admin UI to assign devices to users |
| Session ownership | Sessions auto-linked to authenticated publisher's user ID |

### Acceptance Criteria

- First Google login creates user row
- Sessions record `publisher_user_id` when publisher authenticates
- Gallery filters by org membership
- Device list shows assigned user

---

## Phase 5: Operator Dashboard Queries

**Goal:** Enable the multi-publisher operator dashboard with real-time fleet status.

### Tasks

| Task | Description |
|------|-------------|
| Fleet status API | `GET /api/v1/fleet?orgId=X` → devices with online/offline status |
| Active sessions API | `GET /api/v1/sessions?status=active&orgId=X` → live publisher grid |
| Session history API | `GET /api/v1/sessions?orgId=X&from=...&to=...` → paginated history |
| Analytics API | `GET /api/v1/analytics?orgId=X&period=month` → hours, frames, errors |
| Alert API | `GET /api/v1/alerts?orgId=X` → active and recent alerts |
| WebSocket fleet events | Push device status changes to dashboard in real-time |

### Acceptance Criteria

- Operator dashboard shows all devices with online/offline/standby status
- Clicking a device shows its session history
- Clicking an active session opens the viewer
- Analytics page shows hours streamed per day/week/month

---

## Timeline Estimate

| Phase | Scope | Depends On |
|-------|-------|------------|
| Phase 0 | Foundation (schema, migrations, backup) | PRD-P002 decision |
| Phase 1 | Shadow writes (dual-write to R2 + SQLite) | Phase 0 |
| Phase 2 | Backfill (R2 → SQLite one-time migration) | Phase 1 deployed and verified |
| Phase 3 | Read switch (gallery from SQLite) | Phase 2 complete |
| Phase 4 | User/org management | Phase 3 stable |
| Phase 5 | Operator dashboard queries | Phase 4 complete |

Phases 0-3 are the persistence core. Phases 4-5 are the multi-publisher dashboard enablement.

---

## Backup & Recovery

### Daily Backup

```bash
# Cron: 0 4 * * * /opt/caringmind/backup-db.sh
sqlite3 /var/lib/caringmind/relay.db ".backup /tmp/relay-backup.db"
gzip -c /tmp/relay-backup.db > /tmp/relay-$(date +%Y%m%d).db.gz
bun run /opt/caringmind/upload-backup.ts  # uploads to R2 backups/
```

### Recovery

```bash
# Download latest backup from R2
bun run /opt/caringmind/download-backup.ts
gunzip relay-YYYYMMDD.db.gz
cp relay-YYYYMMDD.db /var/lib/caringmind/relay.db
# Restart server
systemctl restart caringmind-relay
```

### Point-in-Time Recovery

WAL mode preserves committed transactions. If the `.db` file is corrupted but the `.wal` file is intact:

```bash
sqlite3 relay.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

If both are corrupted, restore from the most recent daily backup. Sessions that started after the backup will have their R2 data intact -- re-run backfill script to repopulate SQLite.

---

## Monitoring

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| SQLite write queue depth | `DbWriter.queue.length` | > 100 |
| Batch commit latency | `DbWriter.flush()` timing | > 500ms |
| WAL file size | `ls -l relay.db-wal` | > 100MB |
| Backup upload success | Cron exit code | Non-zero |
| DB file size | `du relay.db` | > 1GB |
| Query latency (gallery) | HTTP response time | > 500ms |

---

## R2 + SQLite Boundary

Clear separation of concerns:

| Question | Answered By | Why |
|----------|------------|-----|
| "What sessions exist?" | SQLite | Indexed, paginated, filtered |
| "Show me session video" | R2 | Binary blob, signed URL |
| "Who streamed last Tuesday?" | SQLite | Date-indexed query |
| "Download the recording" | R2 | Binary blob |
| "How many hours this month?" | SQLite | Aggregation query |
| "What devices are online?" | SQLite | Status field, indexed |
| "Show me frame #427" | R2 | Inside a video segment |

Binary data stays in R2. Metadata and indexes live in SQLite. Never the twain shall meet.
