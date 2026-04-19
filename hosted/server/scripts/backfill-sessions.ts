/**
 * backfill-sessions.ts — One-time R2 → SQLite migration
 *
 * Reads all existing session meta.json files from R2 and inserts them
 * into the SQLite database. Idempotent — can be run multiple times.
 *
 * Usage:
 *   bun run scripts/backfill-sessions.ts
 *   DB_PATH=/path/to/relay.db bun run scripts/backfill-sessions.ts
 */

import { createObjectStore, type ObjectStore } from "@ebowwa/object-store";
import { Database } from "bun:sqlite";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "relay.db";
const CONCURRENCY = 50;

interface R2SessionMeta {
  sessionId?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  device?: {
    deviceId?: string;
    deviceName?: string;
    deviceModel?: string;
    wearableId?: string;
    wearableType?: string;
    systemVersion?: string;
  };
  accessLevel?: string;
  acl?: Array<{ userId: string; email: string; role: string }>;
  ownerId?: string;
  ownerEmail?: string;
  recording?: {
    segmentsWritten?: number;
    audioChunks?: number;
    bytesToBucket?: number;
  };
}

async function main() {
  console.log(`[backfill] Opening database: ${DB_PATH}`);
  const db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  db.exec("PRAGMA foreign_keys=OFF;"); // Allow backfill in any order
  db.exec("PRAGMA busy_timeout=30000;");

  // Ensure tables exist
  const migrationPath = join(import.meta.dir, "..", "src", "db", "migrations", "0001_initial.sql");
  if (existsSync(migrationPath)) {
    const migrationSql = await Bun.file(migrationPath).text();
    // Create tracking table
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const applied = new Set(
      (db.query("SELECT filename FROM _migrations").all() as Array<{ filename: string }>).map(r => r.filename)
    );
    if (!applied.has("0001_initial.sql")) {
      db.exec(migrationSql);
      db.prepare("INSERT INTO _migrations (filename) VALUES (?)").run("0001_initial.sql");
      console.log("[backfill] Applied initial migration");
    }
  }

  // Prepare statements
  const now = new Date().toISOString();

  const upsertSession = db.prepare(`
    INSERT INTO sessions (
      id, recording_id, publisher_user_id, publisher_device_id,
      status, access_level, started_at, ended_at, duration_ms,
      total_frames, total_bytes, audio_chunks,
      r2_meta_written, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ended_at = COALESCE(sessions.ended_at, excluded.ended_at),
      duration_ms = COALESCE(sessions.duration_ms, excluded.duration_ms),
      total_frames = CASE WHEN excluded.total_frames > sessions.total_frames THEN excluded.total_frames ELSE sessions.total_frames END,
      total_bytes = CASE WHEN excluded.total_bytes > sessions.total_bytes THEN excluded.total_bytes ELSE sessions.total_bytes END,
      audio_chunks = CASE WHEN excluded.audio_chunks > sessions.audio_chunks THEN excluded.audio_chunks ELSE sessions.audio_chunks END,
      r2_meta_written = 1,
      updated_at = excluded.updated_at
  `);

  const upsertDevice = db.prepare(`
    INSERT INTO devices (id, name, model, system_version, wearable_type, wearable_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'offline', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(excluded.name, devices.name),
      model = COALESCE(excluded.model, devices.model),
      system_version = COALESCE(excluded.system_version, devices.system_version),
      wearable_type = COALESCE(excluded.wearable_type, devices.wearable_type),
      wearable_id = COALESCE(excluded.wearable_id, devices.wearable_id),
      updated_at = excluded.updated_at
  `);

  const upsertUser = db.prepare(`
    INSERT INTO users (id, email, role, created_at, updated_at)
    VALUES (?, ?, 'operator', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      updated_at = excluded.updated_at
  `);

  // Connect to R2
  console.log("[backfill] Connecting to R2...");
  const store: ObjectStore = createObjectStore();

  // List all session meta.json files
  console.log("[backfill] Listing R2 sessions...");
  const keys = await store.list("sessions/") as string[];
  const metaKeys = keys.filter(k => k.startsWith("sessions/") && k.endsWith("/meta.json"));
  console.log(`[backfill] Found ${metaKeys.length} sessions in R2`);

  if (metaKeys.length === 0) {
    console.log("[backfill] Nothing to migrate");
    db.close();
    return;
  }

  // Process in batches
  let processed = 0;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  const batchSize = CONCURRENCY;
  for (let i = 0; i < metaKeys.length; i += batchSize) {
    const batch = metaKeys.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(async (key) => {
        const sessionId = key.slice("sessions/".length, key.length - "/meta.json".length);
        const buf = await store.get(key);
        if (!buf) return { status: "skipped" as const, sessionId };

        let meta: R2SessionMeta;
        try {
          meta = JSON.parse(new TextDecoder().decode(buf));
        } catch {
          return { status: "error" as const, sessionId, error: "parse failed" };
        }

        return { status: "ok" as const, sessionId, meta };
      })
    );

    // Write batch to SQLite in a transaction
    db.transaction(() => {
      for (const result of results) {
        if (result.status === "rejected") {
          errors++;
          continue;
        }
        const { value } = result;
        if (value.status === "skipped") { skipped++; continue; }
        if (value.status === "error") { errors++; continue; }

        const { sessionId, meta } = value;
        const ts = now;

        try {
          // Determine status
          const isEnded = !!meta.finishedAt || !!meta.durationMs;
          const status = isEnded ? "ended" : "active";

          // Insert session
          upsertSession.run(
            sessionId,
            sessionId,  // recording_id = session_id for backfilled sessions
            meta.ownerId ?? null,
            meta.device?.deviceId ?? null,
            status,
            meta.accessLevel ?? "link",
            meta.startedAt ?? ts,
            meta.finishedAt ?? null,
            meta.durationMs ?? null,
            meta.recording?.segmentsWritten ?? 0,
            meta.recording?.bytesToBucket ?? 0,
            meta.recording?.audioChunks ?? 0,
            meta.startedAt ?? ts,
            ts,
          );

          // Insert device
          if (meta.device?.deviceId) {
            upsertDevice.run(
              meta.device.deviceId,
              meta.device.deviceName ?? null,
              meta.device.deviceModel ?? null,
              meta.device.systemVersion ?? null,
              meta.device.wearableType ?? null,
              meta.device.wearableId ?? null,
              ts,
              ts,
            );
          }

          // Insert user (owner)
          if (meta.ownerId && meta.ownerEmail) {
            upsertUser.run(
              meta.ownerId,
              meta.ownerEmail,
              ts,
              ts,
            );
          }

          inserted++;
        } catch (e) {
          errors++;
          console.error(`[backfill] Error inserting ${sessionId}:`, (e as Error).message);
        }

        processed++;
      }
    })();

    console.log(`[backfill] Progress: ${Math.min(i + batchSize, metaKeys.length)}/${metaKeys.length} (inserted: ${inserted}, skipped: ${skipped}, errors: ${errors})`);
  }

  // Summary
  console.log(`\n[backfill] Complete:`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Inserted:  ${inserted}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Errors:    ${errors}`);

  // Verify
  const sessionCount = (db.query("SELECT COUNT(*) as c FROM sessions").get() as any).c;
  const deviceCount = (db.query("SELECT COUNT(*) as c FROM devices").get() as any).c;
  const userCount = (db.query("SELECT COUNT(*) as c FROM users").get() as any).c;
  console.log(`\n[backfill] SQLite now contains:`);
  console.log(`  Sessions: ${sessionCount}`);
  console.log(`  Devices:  ${deviceCount}`);
  console.log(`  Users:    ${userCount}`);

  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
  console.log("[backfill] Done");
}

main().catch(err => {
  console.error("[backfill] Fatal:", err);
  process.exit(1);
});
