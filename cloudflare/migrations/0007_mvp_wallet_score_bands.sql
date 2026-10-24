-- Add wallet-quality grouping without changing immutable weekly token reports.
-- The extension shares the original report's cohort and data cutoff; no wallet
-- profile or subsequently observed performance is copied into old decisions.
CREATE TABLE IF NOT EXISTS mvp_weekly_wallet_bands (
  report_key TEXT NOT NULL REFERENCES mvp_weekly_reports(report_key),
  extension_version INTEGER NOT NULL DEFAULT 1 CHECK(extension_version=1),
  generated_at INTEGER NOT NULL CHECK(generated_at>=0),
  data_cutoff INTEGER NOT NULL CHECK(data_cutoff>=0 AND data_cutoff<=generated_at),
  source_decisions INTEGER NOT NULL CHECK(source_decisions>=0),
  extension_json TEXT NOT NULL CHECK(json_valid(extension_json)),
  PRIMARY KEY(report_key,extension_version)
);
CREATE TRIGGER IF NOT EXISTS mvp_weekly_wallet_parent_cutoff BEFORE INSERT ON mvp_weekly_wallet_bands
WHEN NOT EXISTS (SELECT 1 FROM mvp_weekly_reports r WHERE r.report_key=NEW.report_key
  AND r.generated_at=NEW.data_cutoff AND r.source_decisions=NEW.source_decisions)
BEGIN SELECT RAISE(ABORT,'MVP_WEEKLY_WALLET_PARENT_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS mvp_weekly_wallet_no_update BEFORE UPDATE ON mvp_weekly_wallet_bands
BEGIN SELECT RAISE(ABORT,'MVP_WEEKLY_WALLET_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_weekly_wallet_no_delete BEFORE DELETE ON mvp_weekly_wallet_bands
BEGIN SELECT RAISE(ABORT,'MVP_WEEKLY_WALLET_APPEND_ONLY'); END;
