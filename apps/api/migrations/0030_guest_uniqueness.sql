-- Lock down guest identifier uniqueness at the DB level.
--
-- API rejects duplicates with 409 (DUPLICATE_PHONE / DUPLICATE_EMAIL /
-- DUPLICATE_ID) on POST + PUT, but two near-simultaneous creates could
-- both pass the SELECT and race-insert two rows past the application
-- check. These indexes make that impossible — Postgres rejects the
-- second INSERT with SQLSTATE 23505, which the route handler turns
-- into the same 409.
--
-- Email: partial index — NULL or empty emails are not constrained
-- (many walk-ins don't have one).
-- ID: enforced as the (type, last4) pair — different ID types with
-- the same 4-digit suffix are fine, two Aadhaars sharing a suffix
-- are not.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_email_unique
  ON guests (LOWER(email))
  WHERE email IS NOT NULL AND email <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_idproof_unique
  ON guests (id_proof_type, id_proof_last4)
  WHERE id_proof_last4 IS NOT NULL AND id_proof_last4 <> '';
