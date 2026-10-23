-- Additive MVP evidence ledger. Legacy pools/runs/control are unchanged.
CREATE TABLE IF NOT EXISTS mvp_tokens (
  chain_id INTEGER NOT NULL CHECK(chain_id > 0),
  address TEXT NOT NULL CHECK(length(address)=42 AND address=lower(address)),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
  first_seen_at INTEGER NOT NULL CHECK(first_seen_at >= 0),
  first_seen_run_id TEXT NOT NULL,
  first_seen_pool_id TEXT,
  first_pool_created_at INTEGER,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  PRIMARY KEY(chain_id,address)
);
CREATE TABLE IF NOT EXISTS mvp_token_seen_events (
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pool_id TEXT NOT NULL DEFAULT '',
  seen_at INTEGER NOT NULL CHECK(seen_at >= 0),
  pool_created_at INTEGER,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  PRIMARY KEY(chain_id,address,run_id,pool_id),
  FOREIGN KEY(chain_id,address) REFERENCES mvp_tokens(chain_id,address)
);
CREATE TABLE IF NOT EXISTS mvp_decisions (
  decision_key TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
  score_version TEXT NOT NULL,
  profile TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  first_decision_at INTEGER NOT NULL CHECK(first_decision_at >= 0),
  first_run_id TEXT NOT NULL,
  first_status TEXT NOT NULL,
  is_launch INTEGER NOT NULL DEFAULT 0 CHECK(is_launch IN (0,1)),
  baseline_price_usd REAL,
  baseline_liquidity_usd REAL,
  features_json TEXT NOT NULL CHECK(json_valid(features_json)),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  UNIQUE(chain_id,address,score_version,profile),
  FOREIGN KEY(chain_id,address) REFERENCES mvp_tokens(chain_id,address)
);
CREATE INDEX IF NOT EXISTS mvp_decisions_cohort ON mvp_decisions(score_version,profile,is_launch,first_decision_at);
CREATE TABLE IF NOT EXISTS mvp_decision_events (
  decision_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  status TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  features_json TEXT NOT NULL CHECK(json_valid(features_json)),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  PRIMARY KEY(decision_key,run_id),
  FOREIGN KEY(decision_key) REFERENCES mvp_decisions(decision_key)
);
CREATE TABLE IF NOT EXISTS mvp_outcome_jobs (
  decision_key TEXT NOT NULL,
  horizon TEXT NOT NULL CHECK(horizon IN ('15m','1h','24h','7d')),
  due_at INTEGER NOT NULL CHECK(due_at >= 0),
  allowed_lag_ms INTEGER NOT NULL DEFAULT 300000 CHECK(allowed_lag_ms >= 0),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RETRY','COMPLETE')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  last_reason TEXT,
  PRIMARY KEY(decision_key,horizon),
  FOREIGN KEY(decision_key) REFERENCES mvp_decisions(decision_key),
  CHECK(state='COMPLETE' OR next_attempt_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS mvp_outcome_due ON mvp_outcome_jobs(state,next_attempt_at,due_at);
CREATE TABLE IF NOT EXISTS mvp_outcome_attempts (
  decision_key TEXT NOT NULL,
  horizon TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL CHECK(attempted_at >= 0),
  result_kind TEXT NOT NULL CHECK(result_kind IN ('COMPLETE','MISSING','INVALID')),
  reason TEXT NOT NULL,
  source_timestamp INTEGER,
  price_usd REAL,
  liquidity_usd REAL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  PRIMARY KEY(decision_key,horizon,run_id),
  FOREIGN KEY(decision_key,horizon) REFERENCES mvp_outcome_jobs(decision_key,horizon)
);
CREATE INDEX IF NOT EXISTS mvp_outcome_attempt_history ON mvp_outcome_attempts(decision_key,horizon,attempted_at);
CREATE TABLE IF NOT EXISTS mvp_outcomes (
  decision_key TEXT NOT NULL,
  horizon TEXT NOT NULL,
  run_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  allowed_lag_ms INTEGER NOT NULL,
  source_timestamp INTEGER NOT NULL,
  collected_at INTEGER NOT NULL,
  source_lag_ms INTEGER NOT NULL CHECK(source_lag_ms >= 0),
  capture_lag_ms INTEGER NOT NULL CHECK(capture_lag_ms >= 0),
  price_usd REAL NOT NULL CHECK(price_usd >= 0),
  liquidity_usd REAL NOT NULL CHECK(liquidity_usd >= 0),
  return_pct REAL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  PRIMARY KEY(decision_key,horizon),
  FOREIGN KEY(decision_key,horizon) REFERENCES mvp_outcome_jobs(decision_key,horizon),
  CHECK(source_timestamp >= due_at AND source_timestamp <= due_at + allowed_lag_ms),
  CHECK(collected_at >= source_timestamp),
  CHECK(source_lag_ms = source_timestamp - due_at),
  CHECK(capture_lag_ms = collected_at - due_at)
);
-- Canonical features and evidence are append-only. Outcome jobs alone are mutable.
CREATE TRIGGER IF NOT EXISTS mvp_tokens_no_update BEFORE UPDATE ON mvp_tokens BEGIN SELECT RAISE(ABORT,'MVP_TOKEN_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_tokens_no_delete BEFORE DELETE ON mvp_tokens BEGIN SELECT RAISE(ABORT,'MVP_TOKEN_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_seen_no_update BEFORE UPDATE ON mvp_token_seen_events BEGIN SELECT RAISE(ABORT,'MVP_SEEN_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_seen_no_delete BEFORE DELETE ON mvp_token_seen_events BEGIN SELECT RAISE(ABORT,'MVP_SEEN_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decisions_no_update BEFORE UPDATE ON mvp_decisions BEGIN SELECT RAISE(ABORT,'MVP_DECISION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decisions_no_delete BEFORE DELETE ON mvp_decisions BEGIN SELECT RAISE(ABORT,'MVP_DECISION_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decision_events_no_update BEFORE UPDATE ON mvp_decision_events BEGIN SELECT RAISE(ABORT,'MVP_EVENT_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decision_events_no_delete BEFORE DELETE ON mvp_decision_events BEGIN SELECT RAISE(ABORT,'MVP_EVENT_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_outcome_attempts_no_update BEFORE UPDATE ON mvp_outcome_attempts BEGIN SELECT RAISE(ABORT,'MVP_OUTCOME_ATTEMPT_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_outcome_attempts_no_delete BEFORE DELETE ON mvp_outcome_attempts BEGIN SELECT RAISE(ABORT,'MVP_OUTCOME_ATTEMPT_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_outcomes_no_update BEFORE UPDATE ON mvp_outcomes BEGIN SELECT RAISE(ABORT,'MVP_OUTCOME_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_outcomes_no_delete BEFORE DELETE ON mvp_outcomes BEGIN SELECT RAISE(ABORT,'MVP_OUTCOME_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_outcome_jobs_no_delete BEFORE DELETE ON mvp_outcome_jobs BEGIN SELECT RAISE(ABORT,'MVP_OUTCOME_JOB_PRESERVED'); END;
CREATE TRIGGER IF NOT EXISTS mvp_outcome_job_identity_immutable BEFORE UPDATE ON mvp_outcome_jobs
WHEN NEW.decision_key IS NOT OLD.decision_key OR NEW.horizon IS NOT OLD.horizon OR NEW.due_at IS NOT OLD.due_at OR NEW.allowed_lag_ms IS NOT OLD.allowed_lag_ms
BEGIN SELECT RAISE(ABORT,'MVP_OUTCOME_JOB_IDENTITY_IMMUTABLE'); END;
-- Constant-time operational counters; append-only rows never need a COUNT scan.
CREATE TABLE IF NOT EXISTS mvp_stats (
  id INTEGER PRIMARY KEY CHECK(id=1),
  tokens_seen INTEGER NOT NULL DEFAULT 0,
  seen_events INTEGER NOT NULL DEFAULT 0,
  decisions INTEGER NOT NULL DEFAULT 0,
  decision_events INTEGER NOT NULL DEFAULT 0,
  outcome_jobs_pending INTEGER NOT NULL DEFAULT 0,
  outcome_jobs_retry INTEGER NOT NULL DEFAULT 0,
  outcome_jobs_complete INTEGER NOT NULL DEFAULT 0,
  outcome_attempts INTEGER NOT NULL DEFAULT 0,
  outcomes_complete INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO mvp_stats(id) VALUES(1);
CREATE TRIGGER IF NOT EXISTS mvp_stats_token_insert AFTER INSERT ON mvp_tokens
BEGIN UPDATE mvp_stats SET tokens_seen=tokens_seen+1,updated_at=max(updated_at,NEW.first_seen_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_stats_seen_insert AFTER INSERT ON mvp_token_seen_events
BEGIN UPDATE mvp_stats SET seen_events=seen_events+1,updated_at=max(updated_at,NEW.seen_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_stats_decision_insert AFTER INSERT ON mvp_decisions
BEGIN UPDATE mvp_stats SET decisions=decisions+1,updated_at=max(updated_at,NEW.first_decision_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_stats_decision_event_insert AFTER INSERT ON mvp_decision_events
BEGIN UPDATE mvp_stats SET decision_events=decision_events+1,updated_at=max(updated_at,NEW.observed_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_stats_job_insert AFTER INSERT ON mvp_outcome_jobs
BEGIN UPDATE mvp_stats SET outcome_jobs_pending=outcome_jobs_pending+(NEW.state='PENDING'),
  outcome_jobs_retry=outcome_jobs_retry+(NEW.state='RETRY'),outcome_jobs_complete=outcome_jobs_complete+(NEW.state='COMPLETE') WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_stats_job_transition AFTER UPDATE OF state ON mvp_outcome_jobs WHEN NEW.state!=OLD.state
BEGIN UPDATE mvp_stats SET outcome_jobs_pending=outcome_jobs_pending+(NEW.state='PENDING')-(OLD.state='PENDING'),
  outcome_jobs_retry=outcome_jobs_retry+(NEW.state='RETRY')-(OLD.state='RETRY'),
  outcome_jobs_complete=outcome_jobs_complete+(NEW.state='COMPLETE')-(OLD.state='COMPLETE'),
  updated_at=max(updated_at,coalesce(NEW.last_attempt_at,0)) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_stats_attempt_insert AFTER INSERT ON mvp_outcome_attempts
BEGIN UPDATE mvp_stats SET outcome_attempts=outcome_attempts+1,updated_at=max(updated_at,NEW.attempted_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_stats_outcome_insert AFTER INSERT ON mvp_outcomes
BEGIN UPDATE mvp_stats SET outcomes_complete=outcomes_complete+1,updated_at=max(updated_at,NEW.collected_at) WHERE id=1; END;
