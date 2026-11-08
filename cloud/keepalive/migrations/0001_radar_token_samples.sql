-- Reference schema for the existing D1 database solana-radar-archive.
-- Already applied manually through Cloudflare Console on 2026-11-08.
-- Do NOT drop/recreate the production table; statements are idempotent.
CREATE TABLE IF NOT EXISTS radar_token_samples (
    bucket_at INTEGER NOT NULL,
    mint TEXT NOT NULL,
    last_observed_at TEXT,
    observed_events INTEGER NOT NULL DEFAULT 0,
    buys_60s INTEGER NOT NULL DEFAULT 0,
    sells_60s INTEGER NOT NULL DEFAULT 0,
    estimated_fdv_usd REAL,
    fdv_status TEXT NOT NULL,
    coverage TEXT NOT NULL DEFAULT 'PARTIAL',
    PRIMARY KEY (bucket_at, mint)
);

CREATE INDEX IF NOT EXISTS idx_radar_mint_history
ON radar_token_samples (mint, bucket_at DESC);
