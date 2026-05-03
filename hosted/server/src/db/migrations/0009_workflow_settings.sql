-- Workflow-level settings (lifecycle, session limits, access control, telemetry)
ALTER TABLE workflows ADD COLUMN settings TEXT DEFAULT NULL;
