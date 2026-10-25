-- Additive immutable archive of actual freshly fetched market observations.
-- Apply only after a database backup. No existing rows or schemas are replaced.
-- One source point can serve several decision versions after a delayed job;
-- its source time is never changed to the later collection time.
CREATE TABLE IF NOT EXISTS mvp_market_observations (
  observation_key TEXT PRIMARY KEY CHECK(length(observation_key)=64),
  chain_id INTEGER NOT NULL CHECK(chain_id=4663),
  address TEXT NOT NULL CHECK(length(address)=42 AND address=lower(address)),
  pair_address TEXT NOT NULL CHECK(length(pair_address) IN (42,66) AND pair_address=lower(pair_address)),
  provider TEXT NOT NULL CHECK(provider='dexscreener'),
  quote_address TEXT NOT NULL CHECK(length(quote_address)=42 AND quote_address=lower(quote_address)),
  source_timestamp INTEGER NOT NULL CHECK(source_timestamp>=0),
  collected_at INTEGER NOT NULL CHECK(collected_at>=source_timestamp),
  price_usd REAL NOT NULL CHECK(price_usd>=0),
  liquidity_usd REAL NOT NULL CHECK(liquidity_usd>=0),
  run_id TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json))
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS mvp_market_observation_window
  ON mvp_market_observations(chain_id,address,source_timestamp,collected_at);
CREATE TRIGGER IF NOT EXISTS mvp_market_observation_no_update BEFORE UPDATE ON mvp_market_observations
BEGIN SELECT RAISE(ABORT,'MVP_MARKET_OBSERVATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_market_observation_no_delete BEFORE DELETE ON mvp_market_observations
BEGIN SELECT RAISE(ABORT,'MVP_MARKET_OBSERVATION_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS mvp_market_observation_conflict BEFORE INSERT ON mvp_market_observations
WHEN EXISTS(SELECT 1 FROM mvp_market_observations m WHERE m.observation_key=NEW.observation_key
  AND (m.chain_id IS NOT NEW.chain_id OR m.address IS NOT NEW.address OR m.pair_address IS NOT NEW.pair_address
    OR m.provider IS NOT NEW.provider OR m.source_timestamp IS NOT NEW.source_timestamp
    OR m.price_usd IS NOT NEW.price_usd OR m.liquidity_usd IS NOT NEW.liquidity_usd))
BEGIN SELECT RAISE(ABORT,'MVP_MARKET_OBSERVATION_CONFLICT'); END;
-- Supports future capture-window maintenance without changing the existing API.
CREATE INDEX IF NOT EXISTS mvp_outcome_capture_window
  ON mvp_outcome_jobs((due_at+allowed_lag_ms),next_attempt_at,due_at)
  WHERE state IN ('PENDING','RETRY');
