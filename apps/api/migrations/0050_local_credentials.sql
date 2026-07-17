-- Offline desktop credentials. One row per staff profile that can log in on
-- the embedded/offline desk. Provisioned during an online session so the same
-- people can log in offline. Idempotent.

CREATE TABLE IF NOT EXISTS local_credentials (
  profile_id      uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  password_hash   text,
  pin_hash        text,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
