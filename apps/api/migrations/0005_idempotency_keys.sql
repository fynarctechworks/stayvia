-- Idempotency-key cache for mutation endpoints. A retry with the same
-- (user, route, key) returns the stored response instead of re-executing
-- the handler, preventing duplicate payments / credit applications.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  route_key     TEXT NOT NULL,
  key           TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys (expires_at);
