-- Additive baseline canonicality. Record a D1 Time Travel bookmark before apply.
-- Original decisions, events, attempts and outcomes remain immutable.
CREATE TABLE IF NOT EXISTS mvp_decision_epoch (
  id INTEGER PRIMARY KEY CHECK(id=1),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  last_reorg_at INTEGER,
  revalidation_complete INTEGER NOT NULL DEFAULT 1 CHECK(revalidation_complete IN (0,1)),
  invalidated_decisions INTEGER NOT NULL DEFAULT 0 CHECK(invalidated_decisions>=0)
);
INSERT OR IGNORE INTO mvp_decision_epoch(id) VALUES(1);
CREATE TABLE IF NOT EXISTS mvp_decision_reorgs (
  run_id TEXT PRIMARY KEY,
  observed_at INTEGER NOT NULL CHECK(observed_at>=0),
  prior_block_number INTEGER CHECK(prior_block_number>=0),
  prior_block_hash TEXT,
  canonical_block_hash TEXT
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS mvp_decision_reorg_epoch AFTER INSERT ON mvp_decision_reorgs
BEGIN UPDATE mvp_decision_epoch SET generation=generation+1,last_reorg_at=NEW.observed_at,revalidation_complete=0 WHERE id=1; END;
CREATE TABLE IF NOT EXISTS mvp_decision_chain_refs (
  decision_key TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  block_number INTEGER NOT NULL CHECK(block_number>=0),
  block_hash TEXT NOT NULL CHECK(length(block_hash)=66 AND block_hash=lower(block_hash)
    AND substr(block_hash,1,2)='0x' AND substr(block_hash,3) NOT GLOB '*[^0-9a-f]*'),
  recorded_generation INTEGER NOT NULL CHECK(recorded_generation>=0),
  recorded_at INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  FOREIGN KEY(decision_key) REFERENCES mvp_decisions(decision_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS mvp_decision_refs_block ON mvp_decision_chain_refs(chain_id,block_number,block_hash,recorded_generation);
-- All paths derive the reference from the immutable FIRST decision. A later
-- observation of the same key cannot attach its block to an orphaned baseline.
CREATE VIEW IF NOT EXISTS mvp_decision_chain_candidates AS
SELECT decision_key,chain_id,first_decision_at,first_run_id,
  coalesce(json_extract(source_json,'$.provenance.blockNumber'),
    json_extract(features_json,'$.values.snapshot.chainState.blockNumber'),
    json_extract(features_json,'$.values.chainState.blockNumber')) AS block_number,
  lower(coalesce(json_extract(source_json,'$.provenance.blockHash'),
    json_extract(features_json,'$.values.snapshot.chainState.blockHash'),
    json_extract(features_json,'$.values.chainState.blockHash'))) AS block_hash
FROM mvp_decisions;
INSERT OR IGNORE INTO mvp_decision_chain_refs
  (decision_key,chain_id,block_number,block_hash,recorded_generation,recorded_at,run_id)
SELECT decision_key,chain_id,block_number,block_hash,0,first_decision_at,first_run_id
FROM mvp_decision_chain_candidates
WHERE chain_id=4663 AND typeof(block_number)='integer' AND block_number>=0
  AND length(block_hash)=66 AND substr(block_hash,1,2)='0x' AND substr(block_hash,3) NOT GLOB '*[^0-9a-f]*';
CREATE TRIGGER IF NOT EXISTS mvp_decision_ref_insert AFTER INSERT ON mvp_decisions
BEGIN
  INSERT OR IGNORE INTO mvp_decision_chain_refs
    (decision_key,chain_id,block_number,block_hash,recorded_generation,recorded_at,run_id)
  SELECT decision_key,chain_id,block_number,block_hash,(SELECT generation FROM mvp_decision_epoch WHERE id=1),first_decision_at,first_run_id
  FROM mvp_decision_chain_candidates WHERE decision_key=NEW.decision_key
    AND chain_id=4663 AND typeof(block_number)='integer' AND block_number>=0
    AND length(block_hash)=66 AND substr(block_hash,1,2)='0x' AND substr(block_hash,3) NOT GLOB '*[^0-9a-f]*';
END;
CREATE TABLE IF NOT EXISTS mvp_decision_block_checks (
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  block_number INTEGER NOT NULL CHECK(block_number>=0),
  generation INTEGER NOT NULL CHECK(generation>=0),
  block_hash TEXT NOT NULL CHECK(length(block_hash)=66 AND block_hash=lower(block_hash)
    AND substr(block_hash,1,2)='0x' AND substr(block_hash,3) NOT GLOB '*[^0-9a-f]*'),
  checked_at INTEGER NOT NULL CHECK(checked_at>=0),
  run_id TEXT NOT NULL,
  PRIMARY KEY(chain_id,block_number,generation)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS mvp_decision_invalidations (
  decision_key TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK(reason='ORPHANED_BASELINE_BLOCK'),
  observed_at INTEGER NOT NULL CHECK(observed_at>=0),
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0),
  orphaned_block_hash TEXT NOT NULL,
  canonical_block_hash TEXT NOT NULL,
  FOREIGN KEY(decision_key) REFERENCES mvp_decisions(decision_key)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS mvp_decision_invalidation_count AFTER INSERT ON mvp_decision_invalidations
BEGIN UPDATE mvp_decision_epoch SET invalidated_decisions=invalidated_decisions+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS mvp_decision_block_check_conflict BEFORE INSERT ON mvp_decision_block_checks
WHEN EXISTS(SELECT 1 FROM mvp_decision_block_checks c WHERE c.chain_id=NEW.chain_id
  AND c.block_number=NEW.block_number AND c.generation=NEW.generation AND c.block_hash!=NEW.block_hash)
BEGIN SELECT RAISE(ABORT,'MVP_CANONICAL_BLOCK_CONFLICT'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decision_reorg_no_update BEFORE UPDATE ON mvp_decision_reorgs BEGIN SELECT RAISE(ABORT,'MVP_REORG_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decision_reorg_no_delete BEFORE DELETE ON mvp_decision_reorgs BEGIN SELECT RAISE(ABORT,'MVP_REORG_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decision_ref_no_update BEFORE UPDATE ON mvp_decision_chain_refs BEGIN SELECT RAISE(ABORT,'MVP_CHAIN_REF_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decision_ref_no_delete BEFORE DELETE ON mvp_decision_chain_refs BEGIN SELECT RAISE(ABORT,'MVP_CHAIN_REF_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decision_check_no_update BEFORE UPDATE ON mvp_decision_block_checks BEGIN SELECT RAISE(ABORT,'MVP_CANONICAL_CHECK_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decision_check_no_delete BEFORE DELETE ON mvp_decision_block_checks BEGIN SELECT RAISE(ABORT,'MVP_CANONICAL_CHECK_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decision_invalidation_no_update BEFORE UPDATE ON mvp_decision_invalidations BEGIN SELECT RAISE(ABORT,'MVP_INVALIDATION_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_decision_invalidation_no_delete BEFORE DELETE ON mvp_decision_invalidations BEGIN SELECT RAISE(ABORT,'MVP_INVALIDATION_APPEND_ONLY'); END;
