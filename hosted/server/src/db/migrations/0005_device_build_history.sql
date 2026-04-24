-- 0005_device_build_history.sql — Track every build that connected per device

CREATE TABLE IF NOT EXISTS device_build_history (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    app_version TEXT NOT NULL,
    build_number TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE(device_id, app_version, build_number)
);
CREATE INDEX IF NOT EXISTS idx_build_history_device ON device_build_history(device_id);
CREATE INDEX IF NOT EXISTS idx_build_history_last_seen ON device_build_history(last_seen_at);
