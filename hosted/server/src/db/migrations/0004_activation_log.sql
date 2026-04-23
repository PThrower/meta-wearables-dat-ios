-- Activation audit log: tracks who activated what, when, and whether it overrode an existing app
CREATE TABLE IF NOT EXISTS activation_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workflow_id TEXT REFERENCES workflows(id),
  app_id TEXT,
  activated_by TEXT,
  deactivated_by TEXT,
  overrode_app_id TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  activated_at TEXT NOT NULL,
  deactivated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_activation_log_session ON activation_log(session_id);
CREATE INDEX IF NOT EXISTS idx_activation_log_workflow ON activation_log(workflow_id);
CREATE INDEX IF NOT EXISTS idx_activation_log_activated_by ON activation_log(activated_by);
CREATE INDEX IF NOT EXISTS idx_activation_log_status ON activation_log(status);
