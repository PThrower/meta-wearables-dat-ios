# Multi-Tenant Bucket Data Architecture

How to organize, discover, and control access to bucket data with many users. Covers key layout, indexing strategies, access control, and scale thresholds.

Written 2026-04-03 as a planning document. Depends on `@ebowwa/object-store` (see `docs/object-store-package.md`).

---

## The Core Problem

S3 LIST is not a database. At scale with many users, you cannot rely on listing keys to find sessions. You need:

1. **Key layout** -- how objects are organized in the bucket
2. **Discovery** -- how to find sessions (by user, date, device)
3. **Access control** -- who can read/write what

---

## Key Layout: User-Partitioned

```
bucket/
  data/
    {userId}/                          -- partition by Google OAuth sub
      {sessionId}/
        meta.json                      -- device info, timestamps, session config
        video/
          seg-0001.mjpeg
          seg-0002.mjpeg
          ...
        audio/
          chunk-0001.pcm
          chunk-0002.pcm
          ...
        ai/
          detections.jsonl
          transcriptions.jsonl
          keyframes/
            000427-person.jpg
            001892-text.jpg
  index/
    users/
      {userId}.json                    -- user's session directory
    sessions/
      {sessionId}.json                 -- session metadata for cross-user lookups
    recent.json                        -- last N active sessions (global feed)
```

### Why Prefix-Per-User

- `list("data/{userId}/")` = all sessions for a user (fast, single prefix scan)
- Natural isolation for signed URLs scoped to a user's prefix
- Bucket lifecycle rules can target `data/{userId}/` for per-user retention
- Simple mental model: one user = one prefix tree

### User Identity

`{userId}` is the Google OAuth `sub` claim -- a stable, unique identifier that never changes even if email changes. Example: `google-oauth2|1234567890`.

---

## Discovery: Index Layer

Three options, swappable behind a common interface.

### Option A: JSON Manifests in Bucket

Self-contained. No external dependencies. The server maintains index files in the bucket itself.

`index/users/{userId}.json`:

```json
{
  "userId": "google-oauth2|1234567890",
  "email": "user@example.com",
  "sessions": [
    {
      "id": "abc123",
      "createdAt": "2026-04-03T14:22:00Z",
      "endedAt": "2026-04-03T14:52:44Z",
      "duration": 1840000,
      "deviceName": "Starlink",
      "wearableType": "Ray-Ban Meta",
      "deviceModel": "iPhone 16 Pro",
      "frameCount": 27600,
      "sizeBytes": 1932735283,
      "isPublic": false
    }
  ]
}
```

`index/sessions/{sessionId}.json`:

```json
{
  "id": "abc123",
  "userId": "google-oauth2|1234567890",
  "email": "user@example.com",
  "createdAt": "2026-04-03T14:22:00Z",
  "endedAt": "2026-04-03T14:52:44Z",
  "deviceName": "Starlink",
  "wearableType": "Ray-Ban Meta",
  "frameCount": 27600,
  "sizeBytes": 1932735283,
  "status": "completed",
  "isPublic": false
}
```

`index/recent.json`:

```json
{
  "updatedAt": "2026-04-03T14:52:44Z",
  "sessions": [
    {
      "id": "abc123",
      "userId": "google-oauth2|1234567890",
      "deviceName": "Starlink",
      "viewers": 3,
      "fps": 28.4,
      "status": "active"
    }
  ]
}
```

**Update flow:**
1. Session starts -> server writes `index/sessions/{id}.json`, appends to `index/users/{userId}.json`, updates `index/recent.json`
2. Session ends -> server updates all three with final stats
3. Server caches indexes in memory, writes to bucket on change

**Breaks down at:** ~10K sessions per user (JSON gets large, slow to parse). Fine for current scale.

### Option B: Local Database (SQLite / LMDB)

Server maintains a local index alongside the bucket. Fast arbitrary queries.

Schema:

```sql
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  device_name TEXT,
  wearable_type TEXT,
  device_model TEXT,
  frame_count INTEGER DEFAULT 0,
  size_bytes  INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'active',  -- active, completed, expired
  is_public   INTEGER DEFAULT 0
);

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  total_sessions  INTEGER DEFAULT 0,
  total_bytes     INTEGER DEFAULT 0
);

CREATE INDEX idx_sessions_user ON sessions(user_id, created_at DESC);
CREATE INDEX idx_sessions_date ON sessions(created_at DESC);
```

**Pros:** Fast arbitrary queries, pagination, aggregations. No network calls for reads.
**Cons:** Local state on one server. Doesn't survive server replacement unless backed up.

### Option C: External Database (Postgres)

Same schema as Option B but in a managed database. Survives server restarts, supports multiple server instances, proper concurrency.

**Needed when:** multi-server deployment, analytics dashboard, compliance reporting, user-facing dashboards with complex filters.

### Scale Thresholds

```
Scale           Index Strategy         Storage Per User
-----------     ---------------        ---------------
<100 users      JSON manifests (A)     ~50 sessions each, fine
<10K users      SQLite/LMDB on server  arbitrary queries, pagination
>10K users      Postgres (C)           multi-server, analytics, compliance
```

Start with JSON manifests. The interface stays the same regardless of backend:

```ts
interface SessionIndex {
  put(session: SessionMeta): Promise<void>;
  getByUser(userId: string, opts?: ListOpts): Promise<SessionMeta[]>;
  getById(sessionId: string): Promise<SessionMeta | null>;
  getRecent(limit?: number): Promise<SessionMeta[]>;
  delete(sessionId: string): Promise<void>;
}
```

Swap JSON manifest for SQLite for Postgres behind the same interface. Same pattern as `@ebowwa/object-store`.

### Implementation: JSON Manifest Index

```ts
class BucketSessionIndex implements SessionIndex {
  constructor(private store: ObjectStore) {}

  async put(session: SessionMeta): Promise<void> {
    // Update session index
    await this.store.put(
      `index/sessions/${session.id}.json`,
      Buffer.from(JSON.stringify(session))
    );

    // Update user index
    const userKey = `index/users/${session.userId}.json`;
    const existing = await this.store.get(userKey);
    const userIndex = existing ? JSON.parse(existing.toString()) : { userId: session.userId, sessions: [] };

    const idx = userIndex.sessions.findIndex((s: any) => s.id === session.id);
    if (idx >= 0) {
      userIndex.sessions[idx] = session;  // update existing
    } else {
      userIndex.sessions.unshift(session);  // prepend new
    }

    await this.store.put(userKey, Buffer.from(JSON.stringify(userIndex)));

    // Update recent
    await this.updateRecent(session);
  }

  async getByUser(userId: string, opts?: ListOpts): Promise<SessionMeta[]> {
    const data = await this.store.get(`index/users/${userId}.json`);
    if (!data) return [];
    const index = JSON.parse(data.toString());
    let sessions = index.sessions as SessionMeta[];
    if (opts?.limit) sessions = sessions.slice(0, opts.limit);
    return sessions;
  }

  async getById(sessionId: string): Promise<SessionMeta | null> {
    const data = await this.store.get(`index/sessions/${sessionId}.json`);
    if (!data) return null;
    return JSON.parse(data.toString());
  }

  async getRecent(limit = 50): Promise<SessionMeta[]> {
    const data = await this.store.get("index/recent.json");
    if (!data) return [];
    const recent = JSON.parse(data.toString());
    return recent.sessions.slice(0, limit);
  }
}
```

---

## Access Control

### Signed URLs

Don't proxy all data through the server. Generate time-limited signed URLs so browsers fetch directly from the bucket.

```ts
// Server generates a URL valid for 5 minutes
const url = await store.signedUrl(
  `data/${userId}/${sessionId}/video/seg-0001.mjpeg`,
  300  // 5 minutes
);
// Browser fetches directly from bucket -- server bandwidth untouched
```

### Relay Endpoint with Auth

```ts
app.get("/recording/:sessionId/video/:segIndex", async (req) => {
  const session = await index.getById(req.params.sessionId);
  if (!session) return new Response("not found", { status: 404 });

  // Auth check: verify requesting user owns session or session is public
  const caller = verifyToken(req.query.token);
  if (session.userId !== caller.sub && !session.isPublic) {
    return new Response("forbidden", { status: 403 });
  }

  const key = `data/${session.userId}/${session.id}/video/seg-${req.params.segIndex}.mjpeg`;
  const url = await store.signedUrl(key, 300);
  return Response.redirect(url);
});
```

The server validates access, then redirects to a signed bucket URL. Data never passes through the server.

### Access Matrix

| Role | Own Sessions | Other Public Sessions | Other Private Sessions |
|------|-------------|----------------------|----------------------|
| Owner | Full (read/write/delete) | Read | None |
| Authenticated User | Own only | Read | None |
| Anonymous | None | Read (if enabled) | None |
| Admin (future) | Full | Full | Full |

### Bucket Policies

For defense-in-depth at large scale. S3 bucket policies scoped to user prefixes:

```json
{
  "Effect": "Allow",
  "Principal": { "AWS": ["*"] },
  "Action": ["s3:GetObject"],
  "Resource": "arn:aws:s3:::caringmind-sessions/data/${userId}/*"
}
```

In practice, signed URLs are simpler and sufficient for most cases. Bucket policies add a second layer for compliance-heavy deployments.

---

## Data Flow at Scale

```
iOS App (user A)          iOS App (user B)
      |                        |
      v FRLY/FRAU              v FRLY/FRAU
      |                        |
      v publish?session=a1     v publish?session=b2
  +----------------------------------------------+
  |              Bun Relay Server                |
  |                                              |
  |  Session a1 (user A)    Session b2 (user B)  |
  |  +---------------+      +---------------+   |
  |  | viewers       |      | viewers       |   |
  |  | recorder      |      | recorder      |   |
  |  +---------------+      +---------------+   |
  |         |                       |            |
  |         v                       v            |
  |  SessionIndex.put()     SessionIndex.put()   |
  +----------------------------------------------+
            |                           |
            v                           v
  +----------------------------------------------+
  |            S3 Bucket (partitioned)            |
  |                                              |
  |  data/userA/a1/        data/userB/b2/       |
  |    meta.json             meta.json           |
  |    video/...             video/...           |
  |    audio/...             audio/...           |
  |    ai/...                ai/...              |
  |                                              |
  |  index/                                      |
  |    users/userA.json    users/userB.json      |
  |    sessions/a1.json    sessions/b2.json      |
  |    recent.json                               |
  +----------------------------------------------+
```

---

## User Dashboard Queries

| Query | Implementation |
|-------|---------------|
| "List my sessions" | `index.getByUser(userId)` -> reads from index |
| "Show session recordings" | `store.list("data/{userId}/{sessionId}/video/")` |
| "Download segment" | `store.signedUrl(key, 300)` -> redirect to bucket |
| "Recent activity across all users" | `index.getRecent(50)` -> reads `index/recent.json` |
| "Sessions from last week" | SQLite: `WHERE createdAt > now() - 7d` |
| "Total storage per user" | Aggregate from index or S3 inventory |
| "Delete a session" | Delete all keys under prefix + remove from index |

### Pagination

JSON manifest: sessions array is sorted by `createdAt` desc. Slice with offset/limit:

```ts
async getByUser(userId: string, opts?: { limit?: number; offset?: number }): Promise<SessionMeta[]> {
  const all = await this.getAllForUser(userId);
  const start = opts?.offset ?? 0;
  const end = start + (opts?.limit ?? 50);
  return all.slice(start, end);
}
```

SQLite/Postgres: native `LIMIT/OFFSET` with indexed queries.

---

## Storage Quotas

Soft enforcement at the application layer:

```ts
const USER_QUOTA_BYTES = 50 * 1024 * 1024 * 1024;  // 50 GB

async function checkQuota(userId: string): Promise<boolean> {
  const sessions = await index.getByUser(userId);
  const totalBytes = sessions.reduce((sum, s) => sum + (s.sizeBytes ?? 0), 0);
  return totalBytes < USER_QUOTA_BYTES;
}

// Before starting a new recording:
if (!await checkQuota(userId)) {
  return new Response("storage quota exceeded", { status: 429 });
}
```

Hard enforcement at the bucket layer via S3 bucket policies or object lock for compliance.

---

## Retention Per User

Bucket lifecycle rules scoped to user prefixes. Per-user retention if needed:

```ts
// Tag objects with user's retention tier
await store.put(key, data, { "x-amz-meta-retention-days": "90" });
```

Or simpler: global lifecycle rule, same retention for everyone:

```json
{
  "Rules": [
    {
      "ID": "ExpireUserData",
      "Filter": { "Prefix": "data/" },
      "Expiration": { "Days": 90 }
    },
    {
      "ID": "ArchiveIndex",
      "Filter": { "Prefix": "index/" },
      "Transitions": [
        { "Days": 30, "StorageClass": "STANDARD_IA" }
      ]
    }
  ]
}
```

---

## Cost Estimation at Scale

| Users | Sessions/User/Day | Data/Session | Daily Storage | Monthly Storage |
|-------|-------------------|-------------|---------------|-----------------|
| 10 | 2 | 3.9 GB | 78 GB | 2.3 TB |
| 100 | 2 | 3.9 GB | 780 GB | 23 TB |
| 1000 | 2 | 3.9 GB | 7.8 TB | 234 TB |

At Hetzner Storage Box pricing (EUR 3.81/month per 100GB), 23 TB = ~EUR 876/month.

At Cloudflare R2 ($0.015/GB/month storage, $0 egress), 23 TB = ~$345/month.

Retention and lifecycle rules are critical at scale. Without them, storage grows linearly forever.

---

## Staleness Warning

This document was written against the codebase on `feat/telemetry-diagnostics` at commit `33ea802`. Depends on:

- `docs/object-store-package.md` -- the `@ebowwa/object-store` abstraction
- `docs/persistence-architecture.md` -- recording format and retention
- `docs/multi-session-platform.md` -- session routing that drives storage keys
- `docs/auth-google-oauth.md` -- user identity (Google OAuth sub as partition key)
