-- Phase 2 is a durable formatter/outbox preview only. No delivery state exists.
CREATE TABLE IF NOT EXISTS mvp_alert_outbox (
  outbox_key TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
  decision_id TEXT NOT NULL,
  score_version TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  destination_key TEXT NOT NULL CHECK(destination_key GLOB 'telegram:dry-run:*'),
  run_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'DRY_RUN' CHECK(state='DRY_RUN'),
  dry_run INTEGER NOT NULL DEFAULT 1 CHECK(dry_run=1),
  synthetic INTEGER NOT NULL CHECK(synthetic IN (0,1)),
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  address TEXT NOT NULL CHECK(length(address)=42 AND address=lower(address)),
  profile TEXT NOT NULL CHECK(profile='profile_new'),
  direction TEXT NOT NULL CHECK(direction='ENTRY'),
  score REAL NOT NULL CHECK(score>=0 AND score<=100),
  observed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=observed_at),
  message_text TEXT NOT NULL CHECK(length(message_text)<=4096),
  envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
  UNIQUE(decision_id,score_version,episode_id,destination_key),
  CHECK(synthetic=0 OR instr(message_text,'SINTÉTICO')>0)
);
CREATE INDEX IF NOT EXISTS mvp_outbox_recent ON mvp_alert_outbox(state,created_at DESC,outbox_key);
CREATE TABLE IF NOT EXISTS mvp_outbox_stats (
  id INTEGER PRIMARY KEY CHECK(id=1),
  queued_dry_run INTEGER NOT NULL DEFAULT 0,
  synthetic INTEGER NOT NULL DEFAULT 0,
  last_created_at INTEGER
);
INSERT OR IGNORE INTO mvp_outbox_stats(id) VALUES(1);
CREATE TRIGGER IF NOT EXISTS mvp_outbox_insert_stats AFTER INSERT ON mvp_alert_outbox
BEGIN UPDATE mvp_outbox_stats SET queued_dry_run=queued_dry_run+1,synthetic=synthetic+NEW.synthetic,
  last_created_at=max(coalesce(last_created_at,0),NEW.created_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_outbox_no_update BEFORE UPDATE ON mvp_alert_outbox
BEGIN SELECT RAISE(ABORT,'MVP_OUTBOX_DRY_RUN_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_outbox_no_delete BEFORE DELETE ON mvp_alert_outbox
BEGIN SELECT RAISE(ABORT,'MVP_OUTBOX_APPEND_ONLY'); END;
