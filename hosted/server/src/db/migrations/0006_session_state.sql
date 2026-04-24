-- 0006_session_state.sql — Add formal state machine columns to sessions

ALTER TABLE sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE sessions ADD COLUMN state_entered_at TEXT;
ALTER TABLE sessions ADD COLUMN drop_reason TEXT;
ALTER TABLE sessions ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows: ended sessions get 'ended', active sessions get 'active'
UPDATE sessions SET state = 'ended' WHERE ended_at IS NOT NULL;
UPDATE sessions SET state = 'active' WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
