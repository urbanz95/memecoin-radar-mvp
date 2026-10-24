-- Dedicated weekly worker checkpoints and bounded immutable cohort pages.
-- Existing weekly reports/extensions and every decision/outcome remain intact.
CREATE TABLE IF NOT EXISTS mvp_weekly_jobs (
  report_key TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK(schema_version=2),
  score_version TEXT,
  week_start INTEGER NOT NULL CHECK(week_start>=0),
  week_end INTEGER NOT NULL CHECK(week_end=week_start+604800000),
  scheduled_for INTEGER NOT NULL CHECK(scheduled_for=week_start+1209600000+900000),
  data_cutoff INTEGER NOT NULL CHECK(data_cutoff>=scheduled_for),
  source_rowid_limit INTEGER NOT NULL CHECK(source_rowid_limit>=0),
  canonical_generation INTEGER NOT NULL CHECK(canonical_generation>=0),
  canonical_invalidations INTEGER NOT NULL CHECK(canonical_invalidations>=0),
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0 CHECK(lease_until>=0),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RETRY','COMPLETE','QUARANTINED')),
  next_page INTEGER NOT NULL DEFAULT 0 CHECK(next_page>=0),
  cursor_version TEXT,
  cursor_profile TEXT,
  cursor_tier TEXT CHECK(cursor_tier IN ('T0','T1S','T1','T2','UNKNOWN')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at>=0),
  last_error TEXT,
  updated_at INTEGER NOT NULL CHECK(updated_at>=0)
);
CREATE INDEX IF NOT EXISTS mvp_weekly_jobs_latest ON mvp_weekly_jobs(week_start DESC,data_cutoff DESC);
CREATE INDEX IF NOT EXISTS mvp_weekly_jobs_due ON mvp_weekly_jobs(state,next_attempt_at);
CREATE TABLE IF NOT EXISTS mvp_weekly_cohort_pages (
  report_key TEXT NOT NULL REFERENCES mvp_weekly_jobs(report_key),
  page_index INTEGER NOT NULL CHECK(page_index>=0),
  score_version TEXT NOT NULL,
  profile TEXT NOT NULL,
  quote_tier TEXT NOT NULL CHECK(quote_tier IN ('T0','T1S','T1','T2','UNKNOWN')),
  generated_at INTEGER NOT NULL CHECK(generated_at>=0),
  data_cutoff INTEGER NOT NULL CHECK(data_cutoff>=0 AND data_cutoff<=generated_at),
  report_json TEXT NOT NULL CHECK(json_valid(report_json) AND length(CAST(report_json AS BLOB))<=65536),
  PRIMARY KEY(report_key,page_index),
  UNIQUE(report_key,score_version,profile,quote_tier)
);
CREATE TRIGGER IF NOT EXISTS mvp_weekly_cohort_no_update BEFORE UPDATE ON mvp_weekly_cohort_pages
BEGIN SELECT RAISE(ABORT,'MVP_WEEKLY_COHORT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_weekly_cohort_no_delete BEFORE DELETE ON mvp_weekly_cohort_pages
BEGIN SELECT RAISE(ABORT,'MVP_WEEKLY_COHORT_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_weekly_jobs_no_delete BEFORE DELETE ON mvp_weekly_jobs
BEGIN SELECT RAISE(ABORT,'MVP_WEEKLY_JOB_PRESERVED'); END;
CREATE TRIGGER IF NOT EXISTS mvp_weekly_job_identity BEFORE UPDATE ON mvp_weekly_jobs
WHEN NEW.report_key IS NOT OLD.report_key OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.score_version IS NOT OLD.score_version OR NEW.week_start IS NOT OLD.week_start
  OR NEW.week_end IS NOT OLD.week_end OR NEW.scheduled_for IS NOT OLD.scheduled_for
  OR NEW.data_cutoff IS NOT OLD.data_cutoff OR NEW.source_rowid_limit IS NOT OLD.source_rowid_limit
  OR NEW.canonical_generation IS NOT OLD.canonical_generation
  OR NEW.canonical_invalidations IS NOT OLD.canonical_invalidations
BEGIN SELECT RAISE(ABORT,'MVP_WEEKLY_JOB_IDENTITY_IMMUTABLE'); END;
