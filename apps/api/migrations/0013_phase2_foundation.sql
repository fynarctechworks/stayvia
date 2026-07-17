-- Phase 2 foundation migration.
--
-- Delivers four operational pillars: properties, rate management,
-- housekeeping task workflow, and maintenance tickets. Every change
-- here is additive and idempotent. The existing single-tenant
-- behaviour is preserved by:
--   - bootstrapping ONE row in `properties` from the current settings
--     table and back-filling property_id on every operational row to
--     that bootstrap id
--   - making rate plans optional everywhere (reservations keep
--     working without one; if none is attached, the current per-room
--     `rate_per_night` snapshot continues to be the price)
--   - leaving maintenance + housekeeping as opt-in features (no
--     existing flow blocks on them)
--
-- New tables (all with RLS enabled — anon key never touches these):
--   properties
--   rate_plans
--   rate_calendar
--   seasons
--   housekeeping_tasks
--   housekeeping_task_steps
--   maintenance_tickets
--   maintenance_ticket_photos
--   maintenance_ticket_events

-- ----------------------------------------------------------------------
-- 1. Properties (multi-property scaffolding)
-- ----------------------------------------------------------------------
-- We design for multi-property from day one even though SLDT Stay Inn
-- is a single property. Adding tenant_id-equivalent (property_id)
-- now costs almost nothing; adding it after the schema grows to dozens
-- of tables and millions of rows would be an emergency.
--
-- The bootstrap row mirrors the current settings table. If/when a
-- second property is added, the settings table becomes per-property
-- (settings.property_id added in a future migration); for now there's
-- a tacit 1:1 between settings and properties[0].

CREATE TABLE IF NOT EXISTS properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  legal_name text,
  gstin text,
  address text,
  city text,
  state text,
  country text NOT NULL DEFAULT 'India',
  pincode text,
  phone text,
  email text,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  currency text NOT NULL DEFAULT 'INR',
  default_check_in_time text NOT NULL DEFAULT '12:00',
  default_check_out_time text NOT NULL DEFAULT '11:00',
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT properties_lat_range CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90)),
  CONSTRAINT properties_lng_range CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180))
);
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

-- Bootstrap one row from the current settings. The code 'PRIMARY' is
-- intentionally generic so the upgrade path to multi-property doesn't
-- require renaming. The hotel can change name + address from Settings.
INSERT INTO properties (
  id, code, name, address, phone, email, gstin,
  latitude, longitude, default_check_in_time, default_check_out_time
)
SELECT
  gen_random_uuid(),
  'PRIMARY',
  COALESCE(hotel_name, 'SLDT Stay Inn'),
  hotel_address,
  hotel_phone,
  hotel_email,
  hotel_gstin,
  hotel_latitude,
  hotel_longitude,
  COALESCE(check_in_time, '12:00'),
  COALESCE(check_out_time, '11:00')
FROM settings
WHERE NOT EXISTS (SELECT 1 FROM properties)
LIMIT 1;

-- Attach property_id to every operational table. Nullable for now so
-- the back-fill can run without breaking anything; we tighten with
-- NOT NULL after the back-fill below.
ALTER TABLE rooms        ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id);
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id);
ALTER TABLE invoices     ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id);
ALTER TABLE payments     ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id);
ALTER TABLE guests       ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES properties(id);

DO $$
DECLARE
  primary_id uuid;
BEGIN
  SELECT id INTO primary_id FROM properties WHERE code = 'PRIMARY';
  IF primary_id IS NULL THEN
    RAISE EXCEPTION 'Phase 2 bootstrap failed: no PRIMARY property row';
  END IF;
  UPDATE rooms        SET property_id = primary_id WHERE property_id IS NULL;
  UPDATE reservations SET property_id = primary_id WHERE property_id IS NULL;
  UPDATE invoices     SET property_id = primary_id WHERE property_id IS NULL;
  UPDATE payments     SET property_id = primary_id WHERE property_id IS NULL;
  UPDATE guests       SET property_id = primary_id WHERE property_id IS NULL;
END$$;

-- NOT NULL once everything's back-filled. New rows created by the API
-- MUST set property_id (the API will default to the bootstrap id until
-- multi-property is exposed in the UI).
ALTER TABLE rooms        ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE reservations ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE invoices     ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE payments     ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE guests       ALTER COLUMN property_id SET NOT NULL;

-- Indexes for the property scope. Every operational query has an
-- implicit WHERE property_id = $current so these become hot paths
-- the moment a second property is added.
CREATE INDEX IF NOT EXISTS idx_rooms_property        ON rooms(property_id);
CREATE INDEX IF NOT EXISTS idx_reservations_property ON reservations(property_id, check_in_date);
CREATE INDEX IF NOT EXISTS idx_invoices_property     ON invoices(property_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_property     ON payments(property_id, payment_date);

-- Safety net: auto-fill property_id on payments + invoices from the
-- parent reservation when the inserting code forgets to set it. The
-- API sets it explicitly in most paths, but several payment-insert
-- call sites exist (advance at booking, advance at check-in, final at
-- checkout, standalone, collect-previous-balance) and a trigger means
-- none of them can ever produce a NULL/wrong scope. Correct-by-
-- construction beats remembering to thread a variable through five
-- code paths.
CREATE OR REPLACE FUNCTION fill_property_id_from_reservation()
RETURNS trigger AS $$
BEGIN
  IF NEW.property_id IS NULL AND NEW.reservation_id IS NOT NULL THEN
    SELECT property_id INTO NEW.property_id
    FROM reservations WHERE id = NEW.reservation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payments_fill_property ON payments;
CREATE TRIGGER trg_payments_fill_property
  BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION fill_property_id_from_reservation();

DROP TRIGGER IF EXISTS trg_invoices_fill_property ON invoices;
CREATE TRIGGER trg_invoices_fill_property
  BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION fill_property_id_from_reservation();

-- ----------------------------------------------------------------------
-- 2. Rate plans + rate calendar + seasons
-- ----------------------------------------------------------------------
-- Rate plans are named pricing strategies (BAR, WEEKEND, CORP, OTA).
-- Each rate plan has a base modifier (multiplier on top of the room's
-- base rate, e.g. 1.20 for WEEKEND, 0.85 for CORP) and optional MLOS
-- (min length of stay) / MaxLOS / CTA (closed to arrival) / CTD
-- (closed to departure) restrictions.
--
-- rate_calendar holds per-day overrides for a (rate_plan, room_type,
-- date) combination. If no row exists for a given (date, room_type),
-- the rate_plan's base_modifier is applied to the room's base_rate.
-- This keeps the calendar small — only days that deviate from default
-- need a row.

CREATE TABLE IF NOT EXISTS rate_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  -- Multiplier vs base. 1.00 = same as base_rate, 1.20 = +20%, 0.85 = -15%.
  base_modifier numeric(5, 3) NOT NULL DEFAULT 1.000,
  -- Booking-window restrictions. NULL = unrestricted.
  min_length_of_stay int,
  max_length_of_stay int,
  closed_to_arrival boolean NOT NULL DEFAULT false,
  closed_to_departure boolean NOT NULL DEFAULT false,
  -- Visibility / availability scope.
  is_public boolean NOT NULL DEFAULT true,    -- exposed to direct/online booking
  is_active boolean NOT NULL DEFAULT true,
  -- Editorial flag for the "house rate" which is what the create-
  -- reservation flow defaults to when no rate plan is chosen. Only
  -- one default per property; enforced by partial unique index below.
  is_default boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_plans_code_per_property UNIQUE (property_id, code),
  CONSTRAINT rate_plans_modifier_range CHECK (base_modifier > 0 AND base_modifier <= 10),
  CONSTRAINT rate_plans_los_range
    CHECK (min_length_of_stay IS NULL OR min_length_of_stay >= 1),
  CONSTRAINT rate_plans_max_los_range
    CHECK (max_length_of_stay IS NULL OR max_length_of_stay >= COALESCE(min_length_of_stay, 1))
);
ALTER TABLE rate_plans ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS uq_rate_plans_one_default_per_property
  ON rate_plans (property_id) WHERE is_default;

-- Seed three rate plans on the bootstrap property:
--   BAR     — Best Available Rate (default, 1.00 modifier)
--   WEEKEND — +20% modifier
--   CORP    — -15% modifier (B2B corporate accounts)
-- These exist so the rate-plan dropdown is never empty on a fresh
-- deploy. They can be edited or deleted from Settings → Rate Plans.
INSERT INTO rate_plans (property_id, code, name, description, base_modifier, is_default, sort_order)
SELECT p.id, 'BAR', 'Best Available Rate',
  'Default house rate. Applied when no rate plan is chosen.',
  1.000, true, 10
FROM properties p WHERE p.code = 'PRIMARY'
ON CONFLICT (property_id, code) DO NOTHING;

INSERT INTO rate_plans (property_id, code, name, description, base_modifier, is_default, sort_order)
SELECT p.id, 'WEEKEND', 'Weekend Rate',
  'Friday-Saturday-Sunday surcharge.',
  1.200, false, 20
FROM properties p WHERE p.code = 'PRIMARY'
ON CONFLICT (property_id, code) DO NOTHING;

INSERT INTO rate_plans (property_id, code, name, description, base_modifier, is_default, sort_order)
SELECT p.id, 'CORP', 'Corporate Rate',
  'Negotiated rate for B2B accounts. Attach to a corporate company at booking.',
  0.850, false, 30
FROM properties p WHERE p.code = 'PRIMARY'
ON CONFLICT (property_id, code) DO NOTHING;

-- Per-day, per-rate-plan, per-room-type pricing override. NULL row =
-- use the rate plan's base_modifier on top of room.base_rate.
CREATE TABLE IF NOT EXISTS rate_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_plan_id uuid NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  room_type text NOT NULL,
  date date NOT NULL,
  -- Explicit price for the (plan, type, date). Wins over base * modifier.
  rate_override numeric(10, 2),
  -- Per-day inventory cap. NULL = "no cap" (sell as many rooms of this
  -- type as we have). Useful for restricting OTA exposure on hot days.
  rooms_available int,
  -- Per-day restrictions overlaying the rate plan's defaults. NULL =
  -- inherit from the rate plan.
  min_length_of_stay int,
  max_length_of_stay int,
  closed_to_arrival boolean,
  closed_to_departure boolean,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_calendar_unique_per_day UNIQUE (rate_plan_id, room_type, date),
  CONSTRAINT rate_calendar_rate_positive CHECK (rate_override IS NULL OR rate_override >= 0),
  CONSTRAINT rate_calendar_rooms_nonneg  CHECK (rooms_available IS NULL OR rooms_available >= 0)
);
ALTER TABLE rate_calendar ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_rate_calendar_lookup
  ON rate_calendar (room_type, date, rate_plan_id);

-- Seasonal definitions — pure UX sugar for bulk-editing the calendar.
-- A season is "peak", "shoulder", "low", "festival X" with start/end
-- dates and an associated multiplier the rate-plan editor can apply
-- in one click. The rate_calendar rows are still the source of truth.
CREATE TABLE IF NOT EXISTS seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  modifier numeric(5, 3) NOT NULL DEFAULT 1.000,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seasons_date_order CHECK (end_date >= start_date),
  CONSTRAINT seasons_modifier_range CHECK (modifier > 0 AND modifier <= 10)
);
ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_seasons_property_dates
  ON seasons (property_id, start_date, end_date);

-- Hook rate plan onto reservations so audit can trace which plan
-- priced the booking. Snapshotted at create time (rate_plan_code
-- text is kept for legibility even if the plan is later deleted).
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS rate_plan_id uuid REFERENCES rate_plans(id),
  ADD COLUMN IF NOT EXISTS rate_plan_code text;

-- ----------------------------------------------------------------------
-- 3. Housekeeping tasks (structured replacement for status-only flow)
-- ----------------------------------------------------------------------
-- Current state: the only housekeeping signal is `rooms.status`
-- (dirty/clean/inspected/maintenance). Phase 2 introduces a proper
-- task model so:
--   - the front desk can SEE who's cleaning which room
--   - completion isn't a single click but a per-step checklist
--   - history is queryable (avg clean time per staffer, etc.)
--
-- Auto-creation rules (enforced in the application layer):
--   - On check-out, a `checkout_clean` task is auto-created for the
--     vacated room.
--   - On a guest's stay-in-progress, a daily `daily_refresh` task is
--     auto-created at 8am IST by a future scheduled job.
--   - Front-desk can manually create `deep_clean` or `inspection`
--     tasks any time.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'housekeeping_task_type'
  ) THEN
    CREATE TYPE housekeeping_task_type AS ENUM (
      'checkout_clean','daily_refresh','deep_clean','inspection','maintenance_followup','custom'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'housekeeping_task_status'
  ) THEN
    CREATE TYPE housekeeping_task_status AS ENUM (
      'pending','in_progress','blocked','done','skipped'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS housekeeping_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  -- Optional link to the reservation that triggered the task (e.g.
  -- the checkout that created this checkout_clean). NULL for ad-hoc
  -- deep cleans, inspections, etc.
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  task_type housekeeping_task_type NOT NULL DEFAULT 'checkout_clean',
  status housekeeping_task_status NOT NULL DEFAULT 'pending',
  priority int NOT NULL DEFAULT 50,    -- 0 = lowest, 100 = critical
  assigned_to uuid REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_at timestamptz,
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  CONSTRAINT housekeeping_tasks_priority_range CHECK (priority BETWEEN 0 AND 100)
);
ALTER TABLE housekeeping_tasks ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_open
  ON housekeeping_tasks (property_id, status, due_at)
  WHERE status IN ('pending','in_progress','blocked');

CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_room
  ON housekeeping_tasks (room_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_assignee
  ON housekeeping_tasks (assigned_to, status)
  WHERE assigned_to IS NOT NULL;

-- Per-task checklist. Each task has a flat list of steps the cleaner
-- ticks off. We default a small set on auto-creation (see API code).
CREATE TABLE IF NOT EXISTS housekeeping_task_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES housekeeping_tasks(id) ON DELETE CASCADE,
  label text NOT NULL,
  is_done boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 100,
  done_at timestamptz,
  done_by uuid REFERENCES profiles(id) ON DELETE SET NULL
);
ALTER TABLE housekeeping_task_steps ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_housekeeping_task_steps_task
  ON housekeeping_task_steps (task_id, sort_order);

-- ----------------------------------------------------------------------
-- 4. Maintenance tickets
-- ----------------------------------------------------------------------
-- Long-running issues: AC broken, leak in bathroom, broken bedside
-- lamp. Distinct from housekeeping tasks (which are recurring stay
-- hygiene) — these are individual incidents with a category, a
-- responsible person, and a resolution.
--
-- A ticket can be linked to a room (almost always) and optionally to a
-- reservation (for guest-reported issues). Photos attach via the
-- maintenance_ticket_photos child table. Every status change writes
-- an event row so the audit trail is complete.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_category') THEN
    CREATE TYPE maintenance_category AS ENUM (
      'plumbing','electrical','ac_heating','furniture','appliances',
      'tv_internet','locks_safety','painting_walls','flooring','other'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_priority') THEN
    CREATE TYPE maintenance_priority AS ENUM ('low','medium','high','urgent');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maintenance_status') THEN
    CREATE TYPE maintenance_status AS ENUM (
      'open','triaged','in_progress','blocked','resolved','closed','wont_fix'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS maintenance_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number text NOT NULL UNIQUE,
  property_id uuid NOT NULL REFERENCES properties(id),
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  category maintenance_category NOT NULL DEFAULT 'other',
  priority maintenance_priority NOT NULL DEFAULT 'medium',
  status maintenance_status NOT NULL DEFAULT 'open',
  title text NOT NULL,
  description text,
  reported_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_at timestamptz,
  due_at timestamptz,
  blocks_room boolean NOT NULL DEFAULT false,   -- if true, room flips to maintenance until resolved
  estimated_cost numeric(10, 2),
  actual_cost numeric(10, 2),
  resolution_notes text,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE maintenance_tickets ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_maintenance_tickets_open
  ON maintenance_tickets (property_id, priority DESC, created_at DESC)
  WHERE status NOT IN ('resolved','closed','wont_fix');

CREATE INDEX IF NOT EXISTS idx_maintenance_tickets_room
  ON maintenance_tickets (room_id, status);

CREATE INDEX IF NOT EXISTS idx_maintenance_tickets_assignee
  ON maintenance_tickets (assigned_to, status)
  WHERE assigned_to IS NOT NULL;

-- Sequence for human-readable ticket numbers (SLDT-MNT-NNNN). Same
-- pattern as the SLDT-RES/INV/RCP sequences from Phase 1.
CREATE SEQUENCE IF NOT EXISTS sldt_maintenance_seq;

CREATE TABLE IF NOT EXISTS maintenance_ticket_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES maintenance_tickets(id) ON DELETE CASCADE,
  url text NOT NULL,
  storage_path text,
  caption text,
  uploaded_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE maintenance_ticket_photos ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_maintenance_ticket_photos_ticket
  ON maintenance_ticket_photos (ticket_id, uploaded_at);

-- Activity feed per ticket. We deliberately keep this here rather
-- than reusing the global activity_log because ticket-specific
-- semantics (status_changed, assigned, photo_added, cost_set) need
-- structured payloads for the timeline UI.
CREATE TABLE IF NOT EXISTS maintenance_ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES maintenance_tickets(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  description text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE maintenance_ticket_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_maintenance_ticket_events_ticket
  ON maintenance_ticket_events (ticket_id, created_at DESC);

-- ----------------------------------------------------------------------
-- 5. Phase 2 permission keys
-- ----------------------------------------------------------------------
-- Adds the new permission keys to the catalog so role grants below
-- don't FK-fail (same lesson Phase 1 learned).
INSERT INTO permissions (key, area, label, description) VALUES
  ('view_rate_plans',   'Rates',         'View rate plans & calendar',
   'See pricing strategies and the rate calendar.'),
  ('manage_rate_plans', 'Rates',         'Manage rate plans & calendar',
   'Create/edit rate plans, edit per-day prices and restrictions, define seasons.'),
  ('view_housekeeping_tasks',   'Housekeeping', 'View housekeeping tasks',
   'See the structured task list (separate from the simple room status).'),
  ('assign_housekeeping_tasks', 'Housekeeping', 'Assign housekeeping tasks',
   'Reassign tasks to a different staff member.'),
  ('complete_housekeeping_tasks','Housekeeping','Complete housekeeping tasks',
   'Tick off task steps and mark tasks done. Housekeepers get this.'),
  ('view_maintenance',   'Maintenance',  'View maintenance tickets',
   'See the maintenance inbox and ticket detail.'),
  ('create_maintenance', 'Maintenance',  'Create maintenance tickets',
   'File a new maintenance ticket. Front desk + housekeeping get this.'),
  ('edit_maintenance',   'Maintenance',  'Edit maintenance tickets',
   'Change category, priority, assignee, due-date, costs, resolution.'),
  ('close_maintenance',  'Maintenance',  'Close maintenance tickets',
   'Move a ticket to closed or wont_fix. Manager / admin only.')
ON CONFLICT (key) DO NOTHING;

-- Extend the existing role grants. Each block is idempotent.
WITH role_row AS (SELECT id FROM roles WHERE key = 'frontdesk')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_rate_plans',
  'view_housekeeping_tasks',
  'view_maintenance','create_maintenance'
]) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'housekeeping')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_housekeeping_tasks','complete_housekeeping_tasks',
  'view_maintenance','create_maintenance'
]) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'manager')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_rate_plans','manage_rate_plans',
  'view_housekeeping_tasks','assign_housekeeping_tasks','complete_housekeeping_tasks',
  'view_maintenance','create_maintenance','edit_maintenance','close_maintenance'
]) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'owner')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_rate_plans','view_housekeeping_tasks','view_maintenance'
]) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'accountant')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_rate_plans','view_maintenance'
]) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;

-- Note: schema_migrations bookkeeping is owned by the wrapper script
-- (apps/api/scripts/migrate.mjs). 0011 and 0012 needed to self-record
-- because they were applied via the Supabase MCP, which bypasses the
-- script. From 0013 onward we rely on migrate.mjs again.
