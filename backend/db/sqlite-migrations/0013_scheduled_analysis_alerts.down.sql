DROP TRIGGER IF EXISTS alert_events_no_delete;
DROP TRIGGER IF EXISTS alert_events_identity_immutable;
DROP INDEX IF EXISTS alert_events_recorded_idx;
DROP TABLE IF EXISTS alert_events;
DROP TABLE IF EXISTS alert_preferences;
DROP INDEX IF EXISTS scheduled_analysis_work_status_idx;
DROP TABLE IF EXISTS scheduled_analysis_work;