/**
 * backfill-owner.ts
 *
 * One-time migration: sets ownerId/ownerEmail on all existing session
 * meta.json objects in R2 that lack ownership.
 *
 * Usage:
 *   bun run hosted/scripts/backfill-owner.ts
 *
 * Required env vars (read from .env or environment):
 *   OWNER_EMAIL  - email to assign (default: ec.arbee1@gmail.com)
 *   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY
 */

import { createObjectStore } from "@ebowwa/object-store";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "ec.arbee1@gmail.com";
const OWNER_ID = process.env.OWNER_ID || OWNER_EMAIL; // fallback: use email as ID

async function main() {
  console.log(`[backfill] Assigning all sessions to ${OWNER_EMAIL}`);

  const store = createObjectStore();

  // List all session meta.json files
  const allKeys = await store.list("sessions/");
  const metaKeys = allKeys.filter(k => k.endsWith("/meta.json"));
  console.log(`[backfill] Found ${metaKeys.length} sessions`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const mk of metaKeys) {
    try {
      const buf = await store.get(mk);
      if (!buf) {
        console.warn(`[backfill] Could not read ${mk}`);
        failed++;
        continue;
      }

      const meta = JSON.parse(new TextDecoder().decode(buf));

      // Skip if already has an owner
      if (meta.ownerId || meta.ownerEmail) {
        console.log(`[backfill] Skip ${mk} (owner: ${meta.ownerEmail || meta.ownerId})`);
        skipped++;
        continue;
      }

      // Set ownership
      meta.ownerId = OWNER_ID;
      meta.ownerEmail = OWNER_EMAIL;

      // Ensure accessLevel is private (not link or public)
      if (!meta.accessLevel || meta.accessLevel === "link") {
        meta.accessLevel = "private";
      }

      await store.put(mk, Buffer.from(JSON.stringify(meta, null, 2)));
      console.log(`[backfill] Updated ${mk} → ${OWNER_EMAIL} (${meta.accessLevel})`);
      updated++;
    } catch (err) {
      console.error(`[backfill] Error on ${mk}:`, err);
      failed++;
    }
  }

  console.log(`\n[backfill] Done: ${updated} updated, ${skipped} skipped, ${failed} failed`);
}

main().catch(err => {
  console.error("[backfill] Fatal:", err);
  process.exit(1);
});
