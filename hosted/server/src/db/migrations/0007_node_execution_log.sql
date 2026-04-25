-- Node execution log: audit trail for workflow node state transitions
CREATE TABLE IF NOT EXISTS node_execution_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  app_id TEXT,
  node_type TEXT NOT NULL,
  state TEXT NOT NULL,
  action TEXT NOT NULL,
  error TEXT,
  triggered_by TEXT,
  timestamp_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_node_exec_session ON node_execution_log (session_id);
CREATE INDEX IF NOT EXISTS idx_node_exec_workflow ON node_execution_log (workflow_id);
CREATE INDEX IF NOT EXISTS idx_node_exec_node ON node_execution_log (node_id);
CREATE INDEX IF NOT EXISTS idx_node_exec_timestamp ON node_execution_log (timestamp_ms);
