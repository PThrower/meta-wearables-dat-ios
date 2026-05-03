/**
 * migrate.ts — Simple SQL migration runner for bun:sqlite
 *
 * Reads numbered SQL files from db/migrations/ and applies them in order.
 * Tracks applied migrations in a _migrations table.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export function runMigrations(db: Database): void {
  // Create migration tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Get applied migrations
  const applied = new Set<string>();
  const rows = db.query("SELECT filename FROM _migrations").all() as Array<{ filename: string }>;
  for (const row of rows) {
    applied.add(row.filename);
  }

  // Read and sort migration files
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith(".sql"))
      .sort();
  } catch {
    console.log("[db:migrate] No migrations directory found — skipping");
    return;
  }

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    console.log(`[db:migrate] Applying ${file}...`);

    // Run migration in a transaction
    const insertStmt = db.prepare("INSERT INTO _migrations (filename) VALUES (?)");
    db.transaction(() => {
      db.exec(sql);
      insertStmt.run(file);
    })();

    appliedCount++;
    console.log(`[db:migrate] Applied ${file}`);
  }

  if (appliedCount === 0) {
    console.log("[db:migrate] All migrations already applied");
  } else {
    console.log(`[db:migrate] Applied ${appliedCount} migration(s)`);
  }
}
