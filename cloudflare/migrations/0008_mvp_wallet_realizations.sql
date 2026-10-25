-- Derived, fully reconciled disposal evidence. Earlier wallet tables stay intact.
CREATE TABLE IF NOT EXISTS mvp_wallet_realizations (
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  wallet_address TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0),
  event_id TEXT NOT NULL,
  disposal_index INTEGER NOT NULL CHECK(disposal_index>0),
  block_number INTEGER NOT NULL CHECK(block_number>=0),
  block_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  event_timestamp INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  PRIMARY KEY(chain_id,wallet_address,generation,event_id),
  UNIQUE(chain_id,wallet_address,generation,disposal_index)
);
CREATE TRIGGER IF NOT EXISTS mvp_wallet_realization_conflict BEFORE INSERT ON mvp_wallet_realizations
WHEN EXISTS(SELECT 1 FROM mvp_wallet_realizations WHERE chain_id=NEW.chain_id
  AND wallet_address=NEW.wallet_address AND generation=NEW.generation
  AND (event_id=NEW.event_id OR disposal_index=NEW.disposal_index)
  AND fingerprint!=NEW.fingerprint)
BEGIN SELECT RAISE(ABORT,'WALLET_REALIZATION_CONFLICT'); END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_realization_no_update BEFORE UPDATE ON mvp_wallet_realizations
BEGIN SELECT RAISE(ABORT,'WALLET_REALIZATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_realization_no_delete BEFORE DELETE ON mvp_wallet_realizations
BEGIN SELECT RAISE(ABORT,'WALLET_REALIZATION_APPEND_ONLY'); END;

-- This projection is bounded per method/half-life, irrespective of lifetime trades.
CREATE TABLE IF NOT EXISTS mvp_wallet_temporal_summaries (
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  wallet_address TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0),
  score_version TEXT NOT NULL,
  half_life_days INTEGER NOT NULL CHECK(half_life_days BETWEEN 1 AND 365),
  disposal_count INTEGER NOT NULL CHECK(disposal_count>0),
  observed_at INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  PRIMARY KEY(chain_id,wallet_address,generation,score_version,half_life_days)
);
-- A fixed-size guard makes stale read/modify/write preparations abort atomically.
CREATE TABLE IF NOT EXISTS mvp_wallet_temporal_guard (
  id INTEGER PRIMARY KEY CHECK(id=1),
  ok INTEGER NOT NULL CHECK(ok=1)
);
