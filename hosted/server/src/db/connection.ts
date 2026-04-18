/**
 * connection.ts — SQLite database connection via bun:sqlite + Drizzle ORM
 *
 * Opens (or creates) the SQLite database, enables WAL mode for concurrent
 * reads, and provides a Drizzle query builder instance.
 *
 * Usage:
 *   import { initDb, getDb, getDbRaw } from "./db/connection.js";
 *   await initDb();  // call once at server startup
 *   const db = getDb();
 *   const result = db.select().from(sessions).all();
 */

import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.js";

export type DbClient = BunSQLiteDatabase<typeof schema>;

let dbInstance: DbClient | null = null;
let rawDb: Database | null = null;

const DB_PATH = process.env.DB_PATH || "relay.db";

/** Initialize the database connection, enable WAL, and return the Drizzle client */
export function initDb(): DbClient {
  if (dbInstance) return dbInstance;

  rawDb = new Database(DB_PATH, { create: true });

  // WAL mode for concurrent reads + single writer
  rawDb.exec("PRAGMA journal_mode=WAL;");
  rawDb.exec("PRAGMA synchronous=NORMAL;");
  rawDb.exec("PRAGMA foreign_keys=ON;");
  rawDb.exec("PRAGMA busy_timeout=5000;");

  dbInstance = drizzle(rawDb, { schema });

  console.log(`[db] Opened ${DB_PATH} (WAL mode, fk=ON)`);
  return dbInstance;
}

/** Get the initialized Drizzle client. Throws if initDb() not called. */
export function getDb(): DbClient {
  if (!dbInstance) throw new Error("[db] not initialized — call initDb() first");
  return dbInstance;
}

/** Get the raw bun:sqlite instance for direct SQL or PRAGMA calls */
export function getDbRaw(): Database {
  if (!rawDb) throw new Error("[db] not initialized — call initDb() first");
  return rawDb;
}

/** Close the database connection (for graceful shutdown) */
export function closeDb(): void {
  if (rawDb) {
    rawDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    rawDb.close();
    dbInstance = null;
    rawDb = null;
    console.log("[db] Closed");
  }
}
