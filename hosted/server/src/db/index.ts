/**
 * db/index.ts — Unified export for the database module
 *
 * Import this for all DB access:
 *   import { db, dbRaw } from "./db/index.js";
 */

export { initDb, getDb, getDbRaw, closeDb, type DbClient } from "./connection.js";
export { runMigrations } from "./migrate.js";
export * as schema from "./schema.js";
