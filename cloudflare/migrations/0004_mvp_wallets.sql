-- Phase 3 adds permanent wallet evidence without changing legacy schemas.
CREATE TABLE IF NOT EXISTS mvp_wallet_events (
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  block_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL CHECK(log_index>=0),
  transaction_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL CHECK(block_number>=0),
  token_address TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('SWAP','TRANSFER')),
  observed_at INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  PRIMARY KEY(chain_id,block_hash,log_index)
);
CREATE INDEX IF NOT EXISTS mvp_wallet_event_tx ON mvp_wallet_events(chain_id,transaction_hash,block_hash,log_index);
CREATE INDEX IF NOT EXISTS mvp_wallet_event_token ON mvp_wallet_events(chain_id,token_address,block_number DESC);
CREATE TRIGGER IF NOT EXISTS mvp_wallet_event_conflict BEFORE INSERT ON mvp_wallet_events
WHEN EXISTS(SELECT 1 FROM mvp_wallet_events WHERE chain_id=NEW.chain_id AND block_hash=NEW.block_hash AND log_index=NEW.log_index AND fingerprint!=NEW.fingerprint)
BEGIN SELECT RAISE(ABORT,'WALLET_EVENT_CONFLICT'); END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_event_no_update BEFORE UPDATE ON mvp_wallet_events
BEGIN SELECT RAISE(ABORT,'WALLET_EVENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_event_no_delete BEFORE DELETE ON mvp_wallet_events
BEGIN SELECT RAISE(ABORT,'WALLET_EVENT_APPEND_ONLY'); END;
CREATE TABLE IF NOT EXISTS mvp_wallet_ranges (
  run_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  kind TEXT NOT NULL CHECK(kind IN ('SWAP','TRANSFER')),
  token_address TEXT NOT NULL,
  source_address TEXT NOT NULL,
  from_block INTEGER NOT NULL,
  to_block INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  range_json TEXT NOT NULL CHECK(json_valid(range_json)),
  PRIMARY KEY(run_id,chain_id,kind,token_address,source_address,from_block,to_block)
);
CREATE TRIGGER IF NOT EXISTS mvp_wallet_range_no_update BEFORE UPDATE ON mvp_wallet_ranges
BEGIN SELECT RAISE(ABORT,'WALLET_RANGE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_range_no_delete BEFORE DELETE ON mvp_wallet_ranges
BEGIN SELECT RAISE(ABORT,'WALLET_RANGE_APPEND_ONLY'); END;
CREATE TABLE IF NOT EXISTS mvp_wallet_receipts (
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  transaction_hash TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  wallet_address TEXT,
  generation INTEGER NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  PRIMARY KEY(chain_id,transaction_hash,block_hash,generation)
);
CREATE INDEX IF NOT EXISTS mvp_wallet_receipt_wallet ON mvp_wallet_receipts(chain_id,wallet_address,generation,block_number,transaction_hash);
CREATE TRIGGER IF NOT EXISTS mvp_wallet_receipt_no_update BEFORE UPDATE ON mvp_wallet_receipts
BEGIN SELECT RAISE(ABORT,'WALLET_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_receipt_no_delete BEFORE DELETE ON mvp_wallet_receipts
BEGIN SELECT RAISE(ABORT,'WALLET_RECEIPT_APPEND_ONLY'); END;
CREATE TABLE IF NOT EXISTS mvp_wallet_receipt_jobs (
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  transaction_hash TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RETRY','COMPLETE')),
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_reason TEXT,
  PRIMARY KEY(chain_id,transaction_hash,block_hash)
);
CREATE INDEX IF NOT EXISTS mvp_wallet_receipt_due ON mvp_wallet_receipt_jobs(state,next_attempt_at,block_number DESC);
CREATE TABLE IF NOT EXISTS mvp_wallet_token_members (
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  token_address TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  PRIMARY KEY(chain_id,token_address,wallet_address)
);
CREATE TABLE IF NOT EXISTS mvp_wallet_epoch (
  id INTEGER PRIMARY KEY CHECK(id=1),
  generation INTEGER NOT NULL DEFAULT 0,
  last_reorg_at INTEGER
);
INSERT OR IGNORE INTO mvp_wallet_epoch(id) VALUES(1);
CREATE TABLE IF NOT EXISTS mvp_wallet_reorgs (
  run_id TEXT PRIMARY KEY,
  observed_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS mvp_wallet_reorg_epoch AFTER INSERT ON mvp_wallet_reorgs
BEGIN UPDATE mvp_wallet_epoch SET generation=generation+1,last_reorg_at=NEW.observed_at WHERE id=1; END;
CREATE TABLE IF NOT EXISTS mvp_wallet_profile_events (
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  wallet_address TEXT NOT NULL,
  run_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  PRIMARY KEY(chain_id,wallet_address,run_id)
);
CREATE TRIGGER IF NOT EXISTS mvp_wallet_profile_event_no_update BEFORE UPDATE ON mvp_wallet_profile_events
BEGIN SELECT RAISE(ABORT,'WALLET_PROFILE_EVENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_profile_event_conflict BEFORE INSERT ON mvp_wallet_profile_events
WHEN EXISTS(SELECT 1 FROM mvp_wallet_profile_events WHERE chain_id=NEW.chain_id AND wallet_address=NEW.wallet_address AND run_id=NEW.run_id AND profile_json!=NEW.profile_json)
BEGIN SELECT RAISE(ABORT,'WALLET_PROFILE_CONFLICT'); END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_profile_event_no_delete BEFORE DELETE ON mvp_wallet_profile_events
BEGIN SELECT RAISE(ABORT,'WALLET_PROFILE_EVENT_APPEND_ONLY'); END;
CREATE TABLE IF NOT EXISTS mvp_wallet_profiles (
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  wallet_address TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
  eligible INTEGER NOT NULL DEFAULT 0 CHECK(eligible IN (0,1)),
  PRIMARY KEY(chain_id,wallet_address)
);
CREATE INDEX IF NOT EXISTS mvp_wallet_profile_recent ON mvp_wallet_profiles(generation,checked_at DESC,wallet_address);
CREATE TABLE IF NOT EXISTS mvp_wallet_stats (
  id INTEGER PRIMARY KEY CHECK(id=1),
  events INTEGER NOT NULL DEFAULT 0,
  ranges INTEGER NOT NULL DEFAULT 0,
  receipts INTEGER NOT NULL DEFAULT 0,
  profile_observations INTEGER NOT NULL DEFAULT 0,
  tracked INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO mvp_wallet_stats(id) VALUES(1);
CREATE TRIGGER IF NOT EXISTS mvp_wallet_stats_event AFTER INSERT ON mvp_wallet_events
BEGIN UPDATE mvp_wallet_stats SET events=events+1,updated_at=max(updated_at,NEW.observed_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_stats_range AFTER INSERT ON mvp_wallet_ranges
BEGIN UPDATE mvp_wallet_stats SET ranges=ranges+1,updated_at=max(updated_at,NEW.observed_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_stats_receipt AFTER INSERT ON mvp_wallet_receipts
BEGIN UPDATE mvp_wallet_stats SET receipts=receipts+1,updated_at=max(updated_at,NEW.observed_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_stats_profile AFTER INSERT ON mvp_wallet_profile_events
BEGIN UPDATE mvp_wallet_stats SET profile_observations=profile_observations+1,updated_at=max(updated_at,NEW.observed_at) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_stats_profile_tracked AFTER INSERT ON mvp_wallet_profiles
BEGIN UPDATE mvp_wallet_stats SET tracked=tracked+1,eligible=eligible+NEW.eligible WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_stats_profile_updated AFTER UPDATE ON mvp_wallet_profiles
BEGIN UPDATE mvp_wallet_stats SET eligible=eligible
  +(CASE WHEN NEW.generation=(SELECT generation FROM mvp_wallet_epoch WHERE id=1) THEN NEW.eligible ELSE 0 END)
  -(CASE WHEN OLD.generation=(SELECT generation FROM mvp_wallet_epoch WHERE id=1) THEN OLD.eligible ELSE 0 END) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_reorg_eligible AFTER INSERT ON mvp_wallet_reorgs
BEGIN UPDATE mvp_wallet_stats SET eligible=0 WHERE id=1; END;
