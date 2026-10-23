-- Weekly descriptive reports read the immutable decision/outcome ledger only.
-- No wallet-ledger schema or legacy table is altered by this migration.
CREATE INDEX IF NOT EXISTS mvp_decisions_week_time ON mvp_decisions(first_decision_at,score_version,profile);
CREATE INDEX IF NOT EXISTS mvp_decisions_week_version ON mvp_decisions(score_version,first_decision_at,profile);
CREATE TABLE IF NOT EXISTS mvp_weekly_reports (
  report_key TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
  score_version TEXT,
  week_start INTEGER NOT NULL CHECK(week_start>=0),
  week_end INTEGER NOT NULL CHECK(week_end=week_start+604800000),
  scheduled_for INTEGER NOT NULL CHECK(scheduled_for=week_start+1209600000+900000),
  generated_at INTEGER NOT NULL CHECK(generated_at>=scheduled_for),
  source_decisions INTEGER NOT NULL CHECK(source_decisions>=0),
  real_decisions INTEGER NOT NULL CHECK(real_decisions>=0),
  synthetic_excluded INTEGER NOT NULL CHECK(synthetic_excluded>=0),
  provenance_unknown_excluded INTEGER NOT NULL CHECK(provenance_unknown_excluded>=0),
  report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  UNIQUE(week_start,score_version),
  CHECK(source_decisions=real_decisions+synthetic_excluded+provenance_unknown_excluded)
);
CREATE INDEX IF NOT EXISTS mvp_weekly_latest ON mvp_weekly_reports(week_start DESC,generated_at DESC);
CREATE INDEX IF NOT EXISTS mvp_weekly_version_latest ON mvp_weekly_reports(score_version,week_start DESC,generated_at DESC);
CREATE TRIGGER IF NOT EXISTS mvp_weekly_no_update BEFORE UPDATE ON mvp_weekly_reports
BEGIN SELECT RAISE(ABORT,'MVP_WEEKLY_REPORT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_weekly_no_delete BEFORE DELETE ON mvp_weekly_reports
BEGIN SELECT RAISE(ABORT,'MVP_WEEKLY_REPORT_APPEND_ONLY'); END;
