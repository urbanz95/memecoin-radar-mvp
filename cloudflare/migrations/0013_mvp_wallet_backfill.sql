-- Additive, resumable ERC20 discovery. A completed scan never proves complete
-- native/internal history, opening equity, fees or financial accounting.
CREATE TABLE IF NOT EXISTS mvp_wallet_backfill_jobs (
  job_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  generation INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1),
  state TEXT NOT NULL CHECK(state IN ('BOUNDARY','SCANNING','COMPLETE','RETRY','REORG')),
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_reason TEXT,
  job_json TEXT NOT NULL,
  last_run_id TEXT NOT NULL,
  last_token TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mvp_wallet_backfill_due
  ON mvp_wallet_backfill_jobs(generation,state,next_attempt_at,updated_at);
CREATE INDEX IF NOT EXISTS mvp_wallet_backfill_wallet
  ON mvp_wallet_backfill_jobs(wallet_address,generation,updated_at);

-- Full accepted responses are paged durably before their ledger events are
-- consumed. In particular, a dense single block is never sliced and discarded.
CREATE TABLE IF NOT EXISTS mvp_wallet_backfill_pages (
  job_id TEXT NOT NULL REFERENCES mvp_wallet_backfill_jobs(job_id),
  page_key TEXT NOT NULL,
  from_block INTEGER NOT NULL,
  to_block INTEGER NOT NULL,
  direction INTEGER NOT NULL CHECK(direction IN (0,1)),
  logs_json TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor>=0),
  log_count INTEGER NOT NULL CHECK(log_count>=0),
  PRIMARY KEY(job_id,page_key)
);
CREATE INDEX IF NOT EXISTS mvp_wallet_backfill_pages_pending
  ON mvp_wallet_backfill_pages(job_id,from_block,direction,page_key);
CREATE TRIGGER IF NOT EXISTS mvp_wallet_backfill_page_immutable
  BEFORE UPDATE OF logs_json,log_count,from_block,to_block,direction ON mvp_wallet_backfill_pages
  BEGIN SELECT RAISE(ABORT,'WALLET_BACKFILL_PAGE_IMMUTABLE'); END;

CREATE TABLE IF NOT EXISTS mvp_wallet_backfill_seen (
  job_id TEXT NOT NULL REFERENCES mvp_wallet_backfill_jobs(job_id),
  block_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(job_id,block_hash,log_index)
);
CREATE TRIGGER IF NOT EXISTS mvp_wallet_backfill_seen_conflict
  BEFORE INSERT ON mvp_wallet_backfill_seen
  WHEN EXISTS(SELECT 1 FROM mvp_wallet_backfill_seen WHERE job_id=NEW.job_id
    AND block_hash=NEW.block_hash AND log_index=NEW.log_index AND fingerprint!=NEW.fingerprint)
  BEGIN SELECT RAISE(ABORT,'WALLET_BACKFILL_EVENT_CONFLICT'); END;

-- Independent of observed SWAP jobs: Transfers discover transactions in any
-- contract, including contracts absent from the pool catalog.
CREATE TABLE IF NOT EXISTS mvp_wallet_backfill_receipt_queue (
  job_id TEXT NOT NULL REFERENCES mvp_wallet_backfill_jobs(job_id),
  transaction_hash TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RETRY','CAPTURED','COMPLETE')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_reason TEXT,
  receipt_json TEXT CHECK(receipt_json IS NULL OR length(CAST(receipt_json AS BLOB))<=131072),
  events_json TEXT CHECK(events_json IS NULL OR length(CAST(events_json AS BLOB))<=131072),
  event_cursor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(job_id,transaction_hash,block_hash)
);
CREATE INDEX IF NOT EXISTS mvp_wallet_backfill_receipts_due
  ON mvp_wallet_backfill_receipt_queue(job_id,state,next_attempt_at,block_number);
CREATE TABLE IF NOT EXISTS mvp_wallet_backfill_unresolved_receipts (
  job_id TEXT NOT NULL REFERENCES mvp_wallet_backfill_jobs(job_id),
  transaction_hash TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK(length(evidence_hash)=64),
  evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB))<=131072),
  PRIMARY KEY(job_id,transaction_hash,block_hash,observed_at,reason),
  UNIQUE(job_id,transaction_hash,block_hash,reason,evidence_hash)
);
CREATE TRIGGER IF NOT EXISTS mvp_wallet_backfill_archive_immutable
  BEFORE UPDATE ON mvp_wallet_backfill_unresolved_receipts
  BEGIN SELECT RAISE(ABORT,'WALLET_BACKFILL_ARCHIVE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS mvp_wallet_backfill_archive_append_only
  BEFORE DELETE ON mvp_wallet_backfill_unresolved_receipts
  BEGIN SELECT RAISE(ABORT,'WALLET_BACKFILL_ARCHIVE_APPEND_ONLY'); END;

-- Cursor compare-and-swap guard. The collector's outer lease fence remains
-- mandatory and encompasses these commands and the normal wallet ledger.
CREATE TABLE IF NOT EXISTS mvp_wallet_backfill_guard (
  id INTEGER PRIMARY KEY CHECK(id=1),
  ok INTEGER NOT NULL CONSTRAINT WALLET_BACKFILL_STALE_CURSOR CHECK(ok=1)
);
