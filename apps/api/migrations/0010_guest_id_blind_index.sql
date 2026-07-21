-- Replace the last-4-digit guest ID dedup with a blind index over the FULL
-- ID number.
--
-- THE BUG: uq_guests_property_idproof was UNIQUE on
-- (property_id, id_proof_type, id_proof_last4) — only the last four digits.
-- There are just 10,000 possible values, so two unrelated real people holding
-- the same ID type at one hotel collide. By the birthday bound a hotel passes
-- 50% probability of at least one colliding pair at ~118 guests and is
-- effectively certain past ~600.
--
-- The effect was not a warning but a hard stop: routes/guests.ts pre-checks the
-- same tuple and returns 409 DUPLICATE_ID ("A guest with the same ID number
-- already exists. Use the existing profile instead."), and bypassing that hits
-- 23505 on the index. The desk's only way to finish the check-in was to follow
-- the message and book the stay onto a STRANGER's profile — putting the wrong
-- person's encrypted ID, KYC photos and name on the reservation and the GST
-- invoice.
--
-- THE FIX: a deterministic keyed hash (blind index) of the full, normalised ID
-- number. It is not reversible, so it leaks nothing the encrypted column
-- protects, but equal IDs produce equal hashes, which is all dedup needs.
-- id_proof_last4 stays for display and search only.
--
-- BACKFILL: intentionally none. id_proof_number is stored ENCRYPTED, so the
-- plaintext needed to compute the hash is not available to SQL. Existing rows
-- keep a NULL hash and are simply not hash-deduped; the unique index is
-- partial (WHERE id_proof_hash IS NOT NULL) so they never collide with each
-- other or with new rows. The API fills the column going forward, and any
-- existing guest re-saved through PUT /guests/:id picks one up. This is safe
-- because the OLD constraint is dropped in the same migration — the false
-- collisions stop immediately either way.

ALTER TABLE guests ADD COLUMN IF NOT EXISTS id_proof_hash text;

-- Drop the last-4 unique. It is an index (created via CREATE UNIQUE INDEX in
-- the baseline), but drop defensively as a constraint too.
ALTER TABLE guests DROP CONSTRAINT IF EXISTS uq_guests_property_idproof;
DROP INDEX IF EXISTS uq_guests_property_idproof;

CREATE UNIQUE INDEX IF NOT EXISTS uq_guests_property_idproof_hash
  ON guests (property_id, id_proof_type, id_proof_hash)
  WHERE id_proof_hash IS NOT NULL;

-- Lookup path for the application-side duplicate probe.
CREATE INDEX IF NOT EXISTS idx_guests_property_idproof_hash
  ON guests (property_id, id_proof_hash);
