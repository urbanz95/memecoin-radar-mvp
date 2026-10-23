CREATE TABLE IF NOT EXISTS control (
  id INTEGER PRIMARY KEY CHECK(id=1), lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}', last_success INTEGER,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED', last_error TEXT
);
INSERT OR IGNORE INTO control(id) VALUES(1);
CREATE TABLE IF NOT EXISTS commit_fence (id INTEGER PRIMARY KEY CHECK(id=1), ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY, address TEXT NOT NULL, created_block INTEGER NOT NULL,
  last_enriched INTEGER NOT NULL DEFAULT 0, pool_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pools_rotation ON pools(last_enriched, created_block);
CREATE INDEX IF NOT EXISTS pools_recent ON pools(created_block DESC);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL, head_number INTEGER NOT NULL,
  report_json TEXT NOT NULL, evidence_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_expiry ON runs(completed_at);
