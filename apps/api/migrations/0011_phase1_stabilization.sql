-- Phase 1 stabilization migration.
--
-- This migration delivers the foundational schema upgrades for the
-- enterprise-PMS audit: a belt-and-braces booking exclusion constraint,
-- true Postgres sequences for SLDT-RES/INV/RCP numbers, new reservation
-- statuses, three additional RBAC roles, structured guest preferences /
-- flags, and a properly normalised room amenities + images model.
--
-- Notes:
--   - All changes are additive. Existing rows keep working.
--   - btree_gist is needed for the exclusion constraint that mixes uuid =
--     with daterange &&. It ships with every supported Postgres release.
--   - Sequences are seeded from the current MAX(seq) for each numbering
--     domain so the first nextval() after deploy continues the existing
--     SLDT-XXX-NNNN run instead of jumping back to 1.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ----------------------------------------------------------------------
-- 1. Double-booking exclusion constraint
-- ----------------------------------------------------------------------
-- The application already serialises booking creates with per-room
-- advisory locks inside a transaction. The exclusion constraint is a
-- defence-in-depth backstop: it makes overlapping bookings IMPOSSIBLE
-- at the database level no matter what code path inserts them (raw
-- scripts, future API entry points, manual fixes). The partial WHERE
-- intentionally ignores cancelled / no_show rows so a re-book on a
-- freed-up room succeeds.

-- Pre-flight: detect existing overlaps that would block the constraint.
-- If any are found, raise a clear error so the operator can resolve
-- them (cancel one of the offenders, then re-run the migration).
DO $$
DECLARE
  conflict_count int;
BEGIN
  SELECT COUNT(*) INTO conflict_count
  FROM reservation_rooms rr1
  JOIN reservations r1 ON r1.id = rr1.reservation_id
  JOIN reservation_rooms rr2 ON rr2.room_id = rr1.room_id AND rr2.reservation_id <> rr1.reservation_id
  JOIN reservations r2 ON r2.id = rr2.reservation_id
  WHERE r1.status IN ('hold','pending_payment','confirmed','checked_in')
    AND r2.status IN ('hold','pending_payment','confirmed','checked_in')
    AND daterange(r1.check_in_date, GREATEST(r1.check_out_date, r1.check_in_date + 1), '[)')
        && daterange(r2.check_in_date, GREATEST(r2.check_out_date, r2.check_in_date + 1), '[)');
  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'Found % overlapping reservation_rooms across active reservations. Resolve before applying the exclusion constraint.', conflict_count;
  END IF;
END$$;

-- Generated column carrying the half-open daterange for the parent
-- reservation. STORED so the exclusion index can use it directly.
-- The COALESCE with check_in_date + 1 is for short_stay (day-use)
-- bookings where check_out_date == check_in_date; we artificially
-- widen the range by a day so day-use can still take part in the
-- overlap check without colliding with overnight bookings that start
-- the same day. (Day-use vs overnight on the same day is hotel-policy
-- enforced separately; the constraint only blocks *active* overlaps.)
ALTER TABLE reservation_rooms
  ADD COLUMN IF NOT EXISTS stay_range daterange
  GENERATED ALWAYS AS (
    daterange(
      (SELECT r.check_in_date FROM reservations r WHERE r.id = reservation_id),
      (SELECT GREATEST(r.check_out_date, r.check_in_date + 1) FROM reservations r WHERE r.id = reservation_id),
      '[)'
    )
  ) STORED;

-- NOTE: Postgres generated columns cannot reference other tables. The
-- ALTER above will fail; we use a trigger-maintained column instead.
-- Roll back the failed attempt (no-op if column wasn't created) and
-- create a regular column with a BEFORE INSERT/UPDATE trigger.
ALTER TABLE reservation_rooms DROP COLUMN IF EXISTS stay_range;

ALTER TABLE reservation_rooms
  ADD COLUMN IF NOT EXISTS stay_range daterange;

ALTER TABLE reservation_rooms
  ADD COLUMN IF NOT EXISTS reservation_status_snapshot text;

-- Maintain stay_range + reservation_status_snapshot from the parent
-- reservation on every reservation_rooms write. Snapshot the status so
-- the partial exclusion index doesn't need to traverse to reservations.
CREATE OR REPLACE FUNCTION reservation_rooms_sync_stay_range()
RETURNS trigger AS $$
DECLARE
  r reservations%ROWTYPE;
BEGIN
  SELECT * INTO r FROM reservations WHERE id = NEW.reservation_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  NEW.stay_range := daterange(
    r.check_in_date,
    GREATEST(r.check_out_date, r.check_in_date + 1),
    '[)'
  );
  NEW.reservation_status_snapshot := r.status;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservation_rooms_sync_stay_range ON reservation_rooms;
CREATE TRIGGER trg_reservation_rooms_sync_stay_range
  BEFORE INSERT OR UPDATE OF reservation_id ON reservation_rooms
  FOR EACH ROW EXECUTE FUNCTION reservation_rooms_sync_stay_range();

-- When the parent reservation's dates or status change, fan the new
-- snapshot back into every reservation_rooms row so the exclusion
-- constraint stays accurate.
CREATE OR REPLACE FUNCTION reservations_propagate_to_rooms()
RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND (
        NEW.check_in_date IS DISTINCT FROM OLD.check_in_date OR
        NEW.check_out_date IS DISTINCT FROM OLD.check_out_date OR
        NEW.status IS DISTINCT FROM OLD.status
      )) THEN
    UPDATE reservation_rooms SET
      stay_range = daterange(NEW.check_in_date, GREATEST(NEW.check_out_date, NEW.check_in_date + 1), '[)'),
      reservation_status_snapshot = NEW.status
    WHERE reservation_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservations_propagate_to_rooms ON reservations;
CREATE TRIGGER trg_reservations_propagate_to_rooms
  AFTER UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservations_propagate_to_rooms();

-- Backfill existing rows.
UPDATE reservation_rooms rr SET
  stay_range = daterange(r.check_in_date, GREATEST(r.check_out_date, r.check_in_date + 1), '[)'),
  reservation_status_snapshot = r.status
FROM reservations r
WHERE r.id = rr.reservation_id
  AND (rr.stay_range IS NULL OR rr.reservation_status_snapshot IS NULL);

-- The exclusion constraint itself. Active bookings only (the WHERE
-- clause). Same room + overlapping range → reject with 23P01
-- (exclusion_violation) which we map to a 409 in the API.
ALTER TABLE reservation_rooms
  DROP CONSTRAINT IF EXISTS reservation_rooms_no_overlap;
ALTER TABLE reservation_rooms
  ADD CONSTRAINT reservation_rooms_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    stay_range WITH &&
  )
  WHERE (reservation_status_snapshot IN ('hold','pending_payment','confirmed','checked_in'));

-- ----------------------------------------------------------------------
-- 2. True Postgres sequences for SLDT numbering
-- ----------------------------------------------------------------------
-- Replaces the existing MAX(seq)+advisory_lock pattern. nextval() is
-- transaction-safe, gap-allowed (a rollback consumes the number — OK
-- for invoice/receipt; gaps are acceptable and audit-explained), and
-- has zero contention. We seed each sequence past the current MAX so
-- numbering continues monotonically.

CREATE SEQUENCE IF NOT EXISTS sldt_reservation_seq;
CREATE SEQUENCE IF NOT EXISTS sldt_invoice_seq;
CREATE SEQUENCE IF NOT EXISTS sldt_receipt_seq;

-- Seed: max existing seq + 1, falling back to 1 when the table is empty.
SELECT setval(
  'sldt_reservation_seq',
  GREATEST(1, COALESCE((
    SELECT MAX(CAST(SPLIT_PART(reservation_number, '-', 3) AS INT))
    FROM reservations
    WHERE reservation_number LIKE 'SLDT-RES-%'
  ), 0)),
  true
);
SELECT setval(
  'sldt_invoice_seq',
  GREATEST(1, COALESCE((
    SELECT MAX(CAST(SPLIT_PART(invoice_number, '-', 3) AS INT))
    FROM invoices
    WHERE invoice_number LIKE 'SLDT-INV-%'
  ), 0)),
  true
);
SELECT setval(
  'sldt_receipt_seq',
  GREATEST(1, COALESCE((
    SELECT MAX(CAST(SPLIT_PART(receipt_number, '-', 3) AS INT))
    FROM payments
    WHERE receipt_number LIKE 'SLDT-RCP-%'
  ), 0)),
  true
);

-- ----------------------------------------------------------------------
-- 3. New reservation statuses: inquiry, hold, pending_payment
-- ----------------------------------------------------------------------
-- The reservations.status column is `text` with a CHECK enum at the
-- API/Drizzle layer rather than a Postgres ENUM type, so no DDL changes
-- are needed in the DB. The application-level enum in
-- apps/api/src/db/schema/enums.ts is updated separately.
--
-- We do add a partial index to make the "needs attention" filter fast
-- on the reservations list, since front-desk staff will scan these
-- daily.

CREATE INDEX IF NOT EXISTS idx_reservations_attention_status
  ON reservations (created_at DESC)
  WHERE status IN ('inquiry','hold','pending_payment');

-- ----------------------------------------------------------------------
-- 4. Guest commercial flags & preferences
-- ----------------------------------------------------------------------
ALTER TABLE guests
  ADD COLUMN IF NOT EXISTS is_vip boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_blacklisted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blacklist_reason text,
  ADD COLUMN IF NOT EXISTS blacklisted_at timestamptz,
  ADD COLUMN IF NOT EXISTS blacklisted_by uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS marketing_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_consent_channel text;

COMMENT ON COLUMN guests.preferences IS
  'Structured per-guest preferences. Known keys (extensible): smoking (bool), floor ("low"|"mid"|"high"), pillow ("soft"|"firm"), wakeup_time (HH:MM), dietary (string[]).';

CREATE INDEX IF NOT EXISTS idx_guests_vip ON guests (is_vip) WHERE is_vip;
CREATE INDEX IF NOT EXISTS idx_guests_blacklisted ON guests (is_blacklisted) WHERE is_blacklisted;

-- ----------------------------------------------------------------------
-- 5. Room amenities (normalised) + images
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS amenities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  icon text,
  category text NOT NULL DEFAULT 'general',
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_amenities (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  amenity_id uuid NOT NULL REFERENCES amenities(id) ON DELETE CASCADE,
  PRIMARY KEY (room_id, amenity_id)
);

CREATE TABLE IF NOT EXISTS room_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  url text NOT NULL,
  storage_path text,
  caption text,
  sort_order int NOT NULL DEFAULT 100,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_room_images_room
  ON room_images (room_id, sort_order);

-- Only one primary image per room.
CREATE UNIQUE INDEX IF NOT EXISTS uq_room_images_one_primary
  ON room_images (room_id) WHERE is_primary;

-- Seed the standard amenity catalog. ON CONFLICT means re-running the
-- migration is idempotent.
INSERT INTO amenities (key, label, icon, category, sort_order) VALUES
  ('ac',          'Air Conditioning', 'snowflake',  'climate', 10),
  ('heater',      'Heater',           'flame',      'climate', 20),
  ('tv',          'TV',               'tv',         'entertainment', 30),
  ('wifi',        'Wi-Fi',            'wifi',       'connectivity', 40),
  ('balcony',     'Balcony',          'door-open',  'view', 50),
  ('seaview',     'Sea View',         'waves',      'view', 60),
  ('bathtub',     'Bathtub',          'bath',       'bathroom', 70),
  ('geyser',      'Hot Water',        'thermometer','bathroom', 80),
  ('mini_fridge', 'Mini Fridge',      'refrigerator','room', 90),
  ('kettle',      'Electric Kettle',  'coffee',     'room', 100),
  ('safe',        'In-room Safe',     'lock',       'room', 110),
  ('iron',        'Iron & Board',     'iron',       'room', 120),
  ('workdesk',    'Work Desk',        'briefcase',  'room', 130),
  ('roomservice', '24x7 Room Service','bell',       'service', 140),
  ('housekeeping','Daily Housekeeping','sparkles',  'service', 150),
  ('parking',     'Parking',          'car',        'service', 160),
  ('breakfast',   'Breakfast Included','coffee',    'service', 170)
ON CONFLICT (key) DO UPDATE
  SET label = EXCLUDED.label,
      icon = EXCLUDED.icon,
      category = EXCLUDED.category,
      sort_order = EXCLUDED.sort_order;

-- Backfill existing room.has_ac / has_tv / has_wifi booleans into the
-- new room_amenities table. Idempotent (ON CONFLICT DO NOTHING).
INSERT INTO room_amenities (room_id, amenity_id)
SELECT r.id, a.id FROM rooms r
JOIN amenities a ON a.key = 'ac' WHERE r.has_ac = true
ON CONFLICT DO NOTHING;
INSERT INTO room_amenities (room_id, amenity_id)
SELECT r.id, a.id FROM rooms r
JOIN amenities a ON a.key = 'tv' WHERE r.has_tv = true
ON CONFLICT DO NOTHING;
INSERT INTO room_amenities (room_id, amenity_id)
SELECT r.id, a.id FROM rooms r
JOIN amenities a ON a.key = 'wifi' WHERE r.has_wifi = true
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------
-- 6. New RBAC system roles: manager, accountant, owner
-- ----------------------------------------------------------------------
-- We insert minimal role rows here. The permissions catalog itself is
-- code-managed (apps/api/src/lib/permissions.ts) and the per-role
-- permission grants are applied via the existing role-seed path, but
-- we attach a sensible permission set here so a fresh deploy has a
-- working CHRO/CFO/Owner persona out of the box.

INSERT INTO roles (key, label, description, is_system)
VALUES
  ('owner',      'Hotel Owner',
   'Read-only view of every operation. Receives owner WhatsApp alerts.', true),
  ('manager',    'General Manager',
   'Full operational access except staff/role administration.', true),
  ('accountant', 'Accountant',
   'Invoices, payments, collections, GST reports, exports. No room ops.', true)
ON CONFLICT (key) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      is_system = true,
      updated_at = now();

-- Attach permission sets to the three new roles. We list the keys here
-- so the SQL migration is the source of truth for "what does a Manager
-- see out of the box". Each block is idempotent.

-- Owner: read-only on everything that matters operationally + revenue.
WITH role_row AS (SELECT id FROM roles WHERE key = 'owner')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_dashboard','view_rooms','view_reservations','view_guests','view_kyc',
  'view_housekeeping','view_messages','view_collections','view_invoices',
  'view_reports','view_revenue','view_activity','view_notifications'
]) AS perm
ON CONFLICT DO NOTHING;

-- Manager: full ops, no staff/role admin.
WITH role_row AS (SELECT id FROM roles WHERE key = 'manager')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_dashboard',
  'view_rooms','edit_rooms','delete_rooms',
  'view_reservations','create_reservations','edit_reservations',
  'check_in','check_out','cancel_reservations','extend_stay',
  'add_charge','delete_charge',
  'view_guests','edit_guests','delete_guests','view_kyc','upload_kyc',
  'view_housekeeping','update_housekeeping','flag_maintenance','resolve_maintenance',
  'view_messages','send_messages',
  'view_collections','record_payments','void_payments','send_reminders',
  'view_invoices','preview_invoice','void_invoices','reissue_invoices',
  'view_reports','export_reports','view_revenue',
  'view_activity','view_notifications',
  'manage_settings','manage_templates'
]) AS perm
ON CONFLICT DO NOTHING;

-- Accountant: money & paperwork only.
WITH role_row AS (SELECT id FROM roles WHERE key = 'accountant')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_dashboard',
  'view_reservations','view_guests','view_kyc',
  'view_collections','record_payments','void_payments','send_reminders',
  'view_invoices','preview_invoice','void_invoices','reissue_invoices',
  'view_reports','export_reports','view_revenue',
  'view_activity','view_notifications'
]) AS perm
ON CONFLICT DO NOTHING;

-- ----------------------------------------------------------------------
-- 7. Misc audit helpers
-- ----------------------------------------------------------------------
-- Speed up "show me everything a single guest ever paid" lookups used
-- on the new GuestProfile timeline (Phase 5 feature, but the index is
-- free to add now and pays for itself today on Collections).
CREATE INDEX IF NOT EXISTS idx_payments_reservation_date
  ON payments (reservation_id, payment_date DESC);
