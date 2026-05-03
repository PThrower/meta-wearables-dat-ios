-- Deduplicate device rows: merge old random-UUID devices into canonical rows.
-- Keeps the most recently updated row per (name, model) pair and re-points FKs.

-- 1. Find duplicate groups (same device name + model, >1 row)
-- 2. For each group, keep the newest row, re-point all FK references to it
-- 3. Delete the stale rows

-- Create a temp mapping: old_id -> keep_id for each duplicate group
CREATE TEMP TABLE IF NOT EXISTS device_dedup_map AS
SELECT
  d1.id AS old_id,
  d2.id AS keep_id
FROM devices d1
JOIN (
  SELECT name, model, MAX(updated_at) AS max_updated
  FROM devices
  WHERE name IS NOT NULL AND model IS NOT NULL
  GROUP BY name, model
  HAVING COUNT(*) > 1
) grp ON d1.name = grp.name AND d1.model = grp.model
JOIN devices d2 ON d2.name = grp.name AND d2.model = grp.model
  AND d2.updated_at = grp.max_updated
WHERE d1.id != d2.id;

-- Re-point sessions FK
UPDATE sessions SET publisher_device_id = (
  SELECT keep_id FROM device_dedup_map WHERE old_id = publisher_device_id
) WHERE publisher_device_id IN (SELECT old_id FROM device_dedup_map);

-- Re-point alerts FK
UPDATE alerts SET device_id = (
  SELECT keep_id FROM device_dedup_map WHERE old_id = device_id
) WHERE device_id IN (SELECT old_id FROM device_dedup_map);

-- Merge APNs token: if a stale row has a token the keep row doesn't, copy it over
UPDATE devices SET apns_device_token = (
  SELECT d2.apns_device_token
  FROM devices d2
  JOIN device_dedup_map m ON m.old_id = d2.id
  WHERE m.keep_id = devices.id AND d2.apns_device_token IS NOT NULL
  LIMIT 1
) WHERE id IN (SELECT keep_id FROM device_dedup_map)
  AND apns_device_token IS NULL;

-- Merge build history: re-point to kept device
UPDATE device_build_history SET device_id = (
  SELECT keep_id FROM device_dedup_map WHERE old_id = device_id
) WHERE device_id IN (SELECT old_id FROM device_dedup_map);

-- Delete stale duplicate rows
DELETE FROM devices WHERE id IN (SELECT old_id FROM device_dedup_map);

DROP TABLE IF EXISTS device_dedup_map;
