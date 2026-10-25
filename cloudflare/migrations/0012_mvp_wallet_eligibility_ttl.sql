-- Additive covering index for the current-generation/profile-TTL count.
-- Existing immutable profile events and historical counters remain unchanged.
CREATE INDEX IF NOT EXISTS mvp_wallet_profile_current_eligible
  ON mvp_wallet_profiles(chain_id,generation,eligible,checked_at);
