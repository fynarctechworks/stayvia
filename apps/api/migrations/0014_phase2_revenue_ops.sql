-- Phase 2 — Revenue & Operations migration.
--
-- Delivers:
--   1. companies              — corporate / agent accounts that pay bills
--   2. folios + folio_charges — split-bill model (one reservation can have
--                                multiple folios, each with its own payer
--                                and line items)
--   3. group_blocks + group_block_rooms — group bookings under a master
--                                          confirmation with a rooming list
--   4. night_audit_runs       — daily close-of-business batch record
--   5. perms + role grants    — manage_companies, manage_groups, run_night_audit
--
-- Every new table:
--   - has a property_id (NOT NULL, FK to properties)
--   - has RLS enabled (anon never reaches it)
--   - has a created_at + updated_at where the entity is editable
--
-- We do NOT touch existing reservation/invoice flows here — folios are
-- additive. A reservation that doesn't use folios continues to bill the
-- old way; the new endpoint exposes folio-aware billing as an opt-in.

-- ----------------------------------------------------------------------
-- 1. Companies (corporate accounts + travel agents)
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  code text NOT NULL,
  name text NOT NULL,
  legal_name text,
  gstin text,
  pan text,
  -- Contact + billing.
  address text,
  city text,
  state text,
  pincode text,
  contact_name text,
  contact_phone text,
  contact_email text,
  -- Credit policy. credit_limit = max outstanding allowed before new
  -- bookings on this company auto-flip to pending_payment. NULL = no
  -- limit (treat as cash-on-departure). payment_terms_days drives the
  -- aged-receivables buckets in the Companies dashboard.
  credit_limit numeric(12, 2),
  payment_terms_days int NOT NULL DEFAULT 0,
  -- Default rate-plan + discount overrides for bookings under this
  -- account. NULL = use the property default.
  default_rate_plan_id uuid REFERENCES rate_plans(id),
  default_discount_pct numeric(5, 2),
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_code_per_property UNIQUE (property_id, code),
  CONSTRAINT companies_credit_nonneg CHECK (credit_limit IS NULL OR credit_limit >= 0),
  CONSTRAINT companies_terms_nonneg CHECK (payment_terms_days >= 0 AND payment_terms_days <= 365),
  CONSTRAINT companies_discount_range
    CHECK (default_discount_pct IS NULL OR (default_discount_pct >= 0 AND default_discount_pct <= 100))
);
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_companies_property_name
  ON companies (property_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_companies_active
  ON companies (property_id, is_active) WHERE is_active;

-- Hook company onto reservations + invoices so we can attribute B2B
-- revenue. Snapshotted code text mirrors the rate_plan pattern.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id),
  ADD COLUMN IF NOT EXISTS company_code text;
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);

CREATE INDEX IF NOT EXISTS idx_reservations_company
  ON reservations (company_id) WHERE company_id IS NOT NULL;

-- ----------------------------------------------------------------------
-- 2. Folios (split-bill model)
-- ----------------------------------------------------------------------
-- A folio is a sub-bill within a reservation. The classic use case is
-- "company pays room, guest pays incidentals" — two folios on the same
-- reservation, each with its own payer and its own running balance.
--
-- payer_type tells us who's settling this folio:
--   'guest'   — the reservation's primary guest
--   'company' — a row in companies (B2B)
--   'agent'   — a future agent table; currently treated like company
--   'other'   — free-text payer (corp employee paying personally, etc.)
--
-- Charges from `additional_charges` and the invoice's room charges
-- attach to folios via folio_charges (a junction table — one charge can
-- legitimately split across folios with a partial amount).

CREATE TABLE IF NOT EXISTS folios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  folio_number int NOT NULL,   -- 1-based; the "main" folio is 1
  label text NOT NULL,
  payer_type text NOT NULL CHECK (payer_type IN ('guest','company','agent','other')),
  payer_guest_id uuid REFERENCES guests(id),
  payer_company_id uuid REFERENCES companies(id),
  payer_name text,             -- free-text fallback for 'other'
  is_primary boolean NOT NULL DEFAULT false,
  -- Running totals — computed by trigger from folio_charges + payments.
  charges_total numeric(12, 2) NOT NULL DEFAULT 0,
  paid_total numeric(12, 2) NOT NULL DEFAULT 0,
  balance_due numeric(12, 2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','voided')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folios_payer_consistent CHECK (
    (payer_type = 'guest'   AND payer_guest_id   IS NOT NULL)
 OR (payer_type = 'company' AND payer_company_id IS NOT NULL)
 OR (payer_type = 'agent'   AND payer_company_id IS NOT NULL)
 OR (payer_type = 'other'   AND payer_name       IS NOT NULL)
  ),
  CONSTRAINT folios_number_per_reservation UNIQUE (reservation_id, folio_number)
);
ALTER TABLE folios ENABLE ROW LEVEL SECURITY;

-- One primary per reservation. Partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_folios_one_primary_per_reservation
  ON folios (reservation_id) WHERE is_primary;

CREATE INDEX IF NOT EXISTS idx_folios_reservation
  ON folios (reservation_id, folio_number);
CREATE INDEX IF NOT EXISTS idx_folios_company
  ON folios (payer_company_id) WHERE payer_company_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS folio_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio_id uuid NOT NULL REFERENCES folios(id) ON DELETE CASCADE,
  -- Source: where the charge came from. 'room' for the per-night room
  -- charge, 'additional' for additional_charges rows, 'manual' for an
  -- ad-hoc adjustment, 'discount' for a credit-side line.
  source text NOT NULL CHECK (source IN ('room','additional','manual','discount')),
  source_id uuid,            -- e.g. additional_charges.id when source='additional'
  description text NOT NULL,
  quantity numeric(10, 2) NOT NULL DEFAULT 1,
  rate numeric(12, 2) NOT NULL,
  amount numeric(12, 2) NOT NULL,
  gst_rate numeric(5, 2) NOT NULL DEFAULT 0,
  gst_amount numeric(12, 2) NOT NULL DEFAULT 0,
  charge_date date NOT NULL DEFAULT CURRENT_DATE,
  voided boolean NOT NULL DEFAULT false,
  voided_reason text,
  voided_at timestamptz,
  voided_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id),
  CONSTRAINT folio_charges_amount_signed
    CHECK ((source = 'discount' AND amount <= 0) OR (source <> 'discount' AND amount >= 0))
);
ALTER TABLE folio_charges ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_folio_charges_folio
  ON folio_charges (folio_id, charge_date);

-- Folio balance is computed on every insert/update so the running
-- numbers stay accurate without the API recomputing on every read.
-- balance_due = SUM(non-voided charges + gst) - paid_total.
CREATE OR REPLACE FUNCTION folios_recalc_for(target_folio_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE folios SET
    charges_total = COALESCE((
      SELECT SUM(amount + gst_amount) FROM folio_charges
      WHERE folio_id = target_folio_id AND voided = false
    ), 0),
    balance_due = COALESCE((
      SELECT SUM(amount + gst_amount) FROM folio_charges
      WHERE folio_id = target_folio_id AND voided = false
    ), 0) - paid_total,
    updated_at = now()
  WHERE id = target_folio_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION folio_charges_after_change()
RETURNS trigger AS $$
BEGIN
  -- After insert/update/delete, recompute the affected folio's totals.
  IF TG_OP = 'DELETE' THEN
    PERFORM folios_recalc_for(OLD.folio_id);
  ELSE
    PERFORM folios_recalc_for(NEW.folio_id);
    IF TG_OP = 'UPDATE' AND OLD.folio_id <> NEW.folio_id THEN
      -- charge moved between folios; recompute the source folio too.
      PERFORM folios_recalc_for(OLD.folio_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_folio_charges_recalc ON folio_charges;
CREATE TRIGGER trg_folio_charges_recalc
  AFTER INSERT OR UPDATE OR DELETE ON folio_charges
  FOR EACH ROW EXECUTE FUNCTION folio_charges_after_change();

-- Linkage from payments → folio (optional). A payment without folio_id
-- still works the old way (per-invoice / per-reservation aggregate).
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS folio_id uuid REFERENCES folios(id);

CREATE INDEX IF NOT EXISTS idx_payments_folio
  ON payments (folio_id) WHERE folio_id IS NOT NULL;

-- When a payment lands on a folio (or is voided), recompute the paid_total.
CREATE OR REPLACE FUNCTION folios_recalc_paid(target_folio_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE folios SET
    paid_total = COALESCE((
      SELECT SUM(amount) FROM payments
      WHERE folio_id = target_folio_id
        AND voided = false
        AND status = 'received'
    ), 0),
    balance_due = charges_total - COALESCE((
      SELECT SUM(amount) FROM payments
      WHERE folio_id = target_folio_id
        AND voided = false
        AND status = 'received'
    ), 0),
    updated_at = now()
  WHERE id = target_folio_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION payments_folio_after_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.folio_id IS NOT NULL THEN PERFORM folios_recalc_paid(OLD.folio_id); END IF;
  ELSE
    IF NEW.folio_id IS NOT NULL THEN PERFORM folios_recalc_paid(NEW.folio_id); END IF;
    IF TG_OP = 'UPDATE' AND OLD.folio_id IS NOT NULL AND OLD.folio_id <> COALESCE(NEW.folio_id, '00000000-0000-0000-0000-000000000000'::uuid) THEN
      PERFORM folios_recalc_paid(OLD.folio_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_folio_recalc ON payments;
CREATE TRIGGER trg_payments_folio_recalc
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_folio_after_change();

-- ----------------------------------------------------------------------
-- 3. Group bookings + rooming list
-- ----------------------------------------------------------------------
-- A group_block is a "master confirmation" that holds N rooms over a
-- common date range for a single group — wedding, corporate offsite,
-- conference. The rooming list (group_block_rooms) is the per-room
-- assignment with optional pre-filled guest details that get promoted
-- to real reservations on creation.

CREATE TABLE IF NOT EXISTS group_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  group_code text NOT NULL,         -- staff-chosen identifier (e.g. SHARMA-WEDDING-2026)
  group_name text NOT NULL,
  contact_name text,
  contact_phone text,
  contact_email text,
  company_id uuid REFERENCES companies(id),
  rate_plan_id uuid REFERENCES rate_plans(id),
  block_start_date date NOT NULL,
  block_end_date date NOT NULL,
  -- The owner can publish a cut-off date; rooms not picked up by then
  -- automatically release. The job that does this is added later — for
  -- now staff release manually.
  cutoff_date date,
  rooms_blocked int NOT NULL DEFAULT 0,
  rooms_picked_up int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'tentative'
    CHECK (status IN ('tentative','confirmed','partial','closed','cancelled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id),
  CONSTRAINT group_blocks_dates CHECK (block_end_date > block_start_date),
  CONSTRAINT group_blocks_code_per_property UNIQUE (property_id, group_code)
);
ALTER TABLE group_blocks ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_group_blocks_active
  ON group_blocks (property_id, status, block_start_date);

CREATE TABLE IF NOT EXISTS group_block_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_block_id uuid NOT NULL REFERENCES group_blocks(id) ON DELETE CASCADE,
  -- Either a room_type slug (we'll assign a specific room later) OR a
  -- specific room_id (the rooming-list editor lets the operator pin a
  -- room to a guest). One of these MUST be present.
  room_type text,
  room_id uuid REFERENCES rooms(id),
  -- Optional pre-filled guest data; on "create reservation" we look up
  -- an existing guest by phone, else create a new one with these fields.
  guest_name text,
  guest_phone text,
  guest_email text,
  guest_kyc_pending boolean NOT NULL DEFAULT true,
  -- Per-room overrides on top of the block's rate plan.
  rate_per_night numeric(10, 2),
  num_adults int NOT NULL DEFAULT 1,
  num_children int NOT NULL DEFAULT 0,
  -- The actual reservation row, once the room is picked up.
  reservation_id uuid REFERENCES reservations(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','no_show','released','cancelled')),
  notes text,
  CONSTRAINT group_block_rooms_target_set
    CHECK (room_type IS NOT NULL OR room_id IS NOT NULL)
);
ALTER TABLE group_block_rooms ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_group_block_rooms_block
  ON group_block_rooms (group_block_id);
CREATE INDEX IF NOT EXISTS idx_group_block_rooms_reservation
  ON group_block_rooms (reservation_id) WHERE reservation_id IS NOT NULL;

-- Maintain rooms_blocked + rooms_picked_up on the parent block.
CREATE OR REPLACE FUNCTION group_blocks_recalc(target_block_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE group_blocks SET
    rooms_blocked = COALESCE((SELECT COUNT(*) FROM group_block_rooms WHERE group_block_id = target_block_id), 0),
    rooms_picked_up = COALESCE((SELECT COUNT(*) FROM group_block_rooms WHERE group_block_id = target_block_id AND reservation_id IS NOT NULL), 0)
  WHERE id = target_block_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION group_block_rooms_after_change()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM group_blocks_recalc(OLD.group_block_id);
  ELSE
    PERFORM group_blocks_recalc(NEW.group_block_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_group_block_rooms_recalc ON group_block_rooms;
CREATE TRIGGER trg_group_block_rooms_recalc
  AFTER INSERT OR UPDATE OR DELETE ON group_block_rooms
  FOR EACH ROW EXECUTE FUNCTION group_block_rooms_after_change();

-- Tag the parent block on every reservation that came from a rooming list.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS group_block_id uuid REFERENCES group_blocks(id);

CREATE INDEX IF NOT EXISTS idx_reservations_group_block
  ON reservations (group_block_id) WHERE group_block_id IS NOT NULL;

-- ----------------------------------------------------------------------
-- 4. Night audit
-- ----------------------------------------------------------------------
-- One row per business-date "close". The audit job aggregates the day's
-- numbers (revenue, ADR, occupancy, by-room-type) into a frozen snapshot
-- so reports a year later still match what was on the manager's morning
-- report. Re-running for the same date overwrites the row but logs a
-- new event in the audit log.

CREATE TABLE IF NOT EXISTS night_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  business_date date NOT NULL,
  -- Stay metrics for the business date.
  rooms_sold int NOT NULL DEFAULT 0,
  rooms_available int NOT NULL DEFAULT 0,
  occupancy_pct numeric(5, 2) NOT NULL DEFAULT 0,
  -- Money metrics. All from non-complimentary reservations only.
  room_revenue numeric(12, 2) NOT NULL DEFAULT 0,
  additional_revenue numeric(12, 2) NOT NULL DEFAULT 0,
  total_revenue numeric(12, 2) NOT NULL DEFAULT 0,
  gst_collected numeric(12, 2) NOT NULL DEFAULT 0,
  adr numeric(12, 2) NOT NULL DEFAULT 0,
  revpar numeric(12, 2) NOT NULL DEFAULT 0,
  -- Operational counts the morning report needs.
  arrivals int NOT NULL DEFAULT 0,
  departures int NOT NULL DEFAULT 0,
  no_shows int NOT NULL DEFAULT 0,
  cancellations int NOT NULL DEFAULT 0,
  walk_ins int NOT NULL DEFAULT 0,
  -- Full snapshot for forensics. Keys not promoted to top-level columns
  -- live here.
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('running','completed','failed')),
  ran_by uuid REFERENCES profiles(id),
  ran_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT night_audit_runs_unique_per_day UNIQUE (property_id, business_date)
);
ALTER TABLE night_audit_runs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_night_audit_runs_date
  ON night_audit_runs (property_id, business_date DESC);

-- ----------------------------------------------------------------------
-- 5. Permissions + role grants
-- ----------------------------------------------------------------------
INSERT INTO permissions (key, area, label, description) VALUES
  ('view_companies',   'Companies', 'View companies',
   'See the corporate accounts list and individual company detail.'),
  ('manage_companies', 'Companies', 'Manage companies',
   'Create / edit / archive corporate accounts and their credit policies.'),
  ('view_groups',      'Groups',    'View group bookings',
   'See the list of group blocks and rooming lists.'),
  ('manage_groups',    'Groups',    'Manage group bookings',
   'Create / edit / cancel group blocks; build and modify rooming lists.'),
  ('split_folios',     'Billing',   'Split folios on a reservation',
   'Create extra folios, move charges between folios, settle per payer.'),
  ('run_night_audit',  'Operations','Run night audit',
   'Trigger the end-of-business-day close. Usually admin / manager.'),
  ('view_night_audit', 'Operations','View night audit runs',
   'See past night-audit snapshots and the running history.')
ON CONFLICT (key) DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'frontdesk')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY['view_companies','view_groups','split_folios']) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'manager')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_companies','manage_companies',
  'view_groups','manage_groups',
  'split_folios','run_night_audit','view_night_audit'
]) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'owner')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY['view_companies','view_groups','view_night_audit']) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'accountant')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_companies','manage_companies',
  'view_groups',
  'split_folios','view_night_audit'
]) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;
