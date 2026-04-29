-- Persist active workflow ID so it survives server restarts
ALTER TABLE sessions ADD COLUMN active_workflow_id TEXT;
