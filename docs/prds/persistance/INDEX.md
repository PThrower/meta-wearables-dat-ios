# Persistence PRDs

**Last Updated:** 2026-04-18

---

## Overview

The relay platform currently uses R2 (Cloudflare object storage via `@ebowwa/object-store`) for all persistence. This works for binary data (video, audio) but fails for structured queries (sessions by user, device fleet status, org-level analytics). These PRDs define the strategy for adding a structured database alongside R2.

---

## PRDs

| PRD | Title | Status | Purpose |
|-----|-------|--------|---------|
| [PRD-P001](PRD-P001-current-state-inventory.md) | Current State Inventory | Reference | What persists (R2), what doesn't (in-memory), pain points |
| [PRD-P002](PRD-P002-database-evaluation.md) | Database Evaluation & Selection | Draft | Compare SQLite, Turso, D1, PostgreSQL, R2 indexes |
| [PRD-P003](PRD-P003-data-models.md) | Data Models & Schema | Draft | Tables, relationships, Drizzle schema, query patterns |
| [PRD-P004](PRD-P004-migration-strategy.md) | Migration & Implementation | Draft | Phased rollout: shadow writes, backfill, read switch, org mgmt |

---

## Decision Summary

**Recommendation:** SQLite via `bun:sqlite` + Drizzle ORM.

**Why:**
- Zero new infrastructure (runs on existing Hetzner VPS)
- Native Bun support (`bun:sqlite` is first-class)
- Sub-millisecond latency for metadata queries
- SQL power (joins, indexes, aggregations)
- $0 cost
- Upgrade path to Turso (libSQL) if multi-region is needed later

**What stays in R2:** Video segments, audio chunks, MP4 exports, thumbnails, JSONL logs
**What moves to SQLite:** Session metadata, device registry, users, orgs, auth revocations, analytics

---

## Dependency Graph

```
PRD-P001 (Current State Inventory)     -- Reference, no action
  |
  v
PRD-P002 (Database Evaluation)         -- Decision: SQLite
  |
  v
PRD-P003 (Data Models)                 -- Schema design
  |
  v
PRD-P004 (Migration Strategy)          -- Implementation plan
  |
  +---> Phase 0: Foundation (schema, migrations, backup)
  +---> Phase 1: Shadow writes (dual-write)
  +---> Phase 2: Backfill (R2 → SQLite)
  +---> Phase 3: Read switch (gallery from SQLite)
  +---> Phase 4: User/org management
  +---> Phase 5: Operator dashboard queries
```

---

## Related PRDs

| PRD | Relationship |
|-----|-------------|
| PRD-004 (Session Persistence) | Defines R2 recording -- this is the binary data that stays in R2 |
| PRD-006 (Enterprise Platform) | Multi-publisher vision that drives the need for structured persistence |
| PRD-007 (Google OAuth) | User identity source -- feeds the `users` table |
| PRD-013 (Platform API Surface) | API routes that will read from SQLite instead of R2 |
| PRD-014 (Unified Telemetry) | Counters that will persist in SQLite instead of in-memory vars |
