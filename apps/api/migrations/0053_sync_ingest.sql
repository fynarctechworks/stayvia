-- Phase 2 cloud-side sync ingest. Runs on the CLOUD (VPS) database only — the
-- passive replica the desk pushes to. Idempotent.
--
-- sync_applied_log is the permanent, TTL-free dedup key. Every change the desk
-- pushes carries (origin_device_id, change_seq); the ingest applies each change
-- in the SAME transaction that inserts its applied-log row (ON CONFLICT DO
-- NOTHING). A replayed batch after a lost ack is a guaranteed no-op regardless
-- of how long the outage lasted — this is what makes offline->online safe
-- across a multi-day outage (the 24h idempotency_keys table can't).

CREATE TABLE IF NOT EXISTS sync_applied_log (
  origin_device_id text   NOT NULL,
  change_seq       bigint NOT NULL,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (origin_device_id, change_seq)
);

-- Per-device push tokens. The desk authenticates /sync/ingest with a token the
-- operator provisions here; revoke by setting revoked_at. Never ship the
-- Supabase service-role key to a desk — this scoped token is all it needs.
CREATE TABLE IF NOT EXISTS sync_devices (
  device_id   text PRIMARY KEY,
  token_hash  text NOT NULL,            -- sha256 of the bearer token
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  last_seen_at timestamptz
);
