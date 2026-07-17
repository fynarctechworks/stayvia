-- ============================================================================
-- 0001_stayvia_baseline.sql — Stayvia multi-tenant squashed baseline.
--
-- Replaces the legacy migrations 0001..0053 (single-property SLDT deployment)
-- with one fresh-database baseline. Differences from the legacy schema:
--
--   * Tenancy baked in: tenant = hotel = one `properties` row. `property_id`
--     is NOT NULL + FK + indexed on every operational table; nullable where a
--     NULL means "platform-shared" (roles, amenities) or "best-effort audit"
--     (activity_log, otps, notifications, idempotency_keys).
--   * Every previously-global unique is scoped per property: room numbers,
--     guest phone/email/id-proof dedup, reservation/invoice/receipt numbers,
--     room-type slugs, template keys, role keys.
--   * The global sldt_* document sequences are GONE — replaced by the
--     `property_counters` table (atomic per-hotel take-next upsert).
--   * `subscriptions` — one row per hotel, Razorpay-backed (Phase 3).
--   * No offline layer: sync_outbox / message_outbox / local_credentials and
--     the sync_capture machinery are not created.
--   * No PRIMARY property seeding — hotels are provisioned by
--     lib/provisionProperty.ts (seed + future public signup).
--
-- Idempotent: IF NOT EXISTS / guarded DO blocks throughout, so re-running
-- against a partially-migrated database is safe.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Ledger + extensions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE expense_category AS ENUM (
    'utilities', 'repairs_maintenance', 'supplies', 'salaries_wages',
    'food_kitchen', 'marketing', 'government_compliance', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE expense_payment_method AS ENUM (
    'cash', 'upi', 'card', 'bank_transfer', 'pending');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE housekeeping_task_status AS ENUM (
    'pending', 'in_progress', 'blocked', 'done', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE housekeeping_task_type AS ENUM (
    'checkout_clean', 'daily_refresh', 'deep_clean', 'inspection',
    'maintenance_followup', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE maintenance_category AS ENUM (
    'plumbing', 'electrical', 'ac_heating', 'furniture', 'appliances',
    'tv_internet', 'locks_safety', 'painting_walls', 'flooring', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE maintenance_priority AS ENUM ('low', 'medium', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE maintenance_status AS ENUM (
    'open', 'triaged', 'in_progress', 'blocked', 'resolved', 'closed', 'wont_fix');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Tenancy root
-- ---------------------------------------------------------------------------

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
  latitude numeric(9,6),
  longitude numeric(9,6),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT properties_lat_range CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
  CONSTRAINT properties_lng_range CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
);

CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY,
  full_name text NOT NULL,
  email text NOT NULL UNIQUE,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  phone text,
  -- Every staff account belongs to exactly one hotel. Nullable at the column
  -- level (the auth user is created before the profile row in signup), but
  -- treated as required by application code.
  property_id uuid REFERENCES properties(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_property ON profiles (property_id);

-- ---------------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS permissions (
  key text PRIMARY KEY,
  area text NOT NULL,
  label text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  label text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  -- NULL = shared system role (admin/frontdesk/housekeeping); NOT NULL =
  -- custom role owned by that hotel.
  property_id uuid REFERENCES properties(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_system_key
  ON roles (key) WHERE property_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_property_key
  ON roles (property_id, key) WHERE property_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid
);

CREATE TABLE IF NOT EXISTS user_permission_overrides (
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  effect text NOT NULL CHECK (effect IN ('grant', 'deny')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (user_id, permission_key)
);

-- ---------------------------------------------------------------------------
-- Per-hotel settings + room types
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one settings row per hotel, created at provisioning.
  property_id uuid NOT NULL UNIQUE REFERENCES properties(id),
  hotel_name text NOT NULL,
  hotel_address text NOT NULL,
  hotel_latitude numeric(9,6),
  hotel_longitude numeric(9,6),
  hotel_phone text NOT NULL,
  hotel_email text,
  owner_phone text,
  owner_notify_enabled boolean NOT NULL DEFAULT true,
  otp_required_for_checkin boolean NOT NULL DEFAULT true,
  wifi_ssid text,
  wifi_password text,
  hotel_gstin text NOT NULL,
  hotel_logo_url text,
  check_in_time time NOT NULL DEFAULT '12:00',
  check_out_time time NOT NULL DEFAULT '11:00',
  currency_symbol text NOT NULL DEFAULT '₹',
  invoice_prefix text NOT NULL DEFAULT 'INV',
  gst_slab_exempt_below numeric(10,2) NOT NULL DEFAULT 1000,
  gst_slab_low_rate numeric(5,2) NOT NULL DEFAULT 5,
  gst_slab_low_max numeric(10,2) NOT NULL DEFAULT 7500,
  gst_slab_high_rate numeric(5,2) NOT NULL DEFAULT 18,
  additional_charge_default_gst numeric(5,2) NOT NULL DEFAULT 18,
  gst_mode text NOT NULL DEFAULT 'inclusive' CHECK (gst_mode IN ('exclusive', 'inclusive')),
  doc_primary_color text NOT NULL DEFAULT '#0F3D2E',
  doc_accent_color text NOT NULL DEFAULT '#B08A4A',
  doc_invoice_title text NOT NULL DEFAULT 'Tax Invoice',
  doc_receipt_title text NOT NULL DEFAULT 'Payment Receipt',
  doc_footer_text text NOT NULL DEFAULT 'Thank you for staying with us.',
  doc_terms_text text,
  doc_signatory_label text NOT NULL DEFAULT 'Authorised Signatory',
  doc_invoice_page_size text NOT NULL DEFAULT 'A4',
  doc_receipt_page_size text NOT NULL DEFAULT 'A5',
  doc_show_logo boolean NOT NULL DEFAULT true,
  doc_show_gstin boolean NOT NULL DEFAULT true,
  doc_show_terms boolean NOT NULL DEFAULT false,
  doc_show_signature boolean NOT NULL DEFAULT true,
  arrival_reminder_hours_before integer NOT NULL DEFAULT 24,
  no_show_cutoff_hours integer NOT NULL DEFAULT 6,
  complimentary_unlock_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_latitude_range CHECK (hotel_latitude IS NULL OR (hotel_latitude >= -90 AND hotel_latitude <= 90)),
  CONSTRAINT settings_longitude_range CHECK (hotel_longitude IS NULL OR (hotel_longitude >= -180 AND hotel_longitude <= 180))
);

CREATE TABLE IF NOT EXISTS room_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  slug text NOT NULL,
  label text NOT NULL,
  default_rate numeric(10,2) NOT NULL,
  max_occupancy numeric NOT NULL DEFAULT 2,
  extra_person_rate numeric(10,2) NOT NULL DEFAULT 0,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  short_stay_bands jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_room_types_property_slug
  ON room_types (property_id, slug);
CREATE INDEX IF NOT EXISTS idx_room_types_property ON room_types (property_id);

-- ---------------------------------------------------------------------------
-- Rooms + amenities + images
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  room_number text NOT NULL,
  floor integer NOT NULL,
  room_type text NOT NULL,
  base_rate numeric(10,2) NOT NULL,
  max_occupancy integer NOT NULL DEFAULT 2,
  has_ac boolean NOT NULL DEFAULT true,
  has_tv boolean NOT NULL DEFAULT true,
  has_wifi boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'occupied', 'reserved', 'dirty', 'maintenance')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Room numbers are unique per hotel (hotel B may also have a room 201).
CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_property_room_number
  ON rooms (property_id, room_number);
CREATE INDEX IF NOT EXISTS idx_rooms_property ON rooms (property_id);

CREATE TABLE IF NOT EXISTS amenities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  icon text,
  category text NOT NULL DEFAULT 'general',
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  -- NULL = platform-shared catalog row; NOT NULL = hotel-custom amenity.
  property_id uuid REFERENCES properties(id),
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
  sort_order integer NOT NULL DEFAULT 100,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_room_images_room ON room_images (room_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS uq_room_images_one_primary
  ON room_images (room_id) WHERE is_primary;

-- ---------------------------------------------------------------------------
-- Guests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Guest profiles are per-hotel. The same person staying at two Stayvia
  -- hotels has two rows — keeps tenant data walls clean (DPDP).
  property_id uuid NOT NULL REFERENCES properties(id),
  full_name text NOT NULL,
  phone text NOT NULL,
  email text,
  id_proof_type text NOT NULL,
  id_proof_number_encrypted text NOT NULL,
  id_proof_last4 text NOT NULL,
  address text,
  city text,
  state text,
  nationality text NOT NULL DEFAULT 'Indian',
  gender text CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'prefer_not_to_say')),
  date_of_birth date,
  company_name text,
  gstin text,
  notes text,
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  id_proof_photo_front text,
  id_proof_photo_back text,
  guest_photo text,
  kyc_verified_at timestamptz,
  kyc_verified_by uuid,
  is_vip boolean NOT NULL DEFAULT false,
  is_blacklisted boolean NOT NULL DEFAULT false,
  blacklist_reason text,
  blacklisted_at timestamptz,
  blacklisted_by uuid REFERENCES profiles(id),
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  marketing_consent_at timestamptz,
  marketing_consent_channel text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Guest dedup is per hotel (was global): phone, email, id-proof.
CREATE UNIQUE INDEX IF NOT EXISTS uq_guests_property_phone
  ON guests (property_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS uq_guests_property_email
  ON guests (property_id, lower(email)) WHERE email IS NOT NULL AND email <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_guests_property_idproof
  ON guests (property_id, id_proof_type, id_proof_last4)
  WHERE id_proof_last4 IS NOT NULL AND id_proof_last4 <> '';
CREATE INDEX IF NOT EXISTS idx_guests_full_name
  ON guests USING gin (to_tsvector('english', full_name));
CREATE INDEX IF NOT EXISTS idx_guests_vip ON guests (is_vip) WHERE is_vip;
CREATE INDEX IF NOT EXISTS idx_guests_blacklisted ON guests (is_blacklisted) WHERE is_blacklisted;

CREATE TABLE IF NOT EXISTS guest_phone_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  phone text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phone_history_phone ON guest_phone_history (phone);
CREATE INDEX IF NOT EXISTS idx_phone_history_guest ON guest_phone_history (guest_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_phone_history_current ON guest_phone_history (guest_id) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS guest_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  body text NOT NULL,
  author_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guest_notes_guest ON guest_notes (guest_id);

CREATE TABLE IF NOT EXISTS guest_follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  task text NOT NULL,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  assigned_to uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_guest_followups_guest ON guest_follow_ups (guest_id);
CREATE INDEX IF NOT EXISTS idx_guest_followups_status_due ON guest_follow_ups (status, due_date);

-- ---------------------------------------------------------------------------
-- Rate plans / seasons / pricing rules / rate calendar / companies / groups
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rate_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  base_modifier numeric(5,3) NOT NULL DEFAULT 1.000,
  min_length_of_stay integer,
  max_length_of_stay integer,
  closed_to_arrival boolean NOT NULL DEFAULT false,
  closed_to_departure boolean NOT NULL DEFAULT false,
  is_public boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_plans_code_per_property UNIQUE (property_id, code),
  CONSTRAINT rate_plans_los_range CHECK (min_length_of_stay IS NULL OR min_length_of_stay >= 1),
  CONSTRAINT rate_plans_max_los_range CHECK (max_length_of_stay IS NULL OR max_length_of_stay >= COALESCE(min_length_of_stay, 1)),
  CONSTRAINT rate_plans_modifier_range CHECK (base_modifier > 0 AND base_modifier <= 10)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rate_plans_one_default_per_property
  ON rate_plans (property_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  modifier numeric(5,3) NOT NULL DEFAULT 1.000,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seasons_date_order CHECK (end_date >= start_date),
  CONSTRAINT seasons_modifier_range CHECK (modifier > 0 AND modifier <= 10)
);

CREATE INDEX IF NOT EXISTS idx_seasons_property_dates ON seasons (property_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  kind text NOT NULL CHECK (kind IN ('occupancy_threshold', 'length_of_stay', 'advance_purchase', 'day_of_week', 'season', 'manual')),
  condition jsonb NOT NULL DEFAULT '{}'::jsonb,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('multiplier', 'flat')),
  adjustment_value numeric(10,4) NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  stop_after boolean NOT NULL DEFAULT false,
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
    OR adjustment_type = 'flat')
);

CREATE INDEX IF NOT EXISTS idx_pricing_rules_active ON pricing_rules (property_id, priority) WHERE is_active;

CREATE TABLE IF NOT EXISTS rate_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_plan_id uuid NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  room_type text NOT NULL,
  date date NOT NULL,
  rate_override numeric(10,2),
  rooms_available integer,
  min_length_of_stay integer,
  max_length_of_stay integer,
  closed_to_arrival boolean,
  closed_to_departure boolean,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_calendar_unique_per_day UNIQUE (rate_plan_id, room_type, date),
  CONSTRAINT rate_calendar_rate_positive CHECK (rate_override IS NULL OR rate_override >= 0),
  CONSTRAINT rate_calendar_rooms_nonneg CHECK (rooms_available IS NULL OR rooms_available >= 0)
);

CREATE INDEX IF NOT EXISTS idx_rate_calendar_lookup ON rate_calendar (room_type, date, rate_plan_id);

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  code text NOT NULL,
  name text NOT NULL,
  legal_name text,
  gstin text,
  pan text,
  address text,
  city text,
  state text,
  pincode text,
  contact_name text,
  contact_phone text,
  contact_email text,
  credit_limit numeric(12,2),
  payment_terms_days integer NOT NULL DEFAULT 0,
  default_rate_plan_id uuid REFERENCES rate_plans(id),
  default_discount_pct numeric(5,2),
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_code_per_property UNIQUE (property_id, code),
  CONSTRAINT companies_credit_nonneg CHECK (credit_limit IS NULL OR credit_limit >= 0),
  CONSTRAINT companies_discount_range CHECK (default_discount_pct IS NULL OR (default_discount_pct >= 0 AND default_discount_pct <= 100)),
  CONSTRAINT companies_terms_nonneg CHECK (payment_terms_days >= 0 AND payment_terms_days <= 365)
);

CREATE INDEX IF NOT EXISTS idx_companies_property_name ON companies (property_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_companies_active ON companies (property_id, is_active) WHERE is_active;

CREATE TABLE IF NOT EXISTS group_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  group_code text NOT NULL,
  group_name text NOT NULL,
  contact_name text,
  contact_phone text,
  contact_email text,
  company_id uuid REFERENCES companies(id),
  rate_plan_id uuid REFERENCES rate_plans(id),
  block_start_date date NOT NULL,
  block_end_date date NOT NULL,
  cutoff_date date,
  rooms_blocked integer NOT NULL DEFAULT 0,
  rooms_picked_up integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'tentative'
    CHECK (status IN ('tentative', 'confirmed', 'partial', 'closed', 'cancelled')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id),
  CONSTRAINT group_blocks_code_per_property UNIQUE (property_id, group_code),
  CONSTRAINT group_blocks_dates CHECK (block_end_date > block_start_date)
);

CREATE INDEX IF NOT EXISTS idx_group_blocks_active ON group_blocks (property_id, status, block_start_date);

-- ---------------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_number text NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id),
  guest_id uuid NOT NULL REFERENCES guests(id),
  check_in_date date NOT NULL,
  check_out_date date NOT NULL,
  stay_type text NOT NULL DEFAULT 'overnight' CHECK (stay_type IN ('overnight', 'short_stay')),
  duration_hours numeric(5,2),
  num_adults integer NOT NULL DEFAULT 1,
  num_children integer NOT NULL DEFAULT 0,
  rate_per_night numeric(10,2) NOT NULL,
  num_nights integer GENERATED ALWAYS AS ((check_out_date - check_in_date)) STORED NOT NULL,
  subtotal numeric(10,2) NOT NULL,
  gst_rate numeric(5,2) NOT NULL,
  gst_amount numeric(10,2) NOT NULL,
  grand_total numeric(10,2) NOT NULL,
  gst_mode text NOT NULL DEFAULT 'exclusive' CHECK (gst_mode IN ('exclusive', 'inclusive')),
  advance_paid numeric(10,2) NOT NULL DEFAULT 0,
  wallet_credit_applied numeric(10,2) NOT NULL DEFAULT 0,
  balance_due numeric(10,2) NOT NULL,
  late_checkout_hours numeric(4,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'confirmed',
  booking_source text NOT NULL DEFAULT 'walkin',
  credit_notes text,
  cancellation_reason text,
  special_requests text,
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  checked_in_by uuid REFERENCES profiles(id),
  checked_out_by uuid REFERENCES profiles(id),
  planned_check_in_at timestamptz,
  planned_check_out_at timestamptz,
  original_check_out_date date,
  arrival_reminder_sent_at timestamptz,
  rate_plan_id uuid REFERENCES rate_plans(id),
  rate_plan_code text,
  company_id uuid REFERENCES companies(id),
  company_code text,
  group_block_id uuid REFERENCES group_blocks(id),
  created_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT res_checkout_after_checkin CHECK (
    (stay_type = 'short_stay' AND check_out_date >= check_in_date)
    OR (stay_type = 'overnight' AND check_out_date > check_in_date)),
  CONSTRAINT reservations_planned_window_valid CHECK (
    planned_check_in_at IS NULL OR planned_check_out_at IS NULL
    OR planned_check_out_at > planned_check_in_at)
);

-- Document numbers are unique per hotel (was global).
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_property_number
  ON reservations (property_id, reservation_number);
CREATE INDEX IF NOT EXISTS idx_reservations_property ON reservations (property_id, check_in_date);
CREATE INDEX IF NOT EXISTS idx_reservations_stay_type ON reservations (stay_type);
CREATE INDEX IF NOT EXISTS idx_reservations_attention_status
  ON reservations (created_at DESC) WHERE status IN ('inquiry', 'hold', 'pending_payment');
CREATE INDEX IF NOT EXISTS idx_reservations_arrival_reminder
  ON reservations (check_in_date, status)
  WHERE status = 'confirmed' AND arrival_reminder_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_company
  ON reservations (company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservations_group_block
  ON reservations (group_block_id) WHERE group_block_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS group_block_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_block_id uuid NOT NULL REFERENCES group_blocks(id) ON DELETE CASCADE,
  room_type text,
  room_id uuid REFERENCES rooms(id),
  guest_name text,
  guest_phone text,
  guest_email text,
  guest_kyc_pending boolean NOT NULL DEFAULT true,
  rate_per_night numeric(10,2),
  num_adults integer NOT NULL DEFAULT 1,
  num_children integer NOT NULL DEFAULT 0,
  reservation_id uuid REFERENCES reservations(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'no_show', 'released', 'cancelled')),
  notes text,
  CONSTRAINT group_block_rooms_target_set CHECK (room_type IS NOT NULL OR room_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_group_block_rooms_block ON group_block_rooms (group_block_id);
CREATE INDEX IF NOT EXISTS idx_group_block_rooms_reservation
  ON group_block_rooms (reservation_id) WHERE reservation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Invoices + payments + folios + charges
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id),
  reservation_id uuid NOT NULL REFERENCES reservations(id),
  guest_id uuid NOT NULL REFERENCES guests(id),
  company_id uuid REFERENCES companies(id),
  hotel_name text NOT NULL,
  hotel_address text NOT NULL,
  hotel_gstin text NOT NULL,
  guest_name text NOT NULL,
  guest_address text,
  guest_gstin text,
  subtotal numeric(10,2) NOT NULL,
  cgst_rate numeric(5,2) NOT NULL,
  cgst_amount numeric(10,2) NOT NULL,
  sgst_rate numeric(5,2) NOT NULL,
  sgst_amount numeric(10,2) NOT NULL,
  grand_total numeric(10,2) NOT NULL,
  wallet_credit_applied numeric(10,2) NOT NULL DEFAULT 0,
  total_paid numeric(10,2) NOT NULL DEFAULT 0,
  balance_due numeric(10,2) NOT NULL,
  status text NOT NULL DEFAULT 'issued',
  document_type text NOT NULL DEFAULT 'invoice' CHECK (document_type IN ('invoice', 'credit_note')),
  credit_note_for uuid REFERENCES invoices(id),
  notes text,
  issue_date date,
  reissued_from uuid REFERENCES invoices(id),
  voided_reason text,
  voided_by uuid REFERENCES profiles(id),
  scope text NOT NULL DEFAULT 'combined' CHECK (scope IN ('combined', 'room', 'partial')),
  scope_room_ids uuid[],
  issued_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_property_number
  ON invoices (property_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_property ON invoices (property_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_document_type ON invoices (document_type);
CREATE INDEX IF NOT EXISTS idx_invoices_credit_note_for
  ON invoices (credit_note_for) WHERE credit_note_for IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description text NOT NULL,
  sac_code text NOT NULL DEFAULT '9963',
  quantity integer NOT NULL DEFAULT 1,
  rate numeric(10,2) NOT NULL,
  amount numeric(10,2) NOT NULL,
  gst_rate numeric(5,2) NOT NULL,
  gst_amount numeric(10,2) NOT NULL,
  item_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reservation_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id),
  rate_per_night numeric(10,2) NOT NULL,
  sold_as_type text,
  extra_beds integer NOT NULL DEFAULT 0,
  extra_bed_rate numeric(10,2) NOT NULL DEFAULT 0,
  guest_id uuid NOT NULL REFERENCES guests(id),
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'checked_in', 'checked_out', 'cancelled')),
  checked_in_at timestamptz,
  checked_in_by uuid REFERENCES profiles(id),
  checked_out_at timestamptz,
  checked_out_by uuid REFERENCES profiles(id),
  invoice_id uuid REFERENCES invoices(id),
  effective_from date,
  effective_to date,
  swap_id uuid,
  swap_reason text,
  swapped_from_room_id uuid REFERENCES rooms(id),
  reservation_status_snapshot text,
  stay_range daterange,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT res_rooms_effective_range CHECK (
    effective_from IS NULL OR effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT reservation_rooms_no_overlap EXCLUDE USING gist (room_id WITH =, stay_range WITH &&)
    WHERE (reservation_status_snapshot IN ('hold', 'pending_payment', 'confirmed', 'checked_in'))
);

CREATE INDEX IF NOT EXISTS idx_reservation_rooms_guest ON reservation_rooms (guest_id);
CREATE INDEX IF NOT EXISTS idx_reservation_rooms_status ON reservation_rooms (reservation_id, status);
CREATE INDEX IF NOT EXISTS idx_reservation_rooms_swap
  ON reservation_rooms (swap_id) WHERE swap_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reservation_room_swap_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_room_id uuid NOT NULL REFERENCES reservation_rooms(id) ON DELETE CASCADE,
  from_room_id uuid NOT NULL REFERENCES rooms(id),
  to_room_id uuid NOT NULL REFERENCES rooms(id),
  reason text NOT NULL,
  rate_per_night numeric(10,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_swap_history_rr
  ON reservation_room_swap_history (reservation_room_id, created_at);

CREATE TABLE IF NOT EXISTS reservation_co_guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  guest_id uuid NOT NULL REFERENCES guests(id),
  "position" smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservation_co_guests_reservation_id_guest_id_key UNIQUE (reservation_id, guest_id),
  CONSTRAINT reservation_co_guests_reservation_id_position_key UNIQUE (reservation_id, "position")
);

CREATE INDEX IF NOT EXISTS idx_reservation_co_guests_reservation ON reservation_co_guests (reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_co_guests_guest ON reservation_co_guests (guest_id);

CREATE TABLE IF NOT EXISTS folios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  folio_number integer NOT NULL,
  label text NOT NULL,
  payer_type text NOT NULL CHECK (payer_type IN ('guest', 'company', 'agent', 'other')),
  payer_guest_id uuid REFERENCES guests(id),
  payer_company_id uuid REFERENCES companies(id),
  payer_name text,
  is_primary boolean NOT NULL DEFAULT false,
  charges_total numeric(12,2) NOT NULL DEFAULT 0,
  paid_total numeric(12,2) NOT NULL DEFAULT 0,
  balance_due numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'voided')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folios_number_per_reservation UNIQUE (reservation_id, folio_number),
  CONSTRAINT folios_payer_consistent CHECK (
    (payer_type = 'guest' AND payer_guest_id IS NOT NULL)
    OR (payer_type = 'company' AND payer_company_id IS NOT NULL)
    OR (payer_type = 'agent' AND payer_company_id IS NOT NULL)
    OR (payer_type = 'other' AND payer_name IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_folios_reservation ON folios (reservation_id, folio_number);
CREATE INDEX IF NOT EXISTS idx_folios_company
  ON folios (payer_company_id) WHERE payer_company_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_folios_one_primary_per_reservation
  ON folios (reservation_id) WHERE is_primary;

CREATE TABLE IF NOT EXISTS folio_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folio_id uuid NOT NULL REFERENCES folios(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('room', 'additional', 'manual', 'discount')),
  source_id uuid,
  description text NOT NULL,
  quantity numeric(10,2) NOT NULL DEFAULT 1,
  rate numeric(12,2) NOT NULL,
  amount numeric(12,2) NOT NULL,
  gst_rate numeric(5,2) NOT NULL DEFAULT 0,
  gst_amount numeric(12,2) NOT NULL DEFAULT 0,
  charge_date date NOT NULL DEFAULT CURRENT_DATE,
  voided boolean NOT NULL DEFAULT false,
  voided_reason text,
  voided_at timestamptz,
  voided_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id),
  CONSTRAINT folio_charges_amount_signed CHECK (
    (source = 'discount' AND amount <= 0) OR (source <> 'discount' AND amount >= 0))
);

CREATE INDEX IF NOT EXISTS idx_folio_charges_folio ON folio_charges (folio_id, charge_date);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number text,
  property_id uuid NOT NULL REFERENCES properties(id),
  invoice_id uuid REFERENCES invoices(id),
  reservation_id uuid NOT NULL REFERENCES reservations(id),
  folio_id uuid REFERENCES folios(id),
  amount numeric(10,2) NOT NULL,
  payment_method text NOT NULL,
  status text NOT NULL DEFAULT 'received',
  payment_date timestamptz NOT NULL DEFAULT now(),
  received_by uuid NOT NULL REFERENCES profiles(id),
  notes text,
  voided boolean NOT NULL DEFAULT false,
  voided_reason text,
  voided_by uuid,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Sign is meaningful: positive = money in, negative = refund. ₹0 receipts
  -- are intentional placeholders for a booking with no advance.
  CONSTRAINT payment_amount_not_null CHECK (amount IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_property_receipt
  ON payments (property_id, receipt_number) WHERE receipt_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_property ON payments (property_id, payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_reservation_date ON payments (reservation_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_folio ON payments (folio_id) WHERE folio_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS additional_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id),
  description text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  rate numeric(10,2) NOT NULL,
  amount numeric(10,2) NOT NULL,
  gst_rate numeric(5,2) NOT NULL DEFAULT 18,
  added_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_additional_charges_room
  ON additional_charges (room_id) WHERE room_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Guest wallet ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS guest_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  entry_type text NOT NULL CHECK (entry_type IN ('credit_issued', 'credit_used', 'cashout', 'adjustment')),
  amount numeric(10,2) NOT NULL,
  reservation_id uuid,
  invoice_id uuid,
  payment_id uuid,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guest_ledger_guest ON guest_ledger (guest_id);
CREATE INDEX IF NOT EXISTS idx_guest_ledger_created ON guest_ledger (created_at);
CREATE INDEX IF NOT EXISTS idx_guest_ledger_property ON guest_ledger (property_id);

-- ---------------------------------------------------------------------------
-- Activity log / OTPs / notifications / messages / templates
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable: platform-level events have no hotel. Stamped from the request
  -- tenant for everything else so the audit trail filters per hotel.
  property_id uuid REFERENCES properties(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  description text NOT NULL,
  performed_by uuid NOT NULL REFERENCES profiles(id),
  ip_address text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_property_created ON activity_log (property_id, created_at);

CREATE TABLE IF NOT EXISTS otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid REFERENCES properties(id),
  purpose text NOT NULL,
  channel text NOT NULL,
  target text NOT NULL,
  code_hash text NOT NULL,
  reservation_id uuid,
  guest_id uuid,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otps_target_purpose ON otps (target, purpose);
CREATE INDEX IF NOT EXISTS idx_otps_reservation ON otps (reservation_id);
CREATE INDEX IF NOT EXISTS idx_otps_ip_created ON otps (ip_address, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid REFERENCES properties(id),
  recipient_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  href text,
  payload jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread ON notifications (recipient_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications (recipient_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON messages (sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_unread ON messages (recipient_id, read_at);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, recipient_id, created_at);

CREATE TABLE IF NOT EXISTS message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  key text NOT NULL,
  subject text,
  body text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_message_templates_property_key
  ON message_templates (property_id, key);
CREATE INDEX IF NOT EXISTS idx_message_templates_property ON message_templates (property_id);

-- ---------------------------------------------------------------------------
-- Maintenance (issues = active module; tickets = Phase-2 revenue-ops module)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS maintenance_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN (
    'electrical', 'plumbing', 'ac_hvac', 'furniture', 'fixtures',
    'appliances', 'cleanliness', 'safety', 'structural', 'other')),
  severity text NOT NULL DEFAULT 'normal' CHECK (severity IN ('low', 'normal', 'urgent')),
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'cancelled')),
  reported_by uuid NOT NULL REFERENCES profiles(id),
  reported_at timestamptz NOT NULL DEFAULT now(),
  assigned_to uuid REFERENCES profiles(id),
  resolved_by uuid REFERENCES profiles(id),
  resolved_at timestamptz,
  resolution_notes text,
  cost_estimate numeric(10,2),
  cost_actual numeric(10,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maint_room_reported ON maintenance_issues (room_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_maint_status_severity
  ON maintenance_issues (status, severity) WHERE status IN ('open', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_maint_property_open
  ON maintenance_issues (property_id) WHERE status IN ('open', 'in_progress');

CREATE TABLE IF NOT EXISTS maintenance_issue_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES maintenance_issues(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES profiles(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maint_comments_issue ON maintenance_issue_comments (issue_id, created_at);

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
  blocks_room boolean NOT NULL DEFAULT false,
  estimated_cost numeric(10,2),
  actual_cost numeric(10,2),
  resolution_notes text,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maintenance_tickets_open
  ON maintenance_tickets (property_id, priority DESC, created_at DESC)
  WHERE status NOT IN ('resolved', 'closed', 'wont_fix');
CREATE INDEX IF NOT EXISTS idx_maintenance_tickets_room ON maintenance_tickets (room_id, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_tickets_assignee
  ON maintenance_tickets (assigned_to, status) WHERE assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS maintenance_ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES maintenance_tickets(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  description text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maintenance_ticket_events_ticket
  ON maintenance_ticket_events (ticket_id, created_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_ticket_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES maintenance_tickets(id) ON DELETE CASCADE,
  url text NOT NULL,
  storage_path text,
  caption text,
  uploaded_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maintenance_ticket_photos_ticket
  ON maintenance_ticket_photos (ticket_id, uploaded_at);

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS housekeeping_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  task_type housekeeping_task_type NOT NULL DEFAULT 'checkout_clean',
  status housekeeping_task_status NOT NULL DEFAULT 'pending',
  priority integer NOT NULL DEFAULT 50,
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
  CONSTRAINT housekeeping_tasks_priority_range CHECK (priority >= 0 AND priority <= 100)
);

CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_open
  ON housekeeping_tasks (property_id, status, due_at)
  WHERE status IN ('pending', 'in_progress', 'blocked');
CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_room
  ON housekeeping_tasks (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_housekeeping_tasks_assignee
  ON housekeeping_tasks (assigned_to, status) WHERE assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS housekeeping_task_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES housekeeping_tasks(id) ON DELETE CASCADE,
  label text NOT NULL,
  is_done boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 100,
  done_at timestamptz,
  done_by uuid REFERENCES profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_housekeeping_task_steps_task
  ON housekeeping_task_steps (task_id, sort_order);

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  expense_date date NOT NULL,
  category expense_category NOT NULL,
  subcategory text,
  description text NOT NULL,
  amount numeric(10,2) NOT NULL CHECK (amount >= 0),
  gst_amount numeric(10,2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
  payment_method expense_payment_method NOT NULL DEFAULT 'cash',
  paid_at timestamptz,
  vendor_name text,
  vendor_phone text,
  bill_number text,
  attachment_url text,
  recorded_by uuid NOT NULL REFERENCES profiles(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_date_category ON expenses (expense_date DESC, category);
CREATE INDEX IF NOT EXISTS idx_expenses_property_date ON expenses (property_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_pending
  ON expenses (expense_date DESC) WHERE payment_method = 'pending'::expense_payment_method;

-- ---------------------------------------------------------------------------
-- Idempotency keys
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  route_key text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response_body text NOT NULL,
  -- Nullable: stamped from the request tenant so replay records are scoped.
  property_id uuid REFERENCES properties(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Compliance / reporting / booking-engine (Phase 2/3 revenue-ops modules)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS night_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  business_date date NOT NULL,
  rooms_sold integer NOT NULL DEFAULT 0,
  rooms_available integer NOT NULL DEFAULT 0,
  occupancy_pct numeric(5,2) NOT NULL DEFAULT 0,
  room_revenue numeric(12,2) NOT NULL DEFAULT 0,
  additional_revenue numeric(12,2) NOT NULL DEFAULT 0,
  total_revenue numeric(12,2) NOT NULL DEFAULT 0,
  gst_collected numeric(12,2) NOT NULL DEFAULT 0,
  adr numeric(12,2) NOT NULL DEFAULT 0,
  revpar numeric(12,2) NOT NULL DEFAULT 0,
  arrivals integer NOT NULL DEFAULT 0,
  departures integer NOT NULL DEFAULT 0,
  no_shows integer NOT NULL DEFAULT 0,
  cancellations integer NOT NULL DEFAULT 0,
  walk_ins integer NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('running', 'completed', 'failed')),
  ran_by uuid REFERENCES profiles(id),
  ran_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT night_audit_runs_unique_per_day UNIQUE (property_id, business_date)
);

CREATE INDEX IF NOT EXISTS idx_night_audit_runs_date ON night_audit_runs (property_id, business_date DESC);

CREATE TABLE IF NOT EXISTS gst_returns_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  return_type text NOT NULL CHECK (return_type IN ('GSTR-1', 'GSTR-3B')),
  period_month integer NOT NULL CHECK (period_month >= 1 AND period_month <= 12),
  period_year integer NOT NULL CHECK (period_year >= 2017 AND period_year <= 2100),
  payload jsonb NOT NULL,
  total_invoices integer NOT NULL DEFAULT 0,
  total_taxable numeric(14,2) NOT NULL DEFAULT 0,
  total_cgst numeric(14,2) NOT NULL DEFAULT 0,
  total_sgst numeric(14,2) NOT NULL DEFAULT 0,
  total_igst numeric(14,2) NOT NULL DEFAULT 0,
  generated_by uuid REFERENCES profiles(id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gst_returns_runs_unique UNIQUE (property_id, return_type, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS idx_gst_returns_runs_recent
  ON gst_returns_runs (property_id, period_year DESC, period_month DESC);

CREATE TABLE IF NOT EXISTS dpdp_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  guest_id uuid REFERENCES guests(id),
  subject_name text NOT NULL,
  subject_phone text NOT NULL,
  subject_email text,
  verification_method text NOT NULL CHECK (verification_method IN ('staff_verified', 'otp_verified')),
  export_payload jsonb NOT NULL,
  export_url text,
  requested_by uuid REFERENCES profiles(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_by uuid REFERENCES profiles(id),
  fulfilled_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dpdp_exports_by_property ON dpdp_exports (property_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS dpdp_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  guest_id uuid REFERENCES guests(id),
  subject_snapshot jsonb NOT NULL,
  redacted_fields text[] NOT NULL,
  reason text,
  verification_method text NOT NULL CHECK (verification_method IN ('staff_verified', 'otp_verified')),
  requested_by uuid REFERENCES profiles(id),
  fulfilled_by uuid REFERENCES profiles(id),
  fulfilled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_consent_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  granted boolean NOT NULL,
  channel text,
  source text,
  changed_by uuid REFERENCES profiles(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_consent_log_guest
  ON marketing_consent_log (guest_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS booking_engine_settings (
  property_id uuid PRIMARY KEY REFERENCES properties(id),
  is_enabled boolean NOT NULL DEFAULT false,
  public_rate_plan_id uuid REFERENCES rate_plans(id),
  cancellation_policy text,
  min_advance_hours integer NOT NULL DEFAULT 0,
  max_nights_per_booking integer NOT NULL DEFAULT 14,
  require_kyc_at_booking boolean NOT NULL DEFAULT false,
  banner_image_url text,
  tagline text,
  channel_label text NOT NULL DEFAULT 'phone_whatsapp',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  public_ref text NOT NULL UNIQUE,
  check_in_date date NOT NULL,
  check_out_date date NOT NULL,
  num_adults integer NOT NULL DEFAULT 1,
  num_children integer NOT NULL DEFAULT 0,
  room_type text NOT NULL,
  rate_plan_id uuid REFERENCES rate_plans(id),
  guest_name text NOT NULL,
  guest_phone text NOT NULL,
  guest_email text,
  quoted_rate numeric(10,2) NOT NULL,
  quoted_total numeric(12,2) NOT NULL,
  payment_provider text,
  payment_order_id text,
  payment_payment_id text,
  payment_status text NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'refunded', 'failed')),
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'accepted', 'rejected', 'expired')),
  reservation_id uuid REFERENCES reservations(id),
  rejected_reason text,
  submitted_ip text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES profiles(id),
  CONSTRAINT pending_bookings_dates CHECK (check_out_date > check_in_date)
);

CREATE INDEX IF NOT EXISTS idx_pending_bookings_inbox
  ON pending_bookings (property_id, status, submitted_at DESC);

-- ---------------------------------------------------------------------------
-- Per-hotel document counters (replaces the global sldt_* sequences)
-- ---------------------------------------------------------------------------

-- Atomic take-next (lib/numbers.ts):
--   INSERT INTO property_counters (property_id, counter, value) VALUES ($1, $2, 1)
--   ON CONFLICT (property_id, counter)
--   DO UPDATE SET value = property_counters.value + 1
--   RETURNING value;
-- The row is created lazily on first use; the upsert row-locks, so it
-- serializes concurrent allocations exactly like nextval() did — but per
-- hotel, which keeps each hotel's GST invoice sequence unbroken.
CREATE TABLE IF NOT EXISTS property_counters (
  property_id uuid NOT NULL REFERENCES properties(id),
  counter text NOT NULL,  -- 'reservation' | 'invoice' | 'receipt' | 'credit_note'
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (property_id, counter)
);

-- ---------------------------------------------------------------------------
-- Subscriptions (one plan, Razorpay — Phase 3 billing)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL UNIQUE REFERENCES properties(id),
  plan text NOT NULL DEFAULT 'standard',
  status text NOT NULL DEFAULT 'trialing',  -- trialing|active|past_due|cancelled|expired
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  razorpay_customer_id text,
  razorpay_subscription_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Trigger functions (offline sync_capture intentionally absent).
-- Defined after the tables: plpgsql resolves %ROWTYPE at creation time.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fill_property_id_from_reservation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.property_id IS NULL AND NEW.reservation_id IS NOT NULL THEN
    SELECT property_id INTO NEW.property_id
    FROM reservations WHERE id = NEW.reservation_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION folios_recalc_for(target_folio_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
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
$$;

CREATE OR REPLACE FUNCTION folios_recalc_paid(target_folio_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
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
$$;

CREATE OR REPLACE FUNCTION folio_charges_after_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM folios_recalc_for(OLD.folio_id);
  ELSE
    PERFORM folios_recalc_for(NEW.folio_id);
    IF TG_OP = 'UPDATE' AND OLD.folio_id <> NEW.folio_id THEN
      PERFORM folios_recalc_for(OLD.folio_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION payments_folio_after_change() RETURNS trigger
LANGUAGE plpgsql AS $$
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
$$;

CREATE OR REPLACE FUNCTION group_blocks_recalc(target_block_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE group_blocks SET
    rooms_blocked = COALESCE((SELECT COUNT(*) FROM group_block_rooms WHERE group_block_id = target_block_id), 0),
    rooms_picked_up = COALESCE((SELECT COUNT(*) FROM group_block_rooms WHERE group_block_id = target_block_id AND reservation_id IS NOT NULL), 0)
  WHERE id = target_block_id;
END;
$$;

CREATE OR REPLACE FUNCTION group_block_rooms_after_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM group_blocks_recalc(OLD.group_block_id);
  ELSE
    PERFORM group_blocks_recalc(NEW.group_block_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION reservation_rooms_sync_stay_range() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r reservations%ROWTYPE;
  range_from DATE;
  range_to DATE;
BEGIN
  SELECT * INTO r FROM reservations WHERE id = NEW.reservation_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  range_from := COALESCE(NEW.effective_from, r.check_in_date);
  range_to := COALESCE(NEW.effective_to, r.check_out_date);
  -- Guard against a degenerate range (segment endpoints inverted or equal).
  IF range_to <= range_from THEN
    range_to := range_from + 1;
  END IF;
  NEW.stay_range := daterange(range_from, range_to, '[)');
  NEW.reservation_status_snapshot := r.status;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reservations_propagate_to_rooms() RETURNS trigger
LANGUAGE plpgsql AS $$
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
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TRIGGER trg_invoices_fill_property
    BEFORE INSERT ON invoices
    FOR EACH ROW EXECUTE FUNCTION fill_property_id_from_reservation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_payments_fill_property
    BEFORE INSERT ON payments
    FOR EACH ROW EXECUTE FUNCTION fill_property_id_from_reservation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_folio_charges_recalc
    AFTER INSERT OR UPDATE OR DELETE ON folio_charges
    FOR EACH ROW EXECUTE FUNCTION folio_charges_after_change();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_payments_folio_recalc
    AFTER INSERT OR UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION payments_folio_after_change();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_group_block_rooms_recalc
    AFTER INSERT OR UPDATE OR DELETE ON group_block_rooms
    FOR EACH ROW EXECUTE FUNCTION group_block_rooms_after_change();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_reservation_rooms_sync_stay_range
    BEFORE INSERT OR UPDATE OF reservation_id ON reservation_rooms
    FOR EACH ROW EXECUTE FUNCTION reservation_rooms_sync_stay_range();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_reservations_propagate_to_rooms
    AFTER UPDATE ON reservations
    FOR EACH ROW EXECUTE FUNCTION reservations_propagate_to_rooms();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- RLS: deny-all defense-in-depth. The API connects with a privileged role
-- that bypasses RLS; enabling it with no policies blocks any other role
-- (e.g. Supabase anon/authenticated keys) from touching business data.
-- ---------------------------------------------------------------------------

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE additional_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE amenities ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_engine_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE dpdp_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dpdp_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE folio_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE folios ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_block_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE gst_returns_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_phone_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE housekeeping_task_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE housekeeping_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_issue_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_ticket_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_consent_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE night_audit_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE otps ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_co_guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_room_swap_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_amenities ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
