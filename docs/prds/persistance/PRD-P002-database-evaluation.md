# PRD-P002: Database Evaluation & Selection

**Product:** com.mwdat-ios / Relay Platform
**Owner:** @ebowwa
**Status:** Draft -- Decision Required
**Last Updated:** 2026-04-18
**Depends On:** PRD-P001 (Current State Inventory)

---

## Decision to Make

Choose a database technology to complement R2 for structured data (devices, users, orgs, session metadata, analytics). The database does NOT replace R2 for binary blobs (video segments, audio chunks, exports).

---

## Requirements

### Functional

| ID | Requirement | Priority |
|----|-------------|----------|
| F-1 | Store device registry (last seen, firmware, battery, model) | P0 |
| F-2 | Store user registry (Google sub, email, name, org membership) | P0 |
| F-3 | Store organization/team hierarchy | P0 |
| F-4 | Store session metadata summary (indexed, queryable) | P0 |
| F-5 | Store auth revocation list (survives restart) | P0 |
| F-6 | Store aggregate telemetry counters (cumulative, not reset) | P1 |
| F-7 | Store alert history | P1 |
| F-8 | Store task/procedure state | P2 |
| F-9 | Query sessions by device, user, org, date range | P0 |
| F-10 | Query devices by org, status (online/offline), model | P0 |
| F-11 | Full-text search across session annotations/guidance | P2 |

### Non-Functional

| ID | Requirement | Target |
|----|-------------|--------|
| NF-1 | Write latency for session metadata | < 50ms (local), < 200ms (remote) |
| NF-2 | Read latency for gallery listing | < 100ms |
| NF-3 | Gallery listing with 10,000 sessions | < 500ms |
| NF-4 | Concurrent connections | 100 publishers, 500 viewers |
| NF-5 | Deployment complexity | Single binary or managed service |
| NF-6 | Backup/restore | Automated daily, point-in-time recovery |
| NF-7 | Operational cost at 50 sessions/day | < $20/month |
| NF-8 | Zero new infrastructure | Must run on existing Hetzner VPS or use managed free tier |

---

## Candidates

### Option A: SQLite (via `better-sqlite3` or `bun:sqlite`)

**What:** Single-file embedded database. Bun has native SQLite support (`bun:sqlite`).

| Dimension | Assessment |
|-----------|------------|
| Write latency | < 1ms (local file) |
| Read latency | < 1ms (local file) |
| Deployment | Zero -- file lives on VPS disk |
| Backup | Copy the `.db` file |
| Cost | $0 |
| Concurrent writes | Single-writer (WAL mode allows concurrent reads) |
| Full-text search | FTS5 extension built-in |
| Query power | SQL (joins, aggregations, indexes) |
| Migration | Lightweight (`.sql` files or drizzle migrations) |
| Scaling limit | ~100K writes/sec on modern SSD; single-machine only |
| Bun integration | Native -- `bun:sqlite` is a first-class API |
| Risk | File corruption on crash (mitigated by WAL + frequent checkpoints) |

**Schema approach:** Drizzle ORM with typed schema, SQL migration files.

**Deployment:**
- DB file at `/var/lib/caringmind/relay.db` on Hetzner VPS
- WAL mode for concurrent read/write
- Daily cron: `sqlite3 relay.db ".backup backup.db"` + gzip + R2 upload

**Fit score: 9/10** -- Best fit. Zero ops, zero cost, native Bun support, SQL power, single-machine deployment matches current architecture.

---

### Option B: Turso (libSQL, distributed SQLite)

**What:** Managed libSQL (SQLite fork) with embedded replicas. Edge-first, serverless.

| Dimension | Assessment |
|-----------|------------|
| Write latency | < 10ms (primary) / < 1ms (embedded replica reads) |
| Read latency | < 1ms (embedded replica in Bun process) |
| Deployment | `@libsql/client` npm package, replica embedded in Bun |
| Backup | Managed by Turso |
| Cost | Free tier: 9GB storage, 1B row reads/month. Pro: $29/month |
| Concurrent writes | Single-writer primary, multi-region replicas |
| Full-text search | FTS5 supported |
| Query power | SQL (libSQL extensions) |
| Migration | Drizzle ORM support |
| Scaling limit | Practically unlimited reads; writes through single primary |
| Bun integration | `@libsql/client` works with Bun |
| Risk | Vendor dependency; network latency for writes to primary |

**Fit score: 7/10** -- Strong option if multi-region or edge deployment is needed. Adds complexity for single-VPS deployment. Free tier is generous.

---

### Option C: Cloudflare D1

**What:** Managed SQLite-compatible database on Cloudflare Workers. HTTP-based API.

| Dimension | Assessment |
|-----------|------------|
| Write latency | 50-100ms (HTTP round-trip to Cloudflare) |
| Read latency | 50-100ms (HTTP round-trip) |
| Deployment | HTTP API -- no local process |
| Backup | Managed by Cloudflare |
| Cost | Free tier: 5GB storage, 5M reads/day. Paid: $0.75/M reads |
| Concurrent writes | Managed |
| Full-text search | FTS5 supported |
| Query power | SQL (SQLite-compatible) |
| Migration | Wrangler CLI |
| Scaling limit | Managed, effectively unlimited |
| Bun integration | REST API -- works everywhere but adds latency |
| Risk | Vendor dependency; higher latency than local; not on Hetzner network |

**Fit score: 5/10** -- Latency penalty for structured metadata queries on every gallery/request. Adds a network hop. Better suited for edge-deployed Workers, not a single VPS relay server.

---

### Option D: PostgreSQL (via `postgres` or `pg`)

**What:** Traditional RDBMS. Could run on VPS or use managed service (Supabase, Neon, Hetzner Managed).

| Dimension | Assessment |
|-----------|------------|
| Write latency | < 5ms (local), 20-50ms (managed) |
| Read latency | < 5ms (local), 20-50ms (managed) |
| Deployment | `apt install postgresql` or managed service |
| Backup | pg_dump + cron (local) or managed |
| Cost | $0 (local), $0-25/month (managed free tier) |
| Concurrent writes | MVCC -- unlimited concurrent writers |
| Full-text search | Full-text search with `tsvector` |
| Query power | SQL (advanced: CTEs, window functions, JSONB) |
| Migration | Drizzle, Prisma, or raw SQL |
| Scaling limit | Very high for this workload |
| Bun integration | `postgres` or `pg` npm packages work with Bun |
| Risk | Operational overhead (vacuum, connection pooling, tuning) |

**Fit score: 6/10** -- Overkill for current scale. Adds operational burden (daemon, connections, backups). Right choice if the platform needs to scale to thousands of concurrent sessions or complex relational queries. Premature today.

---

### Option E: Extend R2 with JSON Index Files

**What:** Instead of a database, maintain structured JSON index files in R2 that are loaded into memory and kept updated.

| Dimension | Assessment |
|-----------|------------|
| Write latency | 50-200ms (R2 PUT) |
| Read latency | 50-200ms (R2 GET) or < 1ms (cached in memory) |
| Deployment | None -- already have R2 |
| Backup | R2 versioning |
| Cost | $0 (within existing R2 usage) |
| Concurrent writes | No -- last-writer-wins, merge conflicts possible |
| Full-text search | Not possible without full scan |
| Query power | JavaScript filter/sort -- no indexes, no joins |
| Migration | None |
| Scaling limit | Degrades with > 1000 sessions (JSON parse time) |
| Risk | Race conditions on concurrent writes; no transactional safety |

**Fit score: 3/10** -- The current approach. Works for < 100 sessions but doesn't solve any of the pain points in PRD-P001. Not viable for operator dashboard.

---

## Comparison Matrix

| Criterion | SQLite | Turso | D1 | PostgreSQL | R2 Indexes |
|-----------|--------|-------|----|-----------|-----------|
| Write latency | < 1ms | < 10ms | 50-100ms | < 5ms | 50-200ms |
| Read latency | < 1ms | < 1ms | 50-100ms | < 5ms | < 1ms (cached) |
| Cost | $0 | $0-29/mo | $0-5/mo | $0-25/mo | $0 |
| Ops burden | None | None | None | Medium | None |
| Query power | SQL | SQL | SQL | SQL+ | JS only |
| Concurrent writes | WAL | Managed | Managed | MVCC | None |
| FTS | FTS5 | FTS5 | FTS5 | tsvector | No |
| Bun native | Yes | npm | HTTP | npm | No |
| Backup | File copy | Managed | Managed | pg_dump | R2 version |
| Scaling ceiling | Single machine | Multi-region | Edge | Cluster | ~1000 sessions |

---

## Recommendation

**SQLite via `bun:sqlite` with Drizzle ORM.**

Rationale:

1. **Zero new infrastructure.** The Hetzner VPS already runs the relay server. Adding a `.db` file is no operational change.

2. **Native Bun integration.** `bun:sqlite` is a first-class Bun API -- no npm dependency for the driver, no connection pooling needed, no daemon to manage.

3. **Performance.** Sub-millisecond reads/writes for session metadata, device lookups, and auth revocation checks. Gallery listing from an indexed table instead of scanning R2.

4. **SQL power.** Joins for "sessions by user in org X", aggregations for analytics, indexes for device/user lookups, FTS5 for annotation search.

5. **Simple backup.** Daily file copy + gzip + upload to R2. Point-in-time recovery from WAL.

6. **Upgrade path.** If the platform needs multi-region or higher concurrency later, Turso (libSQL) is a wire-compatible migration from SQLite. The schema stays the same.

7. **Cost.** $0. Meets NF-8.

### What stays in R2

| Data | Storage | Why |
|------|---------|-----|
| Video segments | R2 | Binary blobs, not queried |
| Audio chunks | R2 | Binary blobs, not queried |
| MP4 exports | R2 | Binary blobs, served via signed URL |
| Thumbnails | R2 | Binary blobs, served via signed URL |
| Guidance JSONL (raw) | R2 | Append-only log, large |
| Annotations JSONL (raw) | R2 | Append-only log, large |

### What moves to SQLite

| Data | Storage | Why |
|------|---------|-----|
| Session metadata (indexed) | SQLite | Queried by device, user, org, date |
| Device registry | SQLite | Queried by org, status, model |
| User registry | SQLite | Queried by email, org |
| Org/team structure | SQLite | Hierarchical queries |
| Auth revocation list | SQLite | Must survive restart |
| Aggregate telemetry | SQLite | Cumulative counters |
| Share tokens | SQLite | Indexed by token, session, expiry |
| Gallery cache invalidation | SQLite | Replace in-memory Map |

---

## Migration Path (SQLite → Turso if needed)

If the platform scales beyond a single VPS:

1. Schema is SQL -- identical between SQLite and libSQL
2. Drizzle ORM supports both `bun:sqlite` and `@libsql/client`
3. Swap the driver import, point to Turso URL, done
4. Embedded replica in Bun process restores sub-ms read latency

No schema changes, no data migration, no application logic changes.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| SQLite file corruption on crash | Low | WAL mode + `PRAGMA journal_mode=WAL` + daily backup to R2 |
| Single-writer bottleneck | Low | WAL mode allows concurrent reads; write volume is low (session start/end, not per-frame) |
| No multi-region | Medium | Acceptable for current single-VPS architecture. Turso is the upgrade path. |
| Backup window | Low | SQLite `.backup` is online (doesn't block reads/writes). Cron during off-peak. |
| Schema migration complexity | Low | Drizzle generates SQL migration files. Single `bun run migrate` on deploy. |
