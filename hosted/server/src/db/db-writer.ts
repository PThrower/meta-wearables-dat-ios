/**
 * db-writer.ts — Batched async write queue for SQLite shadow writes
 *
 * Queues database writes and flushes them in batches every 5 seconds.
 * This avoids per-frame SQLite writes while keeping the write volume low
 * (session lifecycle events, not per-frame data).
 *
 * Errors are logged but never block the relay pipeline.
 */

import { eq, sql } from "drizzle-orm";
import { getDb, getDbRaw } from "./connection.js";
import * as s from "./schema.js";

type WriteOp = () => void;

const FLUSH_INTERVAL_MS = 5_000;
const COUNTER_FLUSH_INTERVAL_MS = 60_000;

class DbWriter {
  private queue: WriteOp[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private counterTimer: ReturnType<typeof setInterval> | null = null;
  private pendingCounters = new Map<string, number>();
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.counterTimer = setInterval(() => this.flushCounters(), COUNTER_FLUSH_INTERVAL_MS);
    console.log("[db-writer] Started (flush every 5s, counters every 60s)");
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.counterTimer) { clearInterval(this.counterTimer); this.counterTimer = null; }
    this.flush();
    this.flushCounters();
    this.started = false;
    console.log("[db-writer] Stopped");
  }

  /** Enqueue a write operation */
  enqueue(op: WriteOp) {
    this.queue.push(op);
  }

  /** Increment a telemetry counter (batched, flushed every 60s) */
  incrementCounter(key: string, delta: number = 1) {
    this.pendingCounters.set(key, (this.pendingCounters.get(key) || 0) + delta);
  }

  private flush() {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    try {
      const db = getDbRaw();
      db.transaction(() => {
        for (const op of batch) {
          try { op(); }
          catch (e) { console.error("[db-writer] write failed:", (e as Error).message); }
        }
      })();
    } catch (e) {
      console.error("[db-writer] batch flush failed:", (e as Error).message);
    }
  }

  private flushCounters() {
    if (this.pendingCounters.size === 0) return;
    const counters = new Map(this.pendingCounters);
    this.pendingCounters.clear();
    try {
      const db = getDbRaw();
      const now = new Date().toISOString();
      const updateStmt = db.prepare(
        "UPDATE telemetry_counters SET value = value + ?, updated_at = ? WHERE key = ?"
      );
      db.transaction(() => {
        for (const [key, delta] of counters) {
          updateStmt.run(delta, now, key);
        }
      })();
    } catch (e) {
      console.error("[db-writer] counter flush failed:", (e as Error).message);
      // Re-queue failed counters
      for (const [key, delta] of counters) {
        this.pendingCounters.set(key, (this.pendingCounters.get(key) || 0) + delta);
      }
    }
  }
}

// Singleton
export const dbWriter = new DbWriter();
