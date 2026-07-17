-- Adds ip_address to otps so per-IP throttling has a column to count on.
-- Nullable + indexed for fast time-window queries.

ALTER TABLE otps ADD COLUMN IF NOT EXISTS ip_address TEXT;

CREATE INDEX IF NOT EXISTS idx_otps_ip_created
  ON otps (ip_address, created_at);
