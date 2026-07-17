-- Phase 3 + 4 — Compliance, Public Booking, Dynamic Pricing, GST Returns.
--
-- Delivers:
--   1. pricing_rules                — declarative dynamic-pricing engine
--   2. booking_engine_settings       — single-row per property toggles for
--                                       the public booking widget
--   3. pending_bookings              — inbound bookings from the public
--                                       widget (not yet a real reservation —
--                                       awaiting payment or KYC)
--   4. dpdp_exports + dpdp_deletions — Indian DPDP Act 2023 data-subject
--                                       request log
--   5. marketing_consent_log         — append-only consent history
--                                       (changes to guests.marketing_consent
--                                       fields are mirrored here for audit)
--   6. gst_returns_runs              — frozen GSTR-1 / GSTR-3B export runs
--
-- Every table:
--   - has a property_id (NOT NULL, FK to properties)
--   - has RLS enabled
--   - has created_at, updated_at where editable

-- ----------------------------------------------------------------------
-- 1. Pricing rules (dynamic-pricing engine)
-- ----------------------------------------------------------------------
-- Declarative rules that apply on top of a rate plan + base rate. The
-- engine runs at reservation create time AFTER the rate-plan lookup,
-- so pricing layers: base_rate → plan.modifier → rate_calendar override
-- → THEN matching pricing_rules (multiply or add).
--
-- Each rule has a `kind` that determines what triggers it and a JSONB
-- `condition` that holds the kind-specific params. Common kinds:
--
--   occupancy_threshold — fires when forecast occupancy on the stay
--                          date is >= condition.min_pct. Used for
--                          "if we're 80% full, charge 15% more".
--   length_of_stay      — fires when nights between min/max. Used for
--                          "stay 7+ nights, 10% off".
--   advance_purchase    — fires when booking made N+ days ahead. Used
--                          for "book 30+ days out, 12% off".
--   day_of_week         — fires on specific weekdays. Used for
--                          "weekend +20%".
--   season              — fires on a date range. Pointer to seasons.id.
--
-- adjustment: { type: 'multiplier'|'flat', value: number }
--   multiplier: 1.20 = +20%, 0.85 = -15%
--   flat:       +/- INR per night
--
-- Rules apply in `priority` order (lower = applied first). Stop-on-match
-- is opt-in via condition.stop_after.

CREATE TABLE IF NOT EXISTS pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  kind text NOT NULL CHECK (kind IN (
    'occupancy_threshold','length_of_stay','advance_purchase',
    'day_of_week','season','manual'
  )),
  condition jsonb NOT NULL DEFAULT '{}'::jsonb,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('multiplier','flat')),
  adjustment_value numeric(10, 4) NOT NULL,
  priority int NOT NULL DEFAULT 100,
  stop_after boolean NOT NULL DEFAULT false,
  -- Scope: optional restriction by rate plan or room type. Null = apply
  -- to everything.
  applies_to_rate_plan_id uuid REFERENCES rate_plans(id),
  applies_to_room_type text,
  is_active boolean NOT NULL DEFAULT true,
  starts_at date,
  ends_at date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_rules_code_per_property UNIQUE (property_id, code),
  CONSTRAINT pricing_rules_adjustment_sane CHECK (
    (adjustment_type = 'multiplier' AND adjustment_value > 0 AND adjustment_value <= 10)
 OR (adjustment_type = 'flat')
  )
);
ALTER TABLE pricing_rules ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_pricing_rules_active
  ON pricing_rules (property_id, priority) WHERE is_active;

-- ----------------------------------------------------------------------
-- 2. Booking engine settings (one row per property)
-- ----------------------------------------------------------------------
-- Toggles that drive the public booking widget. The widget itself is
-- served from /book/:propertyCode (no auth) by the web app and reads
-- this row to know what to show and which rate plan to price against.

CREATE TABLE IF NOT EXISTS booking_engine_settings (
  property_id uuid PRIMARY KEY REFERENCES properties(id),
  is_enabled boolean NOT NULL DEFAULT false,
  -- The rate plan used by the public widget. Defaults to BAR.
  public_rate_plan_id uuid REFERENCES rate_plans(id),
  -- Cancellation policy text (markdown allowed) shown at booking time.
  cancellation_policy text,
  -- Minimum advance notice in hours (block "book for tonight at 11pm").
  min_advance_hours int NOT NULL DEFAULT 0,
  -- Maximum nights bookable in one shot.
  max_nights_per_booking int NOT NULL DEFAULT 14,
  -- Whether KYC + photo are required up-front. If false, the booking
  -- creates a `pending_kyc` reservation and the desk collects KYC at
  -- check-in.
  require_kyc_at_booking boolean NOT NULL DEFAULT false,
  -- Optional banner image + tagline shown on the public page.
  banner_image_url text,
  tagline text,
  -- Channel: when public bookings come in, set bookingSource to this.
  channel_label text NOT NULL DEFAULT 'phone_whatsapp',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE booking_engine_settings ENABLE ROW LEVEL SECURITY;

-- Bootstrap a row for the PRIMARY property so the API has somewhere to
-- read defaults from. Disabled by default — the owner toggles it on.
INSERT INTO booking_engine_settings (property_id, is_enabled, public_rate_plan_id)
SELECT
  p.id,
  false,
  (SELECT id FROM rate_plans WHERE property_id = p.id AND is_default LIMIT 1)
FROM properties p
WHERE p.code = 'PRIMARY'
ON CONFLICT (property_id) DO NOTHING;

-- ----------------------------------------------------------------------
-- 3. Pending bookings (inbox from the public widget)
-- ----------------------------------------------------------------------
-- Inbound bookings from the public widget land here first, NOT in
-- `reservations`. The front desk reviews + confirms (which creates a
-- real reservation), or rejects. This isolates anonymous/unverified
-- inbound traffic from the operational booking flow.

CREATE TABLE IF NOT EXISTS pending_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  -- Public reference shown to the booker.
  public_ref text NOT NULL UNIQUE,
  check_in_date date NOT NULL,
  check_out_date date NOT NULL,
  num_adults int NOT NULL DEFAULT 1,
  num_children int NOT NULL DEFAULT 0,
  room_type text NOT NULL,
  rate_plan_id uuid REFERENCES rate_plans(id),
  guest_name text NOT NULL,
  guest_phone text NOT NULL,
  guest_email text,
  -- Quote at submission time. Stored so a later rate change doesn't
  -- alter the deal the guest saw.
  quoted_rate numeric(10, 2) NOT NULL,
  quoted_total numeric(12, 2) NOT NULL,
  -- Payment: when Razorpay is wired, this carries the order_id +
  -- payment_id. NULL until the gateway returns.
  payment_provider text,
  payment_order_id text,
  payment_payment_id text,
  payment_status text NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','pending','paid','refunded','failed')),
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','accepted','rejected','expired')),
  reservation_id uuid REFERENCES reservations(id),
  rejected_reason text,
  submitted_ip text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES profiles(id),
  CONSTRAINT pending_bookings_dates CHECK (check_out_date > check_in_date)
);
ALTER TABLE pending_bookings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_pending_bookings_inbox
  ON pending_bookings (property_id, status, submitted_at DESC);

-- ----------------------------------------------------------------------
-- 4. DPDP Act 2023 — data subject request log
-- ----------------------------------------------------------------------
-- Indian DPDP requires that we log every export-my-data and
-- delete-my-data request, who made it, who fulfilled it, and what
-- got produced. These tables are append-only from the app side; a
-- deletion fulfilment redacts the guest row in-place and records the
-- before/after PII fields in `redacted_fields` for the audit trail.

CREATE TABLE IF NOT EXISTS dpdp_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  guest_id uuid REFERENCES guests(id),
  -- The subject's identity at request time, snapshotted so a later
  -- guest-row deletion still leaves an audit row.
  subject_name text NOT NULL,
  subject_phone text NOT NULL,
  subject_email text,
  -- Verification path. 'staff_verified' = front desk confirmed identity
  -- in person; 'otp_verified' = an OTP was sent + matched.
  verification_method text NOT NULL CHECK (verification_method IN ('staff_verified','otp_verified')),
  -- The exported JSON. Stored so subsequent audits can confirm what
  -- was given to the subject.
  export_payload jsonb NOT NULL,
  -- Optional storage URL of the produced ZIP/PDF if we ever generate one.
  export_url text,
  requested_by uuid REFERENCES profiles(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_by uuid REFERENCES profiles(id),
  fulfilled_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dpdp_exports ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_dpdp_exports_by_property
  ON dpdp_exports (property_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS dpdp_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  guest_id uuid REFERENCES guests(id),
  -- Snapshot of PII at deletion time, kept solely for the audit trail.
  -- Encryption is a future improvement; for now the row is RLS-locked.
  subject_snapshot jsonb NOT NULL,
  redacted_fields text[] NOT NULL,
  reason text,
  verification_method text NOT NULL CHECK (verification_method IN ('staff_verified','otp_verified')),
  requested_by uuid REFERENCES profiles(id),
  fulfilled_by uuid REFERENCES profiles(id),
  fulfilled_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dpdp_deletions ENABLE ROW LEVEL SECURITY;

-- Marketing consent change log. Every flip of guests.marketing_consent
-- gets a row here. Append-only.
CREATE TABLE IF NOT EXISTS marketing_consent_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  granted boolean NOT NULL,
  channel text,
  source text,            -- 'in_app','public_widget','staff_capture','dpdp_request'
  changed_by uuid REFERENCES profiles(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE marketing_consent_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_marketing_consent_log_guest
  ON marketing_consent_log (guest_id, changed_at DESC);

-- ----------------------------------------------------------------------
-- 5. GST returns (GSTR-1 / GSTR-3B export history)
-- ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gst_returns_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  return_type text NOT NULL CHECK (return_type IN ('GSTR-1','GSTR-3B')),
  period_month int NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year int NOT NULL CHECK (period_year BETWEEN 2017 AND 2100),
  -- The full generated JSON in the government schema.
  payload jsonb NOT NULL,
  -- Headline totals lifted out for the list view.
  total_invoices int NOT NULL DEFAULT 0,
  total_taxable numeric(14, 2) NOT NULL DEFAULT 0,
  total_cgst numeric(14, 2) NOT NULL DEFAULT 0,
  total_sgst numeric(14, 2) NOT NULL DEFAULT 0,
  total_igst numeric(14, 2) NOT NULL DEFAULT 0,
  generated_by uuid REFERENCES profiles(id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  -- A property + return-type + period combination is uniquely run once
  -- for posterity; re-run overwrites via the API's `force` flag.
  CONSTRAINT gst_returns_runs_unique UNIQUE (property_id, return_type, period_year, period_month)
);
ALTER TABLE gst_returns_runs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_gst_returns_runs_recent
  ON gst_returns_runs (property_id, period_year DESC, period_month DESC);

-- ----------------------------------------------------------------------
-- 6. Permissions + role grants
-- ----------------------------------------------------------------------
INSERT INTO permissions (key, area, label, description) VALUES
  ('manage_pricing_rules', 'Rates', 'Manage dynamic pricing rules',
   'Create / edit / archive pricing rules (occupancy, LOS, advance purchase, season).'),
  ('view_pricing_rules', 'Rates', 'View dynamic pricing rules',
   'See pricing rules without editing them.'),
  ('configure_booking_engine', 'Bookings', 'Configure public booking engine',
   'Toggle the public widget, set cancellation policy, choose the public rate plan.'),
  ('review_pending_bookings', 'Bookings', 'Review inbound public bookings',
   'Accept / reject bookings submitted via the public widget.'),
  ('view_dpdp', 'Compliance', 'View DPDP requests log',
   'See the data-subject export + deletion history.'),
  ('process_dpdp', 'Compliance', 'Process DPDP requests',
   'Fulfil data-export and data-deletion requests on behalf of guests.'),
  ('export_gstr', 'Compliance', 'Export GSTR returns',
   'Generate GSTR-1 / GSTR-3B JSON for filing.')
ON CONFLICT (key) DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'manager')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_pricing_rules','manage_pricing_rules',
  'configure_booking_engine','review_pending_bookings',
  'view_dpdp','process_dpdp','export_gstr'
]) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'owner')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY[
  'view_pricing_rules','configure_booking_engine','view_dpdp','export_gstr'
]) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'accountant')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY['view_pricing_rules','view_dpdp','export_gstr']) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;

WITH role_row AS (SELECT id FROM roles WHERE key = 'frontdesk')
INSERT INTO role_permissions (role_id, permission_key)
SELECT (SELECT id FROM role_row), perm
FROM unnest(ARRAY['view_pricing_rules','review_pending_bookings','process_dpdp']) AS perm
WHERE EXISTS (SELECT 1 FROM role_row)
ON CONFLICT DO NOTHING;
