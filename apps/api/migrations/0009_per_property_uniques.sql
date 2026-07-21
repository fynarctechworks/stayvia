-- Scope two remaining GLOBAL uniques to the property.
--
-- The 0001 baseline header states: "Every previously-global unique is scoped
-- per property: room numbers, guest phone/email/id-proof dedup,
-- reservation/invoice/receipt numbers, room-type slugs, template keys, role
-- keys." Two were missed.
--
-- 1. amenities.key — `key text NOT NULL UNIQUE`. amenities.property_id is
--    nullable (NULL = platform catalog, NOT NULL = hotel-custom), so this is
--    the same shape as `roles`, which correctly uses two partial uniques. As
--    it stood, the first hotel to create a custom amenity keyed 'rooftop_pool'
--    permanently denied that key to every other hotel, and the unscoped
--    existence check in routes/amenities.ts leaked that another tenant held it.
--
-- 2. maintenance_tickets.ticket_number — global UNIQUE. The table is not yet
--    referenced by any code, so this is latent rather than live: the moment the
--    module is wired to lib/numbers.ts (which allocates per-hotel via
--    property_counters) two hotels would each allocate MT-0001 and whichever
--    onboarded second would hard-fail on its first ticket. Fixing it while the
--    table is still empty avoids needing the destructive-SQL approval path
--    once real hotels exist.
--
-- Idempotent: safe to re-run.

-- --- amenities -------------------------------------------------------------
-- The baseline created the unique inline, so the constraint name is
-- Postgres-generated (amenities_key_key). Drop defensively by both spellings.
ALTER TABLE amenities DROP CONSTRAINT IF EXISTS amenities_key_key;
DROP INDEX IF EXISTS amenities_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_amenities_shared_key
  ON amenities (key) WHERE property_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_amenities_property_key
  ON amenities (property_id, key) WHERE property_id IS NOT NULL;

-- --- maintenance_tickets ---------------------------------------------------
ALTER TABLE maintenance_tickets DROP CONSTRAINT IF EXISTS maintenance_tickets_ticket_number_key;
DROP INDEX IF EXISTS maintenance_tickets_ticket_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_tickets_property_number
  ON maintenance_tickets (property_id, ticket_number);
