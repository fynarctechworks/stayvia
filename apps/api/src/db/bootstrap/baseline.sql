-- Required extensions (not carried by the schema-only dump).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Auto-generated complete schema baseline (schema-only pg_dump through migration 0053).
-- Applied by the offline sidecar on first run when SLDT_SCHEMA_BOOTSTRAP=1.
-- After this, all numbered migrations are marked applied (this dump already
-- reflects them), so migrate.mjs runs only future migrations.

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: expense_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.expense_category AS ENUM (
    'utilities',
    'repairs_maintenance',
    'supplies',
    'salaries_wages',
    'food_kitchen',
    'marketing',
    'government_compliance',
    'other'
);


--
-- Name: expense_payment_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.expense_payment_method AS ENUM (
    'cash',
    'upi',
    'card',
    'bank_transfer',
    'pending'
);


--
-- Name: housekeeping_task_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.housekeeping_task_status AS ENUM (
    'pending',
    'in_progress',
    'blocked',
    'done',
    'skipped'
);


--
-- Name: housekeeping_task_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.housekeeping_task_type AS ENUM (
    'checkout_clean',
    'daily_refresh',
    'deep_clean',
    'inspection',
    'maintenance_followup',
    'custom'
);


--
-- Name: maintenance_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.maintenance_category AS ENUM (
    'plumbing',
    'electrical',
    'ac_heating',
    'furniture',
    'appliances',
    'tv_internet',
    'locks_safety',
    'painting_walls',
    'flooring',
    'other'
);


--
-- Name: maintenance_priority; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.maintenance_priority AS ENUM (
    'low',
    'medium',
    'high',
    'urgent'
);


--
-- Name: maintenance_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.maintenance_status AS ENUM (
    'open',
    'triaged',
    'in_progress',
    'blocked',
    'resolved',
    'closed',
    'wont_fix'
);


--
-- Name: fill_property_id_from_reservation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fill_property_id_from_reservation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.property_id IS NULL AND NEW.reservation_id IS NOT NULL THEN
    SELECT property_id INTO NEW.property_id
    FROM reservations WHERE id = NEW.reservation_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: folio_charges_after_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.folio_charges_after_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: folios_recalc_for(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.folios_recalc_for(target_folio_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: folios_recalc_paid(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.folios_recalc_paid(target_folio_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: group_block_rooms_after_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.group_block_rooms_after_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM group_blocks_recalc(OLD.group_block_id);
  ELSE
    PERFORM group_blocks_recalc(NEW.group_block_id);
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: group_blocks_recalc(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.group_blocks_recalc(target_block_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE group_blocks SET
    rooms_blocked = COALESCE((SELECT COUNT(*) FROM group_block_rooms WHERE group_block_id = target_block_id), 0),
    rooms_picked_up = COALESCE((SELECT COUNT(*) FROM group_block_rooms WHERE group_block_id = target_block_id AND reservation_id IS NOT NULL), 0)
  WHERE id = target_block_id;
END;
$$;


--
-- Name: payments_folio_after_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.payments_folio_after_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: reservation_rooms_sync_stay_range(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reservation_rooms_sync_stay_range() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
  -- Guard against a degenerate range (segment endpoints inverted or
  -- equal). Postgres collapses daterange(X, X, '[)') to empty, which
  -- would let everything overlap. Fall back to a 1-day range so the
  -- exclusion constraint still does something useful.
  IF range_to <= range_from THEN
    range_to := range_from + 1;
  END IF;
  NEW.stay_range := daterange(range_from, range_to, '[)');
  NEW.reservation_status_snapshot := r.status;
  RETURN NEW;
END;
$$;


--
-- Name: reservations_propagate_to_rooms(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reservations_propagate_to_rooms() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: sync_capture(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_capture() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_op   text;
  v_id   uuid;
  v_data jsonb;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    v_op := 'D'; v_id := OLD.id; v_data := NULL;
  ELSIF (TG_OP = 'UPDATE') THEN
    v_op := 'U'; v_id := NEW.id; v_data := to_jsonb(NEW);
  ELSE
    v_op := 'I'; v_id := NEW.id; v_data := to_jsonb(NEW);
  END IF;

  INSERT INTO sync_outbox (table_name, op, row_id, row_data)
  VALUES (TG_TABLE_NAME, v_op, v_id, v_data);

  IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    description text NOT NULL,
    performed_by uuid NOT NULL,
    ip_address text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: additional_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.additional_charges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_id uuid NOT NULL,
    description text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    rate numeric(10,2) NOT NULL,
    amount numeric(10,2) NOT NULL,
    gst_rate numeric(5,2) DEFAULT '18'::numeric NOT NULL,
    added_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    room_id uuid
);


--
-- Name: amenities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.amenities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    icon text,
    category text DEFAULT 'general'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: booking_engine_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_engine_settings (
    property_id uuid NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    public_rate_plan_id uuid,
    cancellation_policy text,
    min_advance_hours integer DEFAULT 0 NOT NULL,
    max_nights_per_booking integer DEFAULT 14 NOT NULL,
    require_kyc_at_booking boolean DEFAULT false NOT NULL,
    banner_image_url text,
    tagline text,
    channel_label text DEFAULT 'phone_whatsapp'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
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
    payment_terms_days integer DEFAULT 0 NOT NULL,
    default_rate_plan_id uuid,
    default_discount_pct numeric(5,2),
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT companies_credit_nonneg CHECK (((credit_limit IS NULL) OR (credit_limit >= (0)::numeric))),
    CONSTRAINT companies_discount_range CHECK (((default_discount_pct IS NULL) OR ((default_discount_pct >= (0)::numeric) AND (default_discount_pct <= (100)::numeric)))),
    CONSTRAINT companies_terms_nonneg CHECK (((payment_terms_days >= 0) AND (payment_terms_days <= 365)))
);


--
-- Name: dpdp_deletions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dpdp_deletions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    guest_id uuid,
    subject_snapshot jsonb NOT NULL,
    redacted_fields text[] NOT NULL,
    reason text,
    verification_method text NOT NULL,
    requested_by uuid,
    fulfilled_by uuid,
    fulfilled_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dpdp_deletions_verification_method_check CHECK ((verification_method = ANY (ARRAY['staff_verified'::text, 'otp_verified'::text])))
);


--
-- Name: dpdp_exports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dpdp_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    guest_id uuid,
    subject_name text NOT NULL,
    subject_phone text NOT NULL,
    subject_email text,
    verification_method text NOT NULL,
    export_payload jsonb NOT NULL,
    export_url text,
    requested_by uuid,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    fulfilled_by uuid,
    fulfilled_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dpdp_exports_verification_method_check CHECK ((verification_method = ANY (ARRAY['staff_verified'::text, 'otp_verified'::text])))
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    expense_date date NOT NULL,
    category public.expense_category NOT NULL,
    subcategory text,
    description text NOT NULL,
    amount numeric(10,2) NOT NULL,
    gst_amount numeric(10,2) DEFAULT 0 NOT NULL,
    payment_method public.expense_payment_method DEFAULT 'cash'::public.expense_payment_method NOT NULL,
    paid_at timestamp with time zone,
    vendor_name text,
    vendor_phone text,
    bill_number text,
    attachment_url text,
    recorded_by uuid NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT expenses_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT expenses_gst_amount_check CHECK ((gst_amount >= (0)::numeric))
);


--
-- Name: folio_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.folio_charges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    folio_id uuid NOT NULL,
    source text NOT NULL,
    source_id uuid,
    description text NOT NULL,
    quantity numeric(10,2) DEFAULT 1 NOT NULL,
    rate numeric(12,2) NOT NULL,
    amount numeric(12,2) NOT NULL,
    gst_rate numeric(5,2) DEFAULT 0 NOT NULL,
    gst_amount numeric(12,2) DEFAULT 0 NOT NULL,
    charge_date date DEFAULT CURRENT_DATE NOT NULL,
    voided boolean DEFAULT false NOT NULL,
    voided_reason text,
    voided_at timestamp with time zone,
    voided_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT folio_charges_amount_signed CHECK ((((source = 'discount'::text) AND (amount <= (0)::numeric)) OR ((source <> 'discount'::text) AND (amount >= (0)::numeric)))),
    CONSTRAINT folio_charges_source_check CHECK ((source = ANY (ARRAY['room'::text, 'additional'::text, 'manual'::text, 'discount'::text])))
);


--
-- Name: folios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.folios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    folio_number integer NOT NULL,
    label text NOT NULL,
    payer_type text NOT NULL,
    payer_guest_id uuid,
    payer_company_id uuid,
    payer_name text,
    is_primary boolean DEFAULT false NOT NULL,
    charges_total numeric(12,2) DEFAULT 0 NOT NULL,
    paid_total numeric(12,2) DEFAULT 0 NOT NULL,
    balance_due numeric(12,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT folios_payer_consistent CHECK ((((payer_type = 'guest'::text) AND (payer_guest_id IS NOT NULL)) OR ((payer_type = 'company'::text) AND (payer_company_id IS NOT NULL)) OR ((payer_type = 'agent'::text) AND (payer_company_id IS NOT NULL)) OR ((payer_type = 'other'::text) AND (payer_name IS NOT NULL)))),
    CONSTRAINT folios_payer_type_check CHECK ((payer_type = ANY (ARRAY['guest'::text, 'company'::text, 'agent'::text, 'other'::text]))),
    CONSTRAINT folios_status_check CHECK ((status = ANY (ARRAY['open'::text, 'settled'::text, 'voided'::text])))
);


--
-- Name: group_block_rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_block_rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_block_id uuid NOT NULL,
    room_type text,
    room_id uuid,
    guest_name text,
    guest_phone text,
    guest_email text,
    guest_kyc_pending boolean DEFAULT true NOT NULL,
    rate_per_night numeric(10,2),
    num_adults integer DEFAULT 1 NOT NULL,
    num_children integer DEFAULT 0 NOT NULL,
    reservation_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    notes text,
    CONSTRAINT group_block_rooms_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'no_show'::text, 'released'::text, 'cancelled'::text]))),
    CONSTRAINT group_block_rooms_target_set CHECK (((room_type IS NOT NULL) OR (room_id IS NOT NULL)))
);


--
-- Name: group_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    group_code text NOT NULL,
    group_name text NOT NULL,
    contact_name text,
    contact_phone text,
    contact_email text,
    company_id uuid,
    rate_plan_id uuid,
    block_start_date date NOT NULL,
    block_end_date date NOT NULL,
    cutoff_date date,
    rooms_blocked integer DEFAULT 0 NOT NULL,
    rooms_picked_up integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'tentative'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT group_blocks_dates CHECK ((block_end_date > block_start_date)),
    CONSTRAINT group_blocks_status_check CHECK ((status = ANY (ARRAY['tentative'::text, 'confirmed'::text, 'partial'::text, 'closed'::text, 'cancelled'::text])))
);


--
-- Name: gst_returns_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gst_returns_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    return_type text NOT NULL,
    period_month integer NOT NULL,
    period_year integer NOT NULL,
    payload jsonb NOT NULL,
    total_invoices integer DEFAULT 0 NOT NULL,
    total_taxable numeric(14,2) DEFAULT 0 NOT NULL,
    total_cgst numeric(14,2) DEFAULT 0 NOT NULL,
    total_sgst numeric(14,2) DEFAULT 0 NOT NULL,
    total_igst numeric(14,2) DEFAULT 0 NOT NULL,
    generated_by uuid,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gst_returns_runs_period_month_check CHECK (((period_month >= 1) AND (period_month <= 12))),
    CONSTRAINT gst_returns_runs_period_year_check CHECK (((period_year >= 2017) AND (period_year <= 2100))),
    CONSTRAINT gst_returns_runs_return_type_check CHECK ((return_type = ANY (ARRAY['GSTR-1'::text, 'GSTR-3B'::text])))
);


--
-- Name: guest_follow_ups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_follow_ups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guest_id uuid NOT NULL,
    task text NOT NULL,
    due_date date NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    assigned_to uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: guest_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guest_id uuid NOT NULL,
    entry_type text NOT NULL,
    amount numeric(10,2) NOT NULL,
    reservation_id uuid,
    invoice_id uuid,
    payment_id uuid,
    note text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT guest_ledger_entry_type_check CHECK ((entry_type = ANY (ARRAY['credit_issued'::text, 'credit_used'::text, 'cashout'::text, 'adjustment'::text])))
);


--
-- Name: guest_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guest_id uuid NOT NULL,
    body text NOT NULL,
    author_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: guest_phone_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guest_phone_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guest_id uuid NOT NULL,
    phone text NOT NULL,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_to timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: guests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name text NOT NULL,
    phone text NOT NULL,
    email text,
    id_proof_type text NOT NULL,
    id_proof_number_encrypted text NOT NULL,
    id_proof_last4 text NOT NULL,
    address text,
    city text,
    state text,
    nationality text DEFAULT 'Indian'::text NOT NULL,
    date_of_birth date,
    company_name text,
    gstin text,
    notes text,
    id_proof_photo_front text,
    id_proof_photo_back text,
    kyc_verified_at timestamp with time zone,
    kyc_verified_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tags text[] DEFAULT ARRAY[]::text[] NOT NULL,
    guest_photo text,
    is_vip boolean DEFAULT false NOT NULL,
    is_blacklisted boolean DEFAULT false NOT NULL,
    blacklist_reason text,
    blacklisted_at timestamp with time zone,
    blacklisted_by uuid,
    preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    marketing_consent_at timestamp with time zone,
    marketing_consent_channel text,
    property_id uuid NOT NULL,
    gender text,
    CONSTRAINT guests_gender_check CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text, 'prefer_not_to_say'::text]))))
);


--
-- Name: COLUMN guests.preferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.guests.preferences IS 'Structured per-guest preferences. Known keys (extensible): smoking (bool), floor ("low"|"mid"|"high"), pillow ("soft"|"firm"), wakeup_time (HH:MM), dietary (string[]).';


--
-- Name: housekeeping_task_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.housekeeping_task_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    label text NOT NULL,
    is_done boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    done_at timestamp with time zone,
    done_by uuid
);


--
-- Name: housekeeping_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.housekeeping_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    room_id uuid NOT NULL,
    reservation_id uuid,
    task_type public.housekeeping_task_type DEFAULT 'checkout_clean'::public.housekeeping_task_type NOT NULL,
    status public.housekeeping_task_status DEFAULT 'pending'::public.housekeeping_task_status NOT NULL,
    priority integer DEFAULT 50 NOT NULL,
    assigned_to uuid,
    assigned_by uuid,
    assigned_at timestamp with time zone,
    due_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    completed_by uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT housekeeping_tasks_priority_range CHECK (((priority >= 0) AND (priority <= 100)))
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    id text NOT NULL,
    user_id text NOT NULL,
    route_key text NOT NULL,
    key text NOT NULL,
    request_hash text NOT NULL,
    status_code integer NOT NULL,
    response_body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: invoice_line_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_line_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invoice_id uuid NOT NULL,
    description text NOT NULL,
    sac_code text DEFAULT '9963'::text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    rate numeric(10,2) NOT NULL,
    amount numeric(10,2) NOT NULL,
    gst_rate numeric(5,2) NOT NULL,
    gst_amount numeric(10,2) NOT NULL,
    item_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invoice_number text NOT NULL,
    reservation_id uuid NOT NULL,
    guest_id uuid NOT NULL,
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
    total_paid numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    balance_due numeric(10,2) NOT NULL,
    status text DEFAULT 'issued'::text NOT NULL,
    voided_reason text,
    voided_by uuid,
    issued_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    notes text,
    issue_date date,
    reissued_from uuid,
    wallet_credit_applied numeric(10,2) DEFAULT 0 NOT NULL,
    property_id uuid NOT NULL,
    company_id uuid,
    scope text DEFAULT 'combined'::text NOT NULL,
    scope_room_ids uuid[],
    document_type text DEFAULT 'invoice'::text NOT NULL,
    credit_note_for uuid,
    CONSTRAINT invoices_document_type_check CHECK ((document_type = ANY (ARRAY['invoice'::text, 'credit_note'::text]))),
    CONSTRAINT invoices_scope_check CHECK ((scope = ANY (ARRAY['combined'::text, 'room'::text, 'partial'::text])))
);


--
-- Name: local_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_credentials (
    profile_id uuid NOT NULL,
    password_hash text,
    pin_hash text,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: maintenance_issue_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_issue_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    issue_id uuid NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: maintenance_issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_issues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid,
    room_id uuid NOT NULL,
    category text NOT NULL,
    severity text DEFAULT 'normal'::text NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'open'::text NOT NULL,
    reported_by uuid NOT NULL,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_to uuid,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    resolution_notes text,
    cost_estimate numeric(10,2),
    cost_actual numeric(10,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT maintenance_issues_category_check CHECK ((category = ANY (ARRAY['electrical'::text, 'plumbing'::text, 'ac_hvac'::text, 'furniture'::text, 'fixtures'::text, 'appliances'::text, 'cleanliness'::text, 'safety'::text, 'structural'::text, 'other'::text]))),
    CONSTRAINT maintenance_issues_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'normal'::text, 'urgent'::text]))),
    CONSTRAINT maintenance_issues_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text, 'cancelled'::text])))
);


--
-- Name: maintenance_ticket_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_ticket_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    event_type text NOT NULL,
    description text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    actor_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: maintenance_ticket_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_ticket_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    url text NOT NULL,
    storage_path text,
    caption text,
    uploaded_by uuid,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: maintenance_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_number text NOT NULL,
    property_id uuid NOT NULL,
    room_id uuid,
    reservation_id uuid,
    category public.maintenance_category DEFAULT 'other'::public.maintenance_category NOT NULL,
    priority public.maintenance_priority DEFAULT 'medium'::public.maintenance_priority NOT NULL,
    status public.maintenance_status DEFAULT 'open'::public.maintenance_status NOT NULL,
    title text NOT NULL,
    description text,
    reported_by uuid,
    assigned_to uuid,
    assigned_at timestamp with time zone,
    due_at timestamp with time zone,
    blocks_room boolean DEFAULT false NOT NULL,
    estimated_cost numeric(10,2),
    actual_cost numeric(10,2),
    resolution_notes text,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_consent_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_consent_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    guest_id uuid NOT NULL,
    granted boolean NOT NULL,
    channel text,
    source text,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: message_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel text NOT NULL,
    recipient text NOT NULL,
    payload text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_outbox_channel_check CHECK ((channel = ANY (ARRAY['sms'::text, 'email'::text]))),
    CONSTRAINT message_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])))
);


--
-- Name: message_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    subject text,
    body text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sender_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    body text NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: night_audit_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.night_audit_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    business_date date NOT NULL,
    rooms_sold integer DEFAULT 0 NOT NULL,
    rooms_available integer DEFAULT 0 NOT NULL,
    occupancy_pct numeric(5,2) DEFAULT 0 NOT NULL,
    room_revenue numeric(12,2) DEFAULT 0 NOT NULL,
    additional_revenue numeric(12,2) DEFAULT 0 NOT NULL,
    total_revenue numeric(12,2) DEFAULT 0 NOT NULL,
    gst_collected numeric(12,2) DEFAULT 0 NOT NULL,
    adr numeric(12,2) DEFAULT 0 NOT NULL,
    revpar numeric(12,2) DEFAULT 0 NOT NULL,
    arrivals integer DEFAULT 0 NOT NULL,
    departures integer DEFAULT 0 NOT NULL,
    no_shows integer DEFAULT 0 NOT NULL,
    cancellations integer DEFAULT 0 NOT NULL,
    walk_ins integer DEFAULT 0 NOT NULL,
    snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'completed'::text NOT NULL,
    ran_by uuid,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT night_audit_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_id uuid NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    href text,
    payload jsonb,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    purpose text NOT NULL,
    channel text NOT NULL,
    target text NOT NULL,
    code_hash text NOT NULL,
    reservation_id uuid,
    guest_id uuid,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invoice_id uuid,
    reservation_id uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    payment_method text NOT NULL,
    payment_date timestamp with time zone DEFAULT now() NOT NULL,
    received_by uuid NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    voided boolean DEFAULT false NOT NULL,
    voided_reason text,
    voided_by uuid,
    voided_at timestamp with time zone,
    receipt_number text,
    status text DEFAULT 'received'::text NOT NULL,
    property_id uuid NOT NULL,
    folio_id uuid,
    CONSTRAINT payment_amount_not_null CHECK ((amount IS NOT NULL))
);


--
-- Name: pending_bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_bookings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    public_ref text NOT NULL,
    check_in_date date NOT NULL,
    check_out_date date NOT NULL,
    num_adults integer DEFAULT 1 NOT NULL,
    num_children integer DEFAULT 0 NOT NULL,
    room_type text NOT NULL,
    rate_plan_id uuid,
    guest_name text NOT NULL,
    guest_phone text NOT NULL,
    guest_email text,
    quoted_rate numeric(10,2) NOT NULL,
    quoted_total numeric(12,2) NOT NULL,
    payment_provider text,
    payment_order_id text,
    payment_payment_id text,
    payment_status text DEFAULT 'unpaid'::text NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    reservation_id uuid,
    rejected_reason text,
    submitted_ip text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    CONSTRAINT pending_bookings_dates CHECK ((check_out_date > check_in_date)),
    CONSTRAINT pending_bookings_payment_status_check CHECK ((payment_status = ANY (ARRAY['unpaid'::text, 'pending'::text, 'paid'::text, 'refunded'::text, 'failed'::text]))),
    CONSTRAINT pending_bookings_status_check CHECK ((status = ANY (ARRAY['received'::text, 'accepted'::text, 'rejected'::text, 'expired'::text])))
);


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    key text NOT NULL,
    area text NOT NULL,
    label text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pricing_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    kind text NOT NULL,
    condition jsonb DEFAULT '{}'::jsonb NOT NULL,
    adjustment_type text NOT NULL,
    adjustment_value numeric(10,4) NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    stop_after boolean DEFAULT false NOT NULL,
    applies_to_rate_plan_id uuid,
    applies_to_room_type text,
    is_active boolean DEFAULT true NOT NULL,
    starts_at date,
    ends_at date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pricing_rules_adjustment_sane CHECK ((((adjustment_type = 'multiplier'::text) AND (adjustment_value > (0)::numeric) AND (adjustment_value <= (10)::numeric)) OR (adjustment_type = 'flat'::text))),
    CONSTRAINT pricing_rules_adjustment_type_check CHECK ((adjustment_type = ANY (ARRAY['multiplier'::text, 'flat'::text]))),
    CONSTRAINT pricing_rules_kind_check CHECK ((kind = ANY (ARRAY['occupancy_threshold'::text, 'length_of_stay'::text, 'advance_purchase'::text, 'day_of_week'::text, 'season'::text, 'manual'::text])))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    phone text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: properties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.properties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    legal_name text,
    gstin text,
    address text,
    city text,
    state text,
    country text DEFAULT 'India'::text NOT NULL,
    pincode text,
    phone text,
    email text,
    timezone text DEFAULT 'Asia/Kolkata'::text NOT NULL,
    currency text DEFAULT 'INR'::text NOT NULL,
    default_check_in_time text DEFAULT '12:00'::text NOT NULL,
    default_check_out_time text DEFAULT '11:00'::text NOT NULL,
    latitude numeric(9,6),
    longitude numeric(9,6),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT properties_lat_range CHECK (((latitude IS NULL) OR ((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric)))),
    CONSTRAINT properties_lng_range CHECK (((longitude IS NULL) OR ((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric))))
);


--
-- Name: rate_calendar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_calendar (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rate_plan_id uuid NOT NULL,
    room_type text NOT NULL,
    date date NOT NULL,
    rate_override numeric(10,2),
    rooms_available integer,
    min_length_of_stay integer,
    max_length_of_stay integer,
    closed_to_arrival boolean,
    closed_to_departure boolean,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_calendar_rate_positive CHECK (((rate_override IS NULL) OR (rate_override >= (0)::numeric))),
    CONSTRAINT rate_calendar_rooms_nonneg CHECK (((rooms_available IS NULL) OR (rooms_available >= 0)))
);


--
-- Name: rate_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    base_modifier numeric(5,3) DEFAULT 1.000 NOT NULL,
    min_length_of_stay integer,
    max_length_of_stay integer,
    closed_to_arrival boolean DEFAULT false NOT NULL,
    closed_to_departure boolean DEFAULT false NOT NULL,
    is_public boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_plans_los_range CHECK (((min_length_of_stay IS NULL) OR (min_length_of_stay >= 1))),
    CONSTRAINT rate_plans_max_los_range CHECK (((max_length_of_stay IS NULL) OR (max_length_of_stay >= COALESCE(min_length_of_stay, 1)))),
    CONSTRAINT rate_plans_modifier_range CHECK (((base_modifier > (0)::numeric) AND (base_modifier <= (10)::numeric)))
);


--
-- Name: reservation_co_guests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservation_co_guests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_id uuid NOT NULL,
    guest_id uuid NOT NULL,
    "position" smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reservation_room_swap_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservation_room_swap_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_room_id uuid NOT NULL,
    from_room_id uuid NOT NULL,
    to_room_id uuid NOT NULL,
    reason text NOT NULL,
    rate_per_night numeric(10,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: reservation_rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservation_rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_id uuid NOT NULL,
    room_id uuid NOT NULL,
    rate_per_night numeric(10,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sold_as_type text,
    reservation_status_snapshot text,
    guest_id uuid NOT NULL,
    status text DEFAULT 'confirmed'::text NOT NULL,
    checked_in_at timestamp with time zone,
    checked_in_by uuid,
    checked_out_at timestamp with time zone,
    checked_out_by uuid,
    invoice_id uuid,
    effective_from date,
    effective_to date,
    swap_id uuid,
    swap_reason text,
    swapped_from_room_id uuid,
    extra_beds integer DEFAULT 0 NOT NULL,
    extra_bed_rate numeric(10,2) DEFAULT 0 NOT NULL,
    stay_range daterange,
    CONSTRAINT res_rooms_effective_range CHECK (((effective_from IS NULL) OR (effective_to IS NULL) OR (effective_to > effective_from))),
    CONSTRAINT reservation_rooms_status_check CHECK ((status = ANY (ARRAY['confirmed'::text, 'checked_in'::text, 'checked_out'::text, 'cancelled'::text])))
);


--
-- Name: reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reservation_number text NOT NULL,
    guest_id uuid NOT NULL,
    check_in_date date NOT NULL,
    check_out_date date NOT NULL,
    num_adults integer DEFAULT 1 NOT NULL,
    num_children integer DEFAULT 0 NOT NULL,
    rate_per_night numeric(10,2) NOT NULL,
    num_nights integer GENERATED ALWAYS AS ((check_out_date - check_in_date)) STORED NOT NULL,
    subtotal numeric(10,2) NOT NULL,
    gst_rate numeric(5,2) NOT NULL,
    gst_amount numeric(10,2) NOT NULL,
    grand_total numeric(10,2) NOT NULL,
    advance_paid numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    balance_due numeric(10,2) NOT NULL,
    status text DEFAULT 'confirmed'::text NOT NULL,
    cancellation_reason text,
    special_requests text,
    checked_in_at timestamp with time zone,
    checked_out_at timestamp with time zone,
    checked_in_by uuid,
    checked_out_by uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    booking_source text DEFAULT 'walkin'::text NOT NULL,
    credit_notes text,
    wallet_credit_applied numeric(10,2) DEFAULT 0 NOT NULL,
    late_checkout_hours numeric(4,2) DEFAULT 0 NOT NULL,
    stay_type text DEFAULT 'overnight'::text NOT NULL,
    duration_hours numeric(5,2),
    gst_mode text DEFAULT 'exclusive'::text NOT NULL,
    property_id uuid NOT NULL,
    rate_plan_id uuid,
    rate_plan_code text,
    company_id uuid,
    company_code text,
    group_block_id uuid,
    arrival_reminder_sent_at timestamp with time zone,
    planned_check_in_at timestamp with time zone,
    planned_check_out_at timestamp with time zone,
    original_check_out_date date,
    CONSTRAINT res_checkout_after_checkin CHECK ((((stay_type = 'short_stay'::text) AND (check_out_date >= check_in_date)) OR ((stay_type = 'overnight'::text) AND (check_out_date > check_in_date)))),
    CONSTRAINT reservations_gst_mode_check CHECK ((gst_mode = ANY (ARRAY['exclusive'::text, 'inclusive'::text]))),
    CONSTRAINT reservations_planned_window_valid CHECK (((planned_check_in_at IS NULL) OR (planned_check_out_at IS NULL) OR (planned_check_out_at > planned_check_in_at))),
    CONSTRAINT reservations_stay_type_check CHECK ((stay_type = ANY (ARRAY['overnight'::text, 'short_stay'::text])))
);


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    role_id uuid NOT NULL,
    permission_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    description text,
    is_system boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: room_amenities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_amenities (
    room_id uuid NOT NULL,
    amenity_id uuid NOT NULL
);


--
-- Name: room_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_images (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    url text NOT NULL,
    storage_path text,
    caption text,
    sort_order integer DEFAULT 100 NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: room_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.room_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    label text NOT NULL,
    default_rate numeric(10,2) NOT NULL,
    max_occupancy numeric DEFAULT '2'::numeric NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    short_stay_bands jsonb DEFAULT '[]'::jsonb NOT NULL,
    extra_person_rate numeric(10,2) DEFAULT 0 NOT NULL
);


--
-- Name: rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rooms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_number text NOT NULL,
    floor integer NOT NULL,
    room_type text NOT NULL,
    base_rate numeric(10,2) NOT NULL,
    max_occupancy integer DEFAULT 2 NOT NULL,
    has_ac boolean DEFAULT true NOT NULL,
    has_tv boolean DEFAULT true NOT NULL,
    has_wifi boolean DEFAULT true NOT NULL,
    status text DEFAULT 'available'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    property_id uuid NOT NULL,
    CONSTRAINT rooms_status_check CHECK ((status = ANY (ARRAY['available'::text, 'occupied'::text, 'reserved'::text, 'dirty'::text, 'maintenance'::text])))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seasons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    name text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    modifier numeric(5,3) DEFAULT 1.000 NOT NULL,
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT seasons_date_order CHECK ((end_date >= start_date)),
    CONSTRAINT seasons_modifier_range CHECK (((modifier > (0)::numeric) AND (modifier <= (10)::numeric)))
);


--
-- Name: settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hotel_name text NOT NULL,
    hotel_address text NOT NULL,
    hotel_phone text NOT NULL,
    hotel_email text,
    hotel_gstin text NOT NULL,
    hotel_logo_url text,
    check_in_time time without time zone DEFAULT '12:00:00'::time without time zone NOT NULL,
    check_out_time time without time zone DEFAULT '11:00:00'::time without time zone NOT NULL,
    currency_symbol text DEFAULT '₹'::text NOT NULL,
    invoice_prefix text DEFAULT 'INV'::text NOT NULL,
    gst_slab_exempt_below numeric(10,2) DEFAULT '1000'::numeric NOT NULL,
    gst_slab_low_rate numeric(5,2) DEFAULT '5'::numeric NOT NULL,
    gst_slab_low_max numeric(10,2) DEFAULT '7500'::numeric NOT NULL,
    gst_slab_high_rate numeric(5,2) DEFAULT '18'::numeric NOT NULL,
    additional_charge_default_gst numeric(5,2) DEFAULT '18'::numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    doc_primary_color text DEFAULT '#0F3D2E'::text NOT NULL,
    doc_accent_color text DEFAULT '#B08A4A'::text NOT NULL,
    doc_invoice_title text DEFAULT 'Tax Invoice'::text NOT NULL,
    doc_receipt_title text DEFAULT 'Payment Receipt'::text NOT NULL,
    doc_footer_text text DEFAULT 'Thank you for staying with us.'::text NOT NULL,
    doc_terms_text text,
    doc_signatory_label text DEFAULT 'Authorised Signatory'::text NOT NULL,
    doc_invoice_page_size text DEFAULT 'A4'::text NOT NULL,
    doc_receipt_page_size text DEFAULT 'A4'::text NOT NULL,
    doc_show_logo boolean DEFAULT true NOT NULL,
    doc_show_gstin boolean DEFAULT true NOT NULL,
    doc_show_terms boolean DEFAULT false NOT NULL,
    doc_show_signature boolean DEFAULT true NOT NULL,
    owner_phone text,
    owner_notify_enabled boolean DEFAULT true NOT NULL,
    wifi_ssid text,
    wifi_password text,
    gst_mode text DEFAULT 'inclusive'::text NOT NULL,
    hotel_latitude numeric(9,6),
    hotel_longitude numeric(9,6),
    arrival_reminder_hours_before integer DEFAULT 24 NOT NULL,
    no_show_cutoff_hours integer DEFAULT 6 NOT NULL,
    complimentary_unlock_code text,
    otp_required_for_checkin boolean DEFAULT true NOT NULL,
    CONSTRAINT settings_gst_mode_check CHECK ((gst_mode = ANY (ARRAY['exclusive'::text, 'inclusive'::text]))),
    CONSTRAINT settings_latitude_range CHECK (((hotel_latitude IS NULL) OR ((hotel_latitude >= ('-90'::integer)::numeric) AND (hotel_latitude <= (90)::numeric)))),
    CONSTRAINT settings_longitude_range CHECK (((hotel_longitude IS NULL) OR ((hotel_longitude >= ('-180'::integer)::numeric) AND (hotel_longitude <= (180)::numeric))))
);


--
-- Name: sldt_credit_note_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sldt_credit_note_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sldt_invoice_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sldt_invoice_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sldt_maintenance_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sldt_maintenance_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sldt_receipt_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sldt_receipt_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sldt_reservation_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sldt_reservation_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sync_change_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sync_change_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sync_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_outbox (
    change_seq bigint DEFAULT nextval('public.sync_change_seq'::regclass) NOT NULL,
    table_name text NOT NULL,
    op text NOT NULL,
    row_id uuid NOT NULL,
    row_data jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pushed_at timestamp with time zone,
    CONSTRAINT sync_outbox_op_check CHECK ((op = ANY (ARRAY['I'::text, 'U'::text, 'D'::text])))
);


--
-- Name: user_permission_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_permission_overrides (
    user_id uuid NOT NULL,
    permission_key text NOT NULL,
    effect text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT user_permission_overrides_effect_check CHECK ((effect = ANY (ARRAY['grant'::text, 'deny'::text])))
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_by uuid
);


--
-- Name: activity_log activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_pkey PRIMARY KEY (id);


--
-- Name: additional_charges additional_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.additional_charges
    ADD CONSTRAINT additional_charges_pkey PRIMARY KEY (id);


--
-- Name: amenities amenities_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.amenities
    ADD CONSTRAINT amenities_key_key UNIQUE (key);


--
-- Name: amenities amenities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.amenities
    ADD CONSTRAINT amenities_pkey PRIMARY KEY (id);


--
-- Name: booking_engine_settings booking_engine_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_engine_settings
    ADD CONSTRAINT booking_engine_settings_pkey PRIMARY KEY (property_id);


--
-- Name: companies companies_code_per_property; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_code_per_property UNIQUE (property_id, code);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: dpdp_deletions dpdp_deletions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dpdp_deletions
    ADD CONSTRAINT dpdp_deletions_pkey PRIMARY KEY (id);


--
-- Name: dpdp_exports dpdp_exports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dpdp_exports
    ADD CONSTRAINT dpdp_exports_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: folio_charges folio_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folio_charges
    ADD CONSTRAINT folio_charges_pkey PRIMARY KEY (id);


--
-- Name: folios folios_number_per_reservation; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folios
    ADD CONSTRAINT folios_number_per_reservation UNIQUE (reservation_id, folio_number);


--
-- Name: folios folios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folios
    ADD CONSTRAINT folios_pkey PRIMARY KEY (id);


--
-- Name: group_block_rooms group_block_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_block_rooms
    ADD CONSTRAINT group_block_rooms_pkey PRIMARY KEY (id);


--
-- Name: group_blocks group_blocks_code_per_property; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_blocks
    ADD CONSTRAINT group_blocks_code_per_property UNIQUE (property_id, group_code);


--
-- Name: group_blocks group_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_blocks
    ADD CONSTRAINT group_blocks_pkey PRIMARY KEY (id);


--
-- Name: gst_returns_runs gst_returns_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gst_returns_runs
    ADD CONSTRAINT gst_returns_runs_pkey PRIMARY KEY (id);


--
-- Name: gst_returns_runs gst_returns_runs_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gst_returns_runs
    ADD CONSTRAINT gst_returns_runs_unique UNIQUE (property_id, return_type, period_year, period_month);


--
-- Name: guest_follow_ups guest_follow_ups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_follow_ups
    ADD CONSTRAINT guest_follow_ups_pkey PRIMARY KEY (id);


--
-- Name: guest_ledger guest_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_ledger
    ADD CONSTRAINT guest_ledger_pkey PRIMARY KEY (id);


--
-- Name: guest_notes guest_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_notes
    ADD CONSTRAINT guest_notes_pkey PRIMARY KEY (id);


--
-- Name: guest_phone_history guest_phone_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_phone_history
    ADD CONSTRAINT guest_phone_history_pkey PRIMARY KEY (id);


--
-- Name: guests guests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guests
    ADD CONSTRAINT guests_pkey PRIMARY KEY (id);


--
-- Name: housekeeping_task_steps housekeeping_task_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_task_steps
    ADD CONSTRAINT housekeeping_task_steps_pkey PRIMARY KEY (id);


--
-- Name: housekeeping_tasks housekeeping_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_tasks
    ADD CONSTRAINT housekeeping_tasks_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: invoice_line_items invoice_line_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_invoice_number_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_invoice_number_unique UNIQUE (invoice_number);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: local_credentials local_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_credentials
    ADD CONSTRAINT local_credentials_pkey PRIMARY KEY (profile_id);


--
-- Name: maintenance_issue_comments maintenance_issue_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_issue_comments
    ADD CONSTRAINT maintenance_issue_comments_pkey PRIMARY KEY (id);


--
-- Name: maintenance_issues maintenance_issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_issues
    ADD CONSTRAINT maintenance_issues_pkey PRIMARY KEY (id);


--
-- Name: maintenance_ticket_events maintenance_ticket_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_ticket_events
    ADD CONSTRAINT maintenance_ticket_events_pkey PRIMARY KEY (id);


--
-- Name: maintenance_ticket_photos maintenance_ticket_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_ticket_photos
    ADD CONSTRAINT maintenance_ticket_photos_pkey PRIMARY KEY (id);


--
-- Name: maintenance_tickets maintenance_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tickets
    ADD CONSTRAINT maintenance_tickets_pkey PRIMARY KEY (id);


--
-- Name: maintenance_tickets maintenance_tickets_ticket_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tickets
    ADD CONSTRAINT maintenance_tickets_ticket_number_key UNIQUE (ticket_number);


--
-- Name: marketing_consent_log marketing_consent_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_consent_log
    ADD CONSTRAINT marketing_consent_log_pkey PRIMARY KEY (id);


--
-- Name: message_outbox message_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_outbox
    ADD CONSTRAINT message_outbox_pkey PRIMARY KEY (id);


--
-- Name: message_templates message_templates_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_key_key UNIQUE (key);


--
-- Name: message_templates message_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: night_audit_runs night_audit_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.night_audit_runs
    ADD CONSTRAINT night_audit_runs_pkey PRIMARY KEY (id);


--
-- Name: night_audit_runs night_audit_runs_unique_per_day; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.night_audit_runs
    ADD CONSTRAINT night_audit_runs_unique_per_day UNIQUE (property_id, business_date);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: otps otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otps
    ADD CONSTRAINT otps_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: pending_bookings pending_bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_bookings
    ADD CONSTRAINT pending_bookings_pkey PRIMARY KEY (id);


--
-- Name: pending_bookings pending_bookings_public_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_bookings
    ADD CONSTRAINT pending_bookings_public_ref_key UNIQUE (public_ref);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (key);


--
-- Name: pricing_rules pricing_rules_code_per_property; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules
    ADD CONSTRAINT pricing_rules_code_per_property UNIQUE (property_id, code);


--
-- Name: pricing_rules pricing_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules
    ADD CONSTRAINT pricing_rules_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_email_unique UNIQUE (email);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: properties properties_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_code_key UNIQUE (code);


--
-- Name: properties properties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_pkey PRIMARY KEY (id);


--
-- Name: rate_calendar rate_calendar_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_calendar
    ADD CONSTRAINT rate_calendar_pkey PRIMARY KEY (id);


--
-- Name: rate_calendar rate_calendar_unique_per_day; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_calendar
    ADD CONSTRAINT rate_calendar_unique_per_day UNIQUE (rate_plan_id, room_type, date);


--
-- Name: rate_plans rate_plans_code_per_property; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_plans
    ADD CONSTRAINT rate_plans_code_per_property UNIQUE (property_id, code);


--
-- Name: rate_plans rate_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_plans
    ADD CONSTRAINT rate_plans_pkey PRIMARY KEY (id);


--
-- Name: reservation_co_guests reservation_co_guests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_co_guests
    ADD CONSTRAINT reservation_co_guests_pkey PRIMARY KEY (id);


--
-- Name: reservation_co_guests reservation_co_guests_reservation_id_guest_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_co_guests
    ADD CONSTRAINT reservation_co_guests_reservation_id_guest_id_key UNIQUE (reservation_id, guest_id);


--
-- Name: reservation_co_guests reservation_co_guests_reservation_id_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_co_guests
    ADD CONSTRAINT reservation_co_guests_reservation_id_position_key UNIQUE (reservation_id, "position");


--
-- Name: reservation_room_swap_history reservation_room_swap_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_room_swap_history
    ADD CONSTRAINT reservation_room_swap_history_pkey PRIMARY KEY (id);


--
-- Name: reservation_rooms reservation_rooms_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_rooms
    ADD CONSTRAINT reservation_rooms_no_overlap EXCLUDE USING gist (room_id WITH =, stay_range WITH &&) WHERE ((reservation_status_snapshot = ANY (ARRAY['hold'::text, 'pending_payment'::text, 'confirmed'::text, 'checked_in'::text])));


--
-- Name: reservation_rooms reservation_rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_rooms
    ADD CONSTRAINT reservation_rooms_pkey PRIMARY KEY (id);


--
-- Name: reservations reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_pkey PRIMARY KEY (id);


--
-- Name: reservations reservations_reservation_number_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_reservation_number_unique UNIQUE (reservation_number);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_key);


--
-- Name: roles roles_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_key_key UNIQUE (key);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: room_amenities room_amenities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_amenities
    ADD CONSTRAINT room_amenities_pkey PRIMARY KEY (room_id, amenity_id);


--
-- Name: room_images room_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_images
    ADD CONSTRAINT room_images_pkey PRIMARY KEY (id);


--
-- Name: room_types room_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_types
    ADD CONSTRAINT room_types_pkey PRIMARY KEY (id);


--
-- Name: room_types room_types_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_types
    ADD CONSTRAINT room_types_slug_unique UNIQUE (slug);


--
-- Name: rooms rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_pkey PRIMARY KEY (id);


--
-- Name: rooms rooms_room_number_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_room_number_unique UNIQUE (room_number);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: seasons seasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT seasons_pkey PRIMARY KEY (id);


--
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);


--
-- Name: sync_outbox sync_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_outbox
    ADD CONSTRAINT sync_outbox_pkey PRIMARY KEY (change_seq);


--
-- Name: user_permission_overrides user_permission_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT user_permission_overrides_pkey PRIMARY KEY (user_id, permission_key);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id);


--
-- Name: idx_additional_charges_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_additional_charges_room ON public.additional_charges USING btree (room_id) WHERE (room_id IS NOT NULL);


--
-- Name: idx_companies_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_active ON public.companies USING btree (property_id, is_active) WHERE is_active;


--
-- Name: idx_companies_property_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_property_name ON public.companies USING btree (property_id, lower(name));


--
-- Name: idx_dpdp_exports_by_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dpdp_exports_by_property ON public.dpdp_exports USING btree (property_id, requested_at DESC);


--
-- Name: idx_expenses_date_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_date_category ON public.expenses USING btree (expense_date DESC, category);


--
-- Name: idx_expenses_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_pending ON public.expenses USING btree (expense_date DESC) WHERE (payment_method = 'pending'::public.expense_payment_method);


--
-- Name: idx_expenses_property_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_property_date ON public.expenses USING btree (property_id, expense_date DESC);


--
-- Name: idx_folio_charges_folio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_folio_charges_folio ON public.folio_charges USING btree (folio_id, charge_date);


--
-- Name: idx_folios_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_folios_company ON public.folios USING btree (payer_company_id) WHERE (payer_company_id IS NOT NULL);


--
-- Name: idx_folios_reservation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_folios_reservation ON public.folios USING btree (reservation_id, folio_number);


--
-- Name: idx_group_block_rooms_block; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_group_block_rooms_block ON public.group_block_rooms USING btree (group_block_id);


--
-- Name: idx_group_block_rooms_reservation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_group_block_rooms_reservation ON public.group_block_rooms USING btree (reservation_id) WHERE (reservation_id IS NOT NULL);


--
-- Name: idx_group_blocks_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_group_blocks_active ON public.group_blocks USING btree (property_id, status, block_start_date);


--
-- Name: idx_gst_returns_runs_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gst_returns_runs_recent ON public.gst_returns_runs USING btree (property_id, period_year DESC, period_month DESC);


--
-- Name: idx_guest_followups_guest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_followups_guest ON public.guest_follow_ups USING btree (guest_id);


--
-- Name: idx_guest_followups_status_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_followups_status_due ON public.guest_follow_ups USING btree (status, due_date);


--
-- Name: idx_guest_ledger_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_ledger_created ON public.guest_ledger USING btree (created_at);


--
-- Name: idx_guest_ledger_guest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_ledger_guest ON public.guest_ledger USING btree (guest_id);


--
-- Name: idx_guest_notes_guest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guest_notes_guest ON public.guest_notes USING btree (guest_id);


--
-- Name: idx_guests_blacklisted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guests_blacklisted ON public.guests USING btree (is_blacklisted) WHERE is_blacklisted;


--
-- Name: idx_guests_email_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_guests_email_unique ON public.guests USING btree (lower(email)) WHERE ((email IS NOT NULL) AND (email <> ''::text));


--
-- Name: idx_guests_full_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guests_full_name ON public.guests USING gin (to_tsvector('english'::regconfig, full_name));


--
-- Name: idx_guests_idproof_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_guests_idproof_unique ON public.guests USING btree (id_proof_type, id_proof_last4) WHERE ((id_proof_last4 IS NOT NULL) AND (id_proof_last4 <> ''::text));


--
-- Name: idx_guests_phone_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_guests_phone_unique ON public.guests USING btree (phone);


--
-- Name: idx_guests_vip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_guests_vip ON public.guests USING btree (is_vip) WHERE is_vip;


--
-- Name: idx_housekeeping_task_steps_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_housekeeping_task_steps_task ON public.housekeeping_task_steps USING btree (task_id, sort_order);


--
-- Name: idx_housekeeping_tasks_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_housekeeping_tasks_assignee ON public.housekeeping_tasks USING btree (assigned_to, status) WHERE (assigned_to IS NOT NULL);


--
-- Name: idx_housekeeping_tasks_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_housekeeping_tasks_open ON public.housekeeping_tasks USING btree (property_id, status, due_at) WHERE (status = ANY (ARRAY['pending'::public.housekeeping_task_status, 'in_progress'::public.housekeeping_task_status, 'blocked'::public.housekeeping_task_status]));


--
-- Name: idx_housekeeping_tasks_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_housekeeping_tasks_room ON public.housekeeping_tasks USING btree (room_id, created_at DESC);


--
-- Name: idx_idempotency_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idempotency_expiry ON public.idempotency_keys USING btree (expires_at);


--
-- Name: idx_invoices_credit_note_for; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_credit_note_for ON public.invoices USING btree (credit_note_for) WHERE (credit_note_for IS NOT NULL);


--
-- Name: idx_invoices_document_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_document_type ON public.invoices USING btree (document_type);


--
-- Name: idx_invoices_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoices_property ON public.invoices USING btree (property_id, created_at);


--
-- Name: idx_maint_comments_issue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maint_comments_issue ON public.maintenance_issue_comments USING btree (issue_id, created_at);


--
-- Name: idx_maint_property_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maint_property_open ON public.maintenance_issues USING btree (property_id) WHERE (status = ANY (ARRAY['open'::text, 'in_progress'::text]));


--
-- Name: idx_maint_room_reported; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maint_room_reported ON public.maintenance_issues USING btree (room_id, reported_at DESC);


--
-- Name: idx_maint_status_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maint_status_severity ON public.maintenance_issues USING btree (status, severity) WHERE (status = ANY (ARRAY['open'::text, 'in_progress'::text]));


--
-- Name: idx_maintenance_ticket_events_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_ticket_events_ticket ON public.maintenance_ticket_events USING btree (ticket_id, created_at DESC);


--
-- Name: idx_maintenance_ticket_photos_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_ticket_photos_ticket ON public.maintenance_ticket_photos USING btree (ticket_id, uploaded_at);


--
-- Name: idx_maintenance_tickets_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_tickets_assignee ON public.maintenance_tickets USING btree (assigned_to, status) WHERE (assigned_to IS NOT NULL);


--
-- Name: idx_maintenance_tickets_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_tickets_open ON public.maintenance_tickets USING btree (property_id, priority DESC, created_at DESC) WHERE (status <> ALL (ARRAY['resolved'::public.maintenance_status, 'closed'::public.maintenance_status, 'wont_fix'::public.maintenance_status]));


--
-- Name: idx_maintenance_tickets_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_tickets_room ON public.maintenance_tickets USING btree (room_id, status);


--
-- Name: idx_marketing_consent_log_guest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_consent_log_guest ON public.marketing_consent_log USING btree (guest_id, changed_at DESC);


--
-- Name: idx_messages_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_pair ON public.messages USING btree (sender_id, recipient_id, created_at);


--
-- Name: idx_messages_recipient_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_recipient_unread ON public.messages USING btree (recipient_id, read_at);


--
-- Name: idx_messages_sender_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_sender_created ON public.messages USING btree (sender_id, created_at);


--
-- Name: idx_night_audit_runs_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_night_audit_runs_date ON public.night_audit_runs USING btree (property_id, business_date DESC);


--
-- Name: idx_notifications_recipient_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_recipient_created ON public.notifications USING btree (recipient_id, created_at);


--
-- Name: idx_notifications_recipient_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_recipient_unread ON public.notifications USING btree (recipient_id, read_at);


--
-- Name: idx_otps_ip_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_otps_ip_created ON public.otps USING btree (ip_address, created_at);


--
-- Name: idx_otps_reservation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_otps_reservation ON public.otps USING btree (reservation_id);


--
-- Name: idx_otps_target_purpose; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_otps_target_purpose ON public.otps USING btree (target, purpose);


--
-- Name: idx_payments_folio; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_folio ON public.payments USING btree (folio_id) WHERE (folio_id IS NOT NULL);


--
-- Name: idx_payments_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_property ON public.payments USING btree (property_id, payment_date);


--
-- Name: idx_payments_receipt_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_payments_receipt_number ON public.payments USING btree (receipt_number) WHERE (receipt_number IS NOT NULL);


--
-- Name: idx_payments_reservation_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_reservation_date ON public.payments USING btree (reservation_id, payment_date DESC);


--
-- Name: idx_pending_bookings_inbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_bookings_inbox ON public.pending_bookings USING btree (property_id, status, submitted_at DESC);


--
-- Name: idx_phone_history_current; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_history_current ON public.guest_phone_history USING btree (guest_id) WHERE (valid_to IS NULL);


--
-- Name: idx_phone_history_guest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_history_guest ON public.guest_phone_history USING btree (guest_id, valid_from DESC);


--
-- Name: idx_phone_history_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phone_history_phone ON public.guest_phone_history USING btree (phone);


--
-- Name: idx_pricing_rules_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_rules_active ON public.pricing_rules USING btree (property_id, priority) WHERE is_active;


--
-- Name: idx_rate_calendar_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_calendar_lookup ON public.rate_calendar USING btree (room_type, date, rate_plan_id);


--
-- Name: idx_reservation_co_guests_guest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservation_co_guests_guest ON public.reservation_co_guests USING btree (guest_id);


--
-- Name: idx_reservation_co_guests_reservation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservation_co_guests_reservation ON public.reservation_co_guests USING btree (reservation_id);


--
-- Name: idx_reservation_rooms_guest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservation_rooms_guest ON public.reservation_rooms USING btree (guest_id);


--
-- Name: idx_reservation_rooms_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservation_rooms_status ON public.reservation_rooms USING btree (reservation_id, status);


--
-- Name: idx_reservation_rooms_swap; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservation_rooms_swap ON public.reservation_rooms USING btree (swap_id) WHERE (swap_id IS NOT NULL);


--
-- Name: idx_reservations_arrival_reminder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservations_arrival_reminder ON public.reservations USING btree (check_in_date, status) WHERE ((status = 'confirmed'::text) AND (arrival_reminder_sent_at IS NULL));


--
-- Name: idx_reservations_attention_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservations_attention_status ON public.reservations USING btree (created_at DESC) WHERE (status = ANY (ARRAY['inquiry'::text, 'hold'::text, 'pending_payment'::text]));


--
-- Name: idx_reservations_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservations_company ON public.reservations USING btree (company_id) WHERE (company_id IS NOT NULL);


--
-- Name: idx_reservations_group_block; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservations_group_block ON public.reservations USING btree (group_block_id) WHERE (group_block_id IS NOT NULL);


--
-- Name: idx_reservations_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservations_property ON public.reservations USING btree (property_id, check_in_date);


--
-- Name: idx_reservations_stay_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reservations_stay_type ON public.reservations USING btree (stay_type);


--
-- Name: idx_room_images_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_room_images_room ON public.room_images USING btree (room_id, sort_order);


--
-- Name: idx_rooms_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rooms_property ON public.rooms USING btree (property_id);


--
-- Name: idx_seasons_property_dates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seasons_property_dates ON public.seasons USING btree (property_id, start_date, end_date);


--
-- Name: idx_swap_history_rr; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_swap_history_rr ON public.reservation_room_swap_history USING btree (reservation_room_id, created_at);


--
-- Name: message_outbox_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_outbox_pending_idx ON public.message_outbox USING btree (next_attempt_at) WHERE (status = 'pending'::text);


--
-- Name: sync_outbox_unpushed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sync_outbox_unpushed_idx ON public.sync_outbox USING btree (change_seq) WHERE (pushed_at IS NULL);


--
-- Name: uq_folios_one_primary_per_reservation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_folios_one_primary_per_reservation ON public.folios USING btree (reservation_id) WHERE is_primary;


--
-- Name: uq_rate_plans_one_default_per_property; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_rate_plans_one_default_per_property ON public.rate_plans USING btree (property_id) WHERE is_default;


--
-- Name: uq_room_images_one_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_room_images_one_primary ON public.room_images USING btree (room_id) WHERE is_primary;


--
-- Name: folio_charges trg_folio_charges_recalc; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_folio_charges_recalc AFTER INSERT OR DELETE OR UPDATE ON public.folio_charges FOR EACH ROW EXECUTE FUNCTION public.folio_charges_after_change();


--
-- Name: group_block_rooms trg_group_block_rooms_recalc; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_group_block_rooms_recalc AFTER INSERT OR DELETE OR UPDATE ON public.group_block_rooms FOR EACH ROW EXECUTE FUNCTION public.group_block_rooms_after_change();


--
-- Name: invoices trg_invoices_fill_property; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_invoices_fill_property BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.fill_property_id_from_reservation();


--
-- Name: payments trg_payments_fill_property; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payments_fill_property BEFORE INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION public.fill_property_id_from_reservation();


--
-- Name: payments trg_payments_folio_recalc; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payments_folio_recalc AFTER INSERT OR DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.payments_folio_after_change();


--
-- Name: reservation_rooms trg_reservation_rooms_sync_stay_range; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_reservation_rooms_sync_stay_range BEFORE INSERT OR UPDATE OF reservation_id ON public.reservation_rooms FOR EACH ROW EXECUTE FUNCTION public.reservation_rooms_sync_stay_range();


--
-- Name: reservations trg_reservations_propagate_to_rooms; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_reservations_propagate_to_rooms AFTER UPDATE ON public.reservations FOR EACH ROW EXECUTE FUNCTION public.reservations_propagate_to_rooms();


--
-- Name: activity_log activity_log_performed_by_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_performed_by_profiles_id_fk FOREIGN KEY (performed_by) REFERENCES public.profiles(id);


--
-- Name: additional_charges additional_charges_added_by_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.additional_charges
    ADD CONSTRAINT additional_charges_added_by_profiles_id_fk FOREIGN KEY (added_by) REFERENCES public.profiles(id);


--
-- Name: additional_charges additional_charges_reservation_id_reservations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.additional_charges
    ADD CONSTRAINT additional_charges_reservation_id_reservations_id_fk FOREIGN KEY (reservation_id) REFERENCES public.reservations(id) ON DELETE CASCADE;


--
-- Name: additional_charges additional_charges_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.additional_charges
    ADD CONSTRAINT additional_charges_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: booking_engine_settings booking_engine_settings_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_engine_settings
    ADD CONSTRAINT booking_engine_settings_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: booking_engine_settings booking_engine_settings_public_rate_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_engine_settings
    ADD CONSTRAINT booking_engine_settings_public_rate_plan_id_fkey FOREIGN KEY (public_rate_plan_id) REFERENCES public.rate_plans(id);


--
-- Name: companies companies_default_rate_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_default_rate_plan_id_fkey FOREIGN KEY (default_rate_plan_id) REFERENCES public.rate_plans(id);


--
-- Name: companies companies_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: dpdp_deletions dpdp_deletions_fulfilled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dpdp_deletions
    ADD CONSTRAINT dpdp_deletions_fulfilled_by_fkey FOREIGN KEY (fulfilled_by) REFERENCES public.profiles(id);


--
-- Name: dpdp_deletions dpdp_deletions_guest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dpdp_deletions
    ADD CONSTRAINT dpdp_deletions_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES public.guests(id);


--
-- Name: dpdp_deletions dpdp_deletions_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dpdp_deletions
    ADD CONSTRAINT dpdp_deletions_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: dpdp_deletions dpdp_deletions_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dpdp_deletions
    ADD CONSTRAINT dpdp_deletions_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.profiles(id);


--
-- Name: dpdp_exports dpdp_exports_fulfilled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dpdp_exports
    ADD CONSTRAINT dpdp_exports_fulfilled_by_fkey FOREIGN KEY (fulfilled_by) REFERENCES public.profiles(id);


--
-- Name: dpdp_exports dpdp_exports_guest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dpdp_exports
    ADD CONSTRAINT dpdp_exports_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES public.guests(id);


--
-- Name: dpdp_exports dpdp_exports_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dpdp_exports
    ADD CONSTRAINT dpdp_exports_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: dpdp_exports dpdp_exports_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dpdp_exports
    ADD CONSTRAINT dpdp_exports_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.profiles(id);


--
-- Name: expenses expenses_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: expenses expenses_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.profiles(id);


--
-- Name: folio_charges folio_charges_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folio_charges
    ADD CONSTRAINT folio_charges_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: folio_charges folio_charges_folio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folio_charges
    ADD CONSTRAINT folio_charges_folio_id_fkey FOREIGN KEY (folio_id) REFERENCES public.folios(id) ON DELETE CASCADE;


--
-- Name: folio_charges folio_charges_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folio_charges
    ADD CONSTRAINT folio_charges_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.profiles(id);


--
-- Name: folios folios_payer_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folios
    ADD CONSTRAINT folios_payer_company_id_fkey FOREIGN KEY (payer_company_id) REFERENCES public.companies(id);


--
-- Name: folios folios_payer_guest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folios
    ADD CONSTRAINT folios_payer_guest_id_fkey FOREIGN KEY (payer_guest_id) REFERENCES public.guests(id);


--
-- Name: folios folios_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folios
    ADD CONSTRAINT folios_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: folios folios_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.folios
    ADD CONSTRAINT folios_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id) ON DELETE CASCADE;


--
-- Name: group_block_rooms group_block_rooms_group_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_block_rooms
    ADD CONSTRAINT group_block_rooms_group_block_id_fkey FOREIGN KEY (group_block_id) REFERENCES public.group_blocks(id) ON DELETE CASCADE;


--
-- Name: group_block_rooms group_block_rooms_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_block_rooms
    ADD CONSTRAINT group_block_rooms_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: group_block_rooms group_block_rooms_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_block_rooms
    ADD CONSTRAINT group_block_rooms_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: group_blocks group_blocks_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_blocks
    ADD CONSTRAINT group_blocks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: group_blocks group_blocks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_blocks
    ADD CONSTRAINT group_blocks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: group_blocks group_blocks_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_blocks
    ADD CONSTRAINT group_blocks_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: group_blocks group_blocks_rate_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_blocks
    ADD CONSTRAINT group_blocks_rate_plan_id_fkey FOREIGN KEY (rate_plan_id) REFERENCES public.rate_plans(id);


--
-- Name: gst_returns_runs gst_returns_runs_generated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gst_returns_runs
    ADD CONSTRAINT gst_returns_runs_generated_by_fkey FOREIGN KEY (generated_by) REFERENCES public.profiles(id);


--
-- Name: gst_returns_runs gst_returns_runs_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gst_returns_runs
    ADD CONSTRAINT gst_returns_runs_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: guest_follow_ups guest_follow_ups_guest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_follow_ups
    ADD CONSTRAINT guest_follow_ups_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES public.guests(id) ON DELETE CASCADE;


--
-- Name: guest_ledger guest_ledger_guest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_ledger
    ADD CONSTRAINT guest_ledger_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES public.guests(id) ON DELETE CASCADE;


--
-- Name: guest_notes guest_notes_guest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_notes
    ADD CONSTRAINT guest_notes_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES public.guests(id) ON DELETE CASCADE;


--
-- Name: guest_phone_history guest_phone_history_guest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guest_phone_history
    ADD CONSTRAINT guest_phone_history_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES public.guests(id) ON DELETE CASCADE;


--
-- Name: guests guests_blacklisted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guests
    ADD CONSTRAINT guests_blacklisted_by_fkey FOREIGN KEY (blacklisted_by) REFERENCES public.profiles(id);


--
-- Name: guests guests_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guests
    ADD CONSTRAINT guests_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: housekeeping_task_steps housekeeping_task_steps_done_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_task_steps
    ADD CONSTRAINT housekeeping_task_steps_done_by_fkey FOREIGN KEY (done_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: housekeeping_task_steps housekeeping_task_steps_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_task_steps
    ADD CONSTRAINT housekeeping_task_steps_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.housekeeping_tasks(id) ON DELETE CASCADE;


--
-- Name: housekeeping_tasks housekeeping_tasks_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_tasks
    ADD CONSTRAINT housekeeping_tasks_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: housekeeping_tasks housekeeping_tasks_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_tasks
    ADD CONSTRAINT housekeeping_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: housekeeping_tasks housekeeping_tasks_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_tasks
    ADD CONSTRAINT housekeeping_tasks_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: housekeeping_tasks housekeeping_tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_tasks
    ADD CONSTRAINT housekeeping_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: housekeeping_tasks housekeeping_tasks_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_tasks
    ADD CONSTRAINT housekeeping_tasks_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: housekeeping_tasks housekeeping_tasks_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_tasks
    ADD CONSTRAINT housekeeping_tasks_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id) ON DELETE SET NULL;


--
-- Name: housekeeping_tasks housekeeping_tasks_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_tasks
    ADD CONSTRAINT housekeeping_tasks_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: invoice_line_items invoice_line_items_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_invoice_id_invoices_id_fk FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: invoices invoices_credit_note_for_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_credit_note_for_fkey FOREIGN KEY (credit_note_for) REFERENCES public.invoices(id);


--
-- Name: invoices invoices_guest_id_guests_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_guest_id_guests_id_fk FOREIGN KEY (guest_id) REFERENCES public.guests(id);


--
-- Name: invoices invoices_issued_by_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_issued_by_profiles_id_fk FOREIGN KEY (issued_by) REFERENCES public.profiles(id);


--
-- Name: invoices invoices_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: invoices invoices_reissued_from_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_reissued_from_fkey FOREIGN KEY (reissued_from) REFERENCES public.invoices(id);


--
-- Name: invoices invoices_reservation_id_reservations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_reservation_id_reservations_id_fk FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: invoices invoices_voided_by_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_voided_by_profiles_id_fk FOREIGN KEY (voided_by) REFERENCES public.profiles(id);


--
-- Name: local_credentials local_credentials_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_credentials
    ADD CONSTRAINT local_credentials_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: maintenance_issue_comments maintenance_issue_comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_issue_comments
    ADD CONSTRAINT maintenance_issue_comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id);


--
-- Name: maintenance_issue_comments maintenance_issue_comments_issue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_issue_comments
    ADD CONSTRAINT maintenance_issue_comments_issue_id_fkey FOREIGN KEY (issue_id) REFERENCES public.maintenance_issues(id) ON DELETE CASCADE;


--
-- Name: maintenance_issues maintenance_issues_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_issues
    ADD CONSTRAINT maintenance_issues_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.profiles(id);


--
-- Name: maintenance_issues maintenance_issues_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_issues
    ADD CONSTRAINT maintenance_issues_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: maintenance_issues maintenance_issues_reported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_issues
    ADD CONSTRAINT maintenance_issues_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES public.profiles(id);


--
-- Name: maintenance_issues maintenance_issues_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_issues
    ADD CONSTRAINT maintenance_issues_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.profiles(id);


--
-- Name: maintenance_issues maintenance_issues_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_issues
    ADD CONSTRAINT maintenance_issues_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: maintenance_ticket_events maintenance_ticket_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_ticket_events
    ADD CONSTRAINT maintenance_ticket_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: maintenance_ticket_events maintenance_ticket_events_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_ticket_events
    ADD CONSTRAINT maintenance_ticket_events_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.maintenance_tickets(id) ON DELETE CASCADE;


--
-- Name: maintenance_ticket_photos maintenance_ticket_photos_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_ticket_photos
    ADD CONSTRAINT maintenance_ticket_photos_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.maintenance_tickets(id) ON DELETE CASCADE;


--
-- Name: maintenance_ticket_photos maintenance_ticket_photos_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_ticket_photos
    ADD CONSTRAINT maintenance_ticket_photos_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: maintenance_tickets maintenance_tickets_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tickets
    ADD CONSTRAINT maintenance_tickets_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: maintenance_tickets maintenance_tickets_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tickets
    ADD CONSTRAINT maintenance_tickets_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: maintenance_tickets maintenance_tickets_reported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tickets
    ADD CONSTRAINT maintenance_tickets_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: maintenance_tickets maintenance_tickets_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tickets
    ADD CONSTRAINT maintenance_tickets_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id) ON DELETE SET NULL;


--
-- Name: maintenance_tickets maintenance_tickets_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tickets
    ADD CONSTRAINT maintenance_tickets_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: maintenance_tickets maintenance_tickets_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_tickets
    ADD CONSTRAINT maintenance_tickets_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE SET NULL;


--
-- Name: marketing_consent_log marketing_consent_log_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_consent_log
    ADD CONSTRAINT marketing_consent_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.profiles(id);


--
-- Name: marketing_consent_log marketing_consent_log_guest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_consent_log
    ADD CONSTRAINT marketing_consent_log_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES public.guests(id) ON DELETE CASCADE;


--
-- Name: marketing_consent_log marketing_consent_log_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_consent_log
    ADD CONSTRAINT marketing_consent_log_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: messages messages_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: messages messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: night_audit_runs night_audit_runs_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.night_audit_runs
    ADD CONSTRAINT night_audit_runs_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: night_audit_runs night_audit_runs_ran_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.night_audit_runs
    ADD CONSTRAINT night_audit_runs_ran_by_fkey FOREIGN KEY (ran_by) REFERENCES public.profiles(id);


--
-- Name: notifications notifications_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: payments payments_folio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_folio_id_fkey FOREIGN KEY (folio_id) REFERENCES public.folios(id);


--
-- Name: payments payments_invoice_id_invoices_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_invoice_id_invoices_id_fk FOREIGN KEY (invoice_id) REFERENCES public.invoices(id);


--
-- Name: payments payments_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: payments payments_received_by_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_received_by_profiles_id_fk FOREIGN KEY (received_by) REFERENCES public.profiles(id);


--
-- Name: payments payments_reservation_id_reservations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_reservation_id_reservations_id_fk FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: pending_bookings pending_bookings_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_bookings
    ADD CONSTRAINT pending_bookings_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: pending_bookings pending_bookings_rate_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_bookings
    ADD CONSTRAINT pending_bookings_rate_plan_id_fkey FOREIGN KEY (rate_plan_id) REFERENCES public.rate_plans(id);


--
-- Name: pending_bookings pending_bookings_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_bookings
    ADD CONSTRAINT pending_bookings_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id);


--
-- Name: pending_bookings pending_bookings_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_bookings
    ADD CONSTRAINT pending_bookings_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id);


--
-- Name: pricing_rules pricing_rules_applies_to_rate_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules
    ADD CONSTRAINT pricing_rules_applies_to_rate_plan_id_fkey FOREIGN KEY (applies_to_rate_plan_id) REFERENCES public.rate_plans(id);


--
-- Name: pricing_rules pricing_rules_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules
    ADD CONSTRAINT pricing_rules_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: rate_calendar rate_calendar_rate_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_calendar
    ADD CONSTRAINT rate_calendar_rate_plan_id_fkey FOREIGN KEY (rate_plan_id) REFERENCES public.rate_plans(id) ON DELETE CASCADE;


--
-- Name: rate_plans rate_plans_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_plans
    ADD CONSTRAINT rate_plans_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: reservation_co_guests reservation_co_guests_guest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_co_guests
    ADD CONSTRAINT reservation_co_guests_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES public.guests(id);


--
-- Name: reservation_co_guests reservation_co_guests_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_co_guests
    ADD CONSTRAINT reservation_co_guests_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.reservations(id) ON DELETE CASCADE;


--
-- Name: reservation_room_swap_history reservation_room_swap_history_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_room_swap_history
    ADD CONSTRAINT reservation_room_swap_history_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: reservation_room_swap_history reservation_room_swap_history_from_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_room_swap_history
    ADD CONSTRAINT reservation_room_swap_history_from_room_id_fkey FOREIGN KEY (from_room_id) REFERENCES public.rooms(id);


--
-- Name: reservation_room_swap_history reservation_room_swap_history_reservation_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_room_swap_history
    ADD CONSTRAINT reservation_room_swap_history_reservation_room_id_fkey FOREIGN KEY (reservation_room_id) REFERENCES public.reservation_rooms(id) ON DELETE CASCADE;


--
-- Name: reservation_room_swap_history reservation_room_swap_history_to_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_room_swap_history
    ADD CONSTRAINT reservation_room_swap_history_to_room_id_fkey FOREIGN KEY (to_room_id) REFERENCES public.rooms(id);


--
-- Name: reservation_rooms reservation_rooms_checked_in_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_rooms
    ADD CONSTRAINT reservation_rooms_checked_in_by_fkey FOREIGN KEY (checked_in_by) REFERENCES public.profiles(id);


--
-- Name: reservation_rooms reservation_rooms_checked_out_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_rooms
    ADD CONSTRAINT reservation_rooms_checked_out_by_fkey FOREIGN KEY (checked_out_by) REFERENCES public.profiles(id);


--
-- Name: reservation_rooms reservation_rooms_guest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_rooms
    ADD CONSTRAINT reservation_rooms_guest_id_fkey FOREIGN KEY (guest_id) REFERENCES public.guests(id);


--
-- Name: reservation_rooms reservation_rooms_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_rooms
    ADD CONSTRAINT reservation_rooms_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id);


--
-- Name: reservation_rooms reservation_rooms_reservation_id_reservations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_rooms
    ADD CONSTRAINT reservation_rooms_reservation_id_reservations_id_fk FOREIGN KEY (reservation_id) REFERENCES public.reservations(id) ON DELETE CASCADE;


--
-- Name: reservation_rooms reservation_rooms_room_id_rooms_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_rooms
    ADD CONSTRAINT reservation_rooms_room_id_rooms_id_fk FOREIGN KEY (room_id) REFERENCES public.rooms(id);


--
-- Name: reservation_rooms reservation_rooms_swapped_from_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservation_rooms
    ADD CONSTRAINT reservation_rooms_swapped_from_room_id_fkey FOREIGN KEY (swapped_from_room_id) REFERENCES public.rooms(id);


--
-- Name: reservations reservations_checked_in_by_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_checked_in_by_profiles_id_fk FOREIGN KEY (checked_in_by) REFERENCES public.profiles(id);


--
-- Name: reservations reservations_checked_out_by_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_checked_out_by_profiles_id_fk FOREIGN KEY (checked_out_by) REFERENCES public.profiles(id);


--
-- Name: reservations reservations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: reservations reservations_created_by_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_created_by_profiles_id_fk FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: reservations reservations_group_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_group_block_id_fkey FOREIGN KEY (group_block_id) REFERENCES public.group_blocks(id);


--
-- Name: reservations reservations_guest_id_guests_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_guest_id_guests_id_fk FOREIGN KEY (guest_id) REFERENCES public.guests(id);


--
-- Name: reservations reservations_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: reservations reservations_rate_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reservations
    ADD CONSTRAINT reservations_rate_plan_id_fkey FOREIGN KEY (rate_plan_id) REFERENCES public.rate_plans(id);


--
-- Name: role_permissions role_permissions_permission_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES public.permissions(key) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: room_amenities room_amenities_amenity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_amenities
    ADD CONSTRAINT room_amenities_amenity_id_fkey FOREIGN KEY (amenity_id) REFERENCES public.amenities(id) ON DELETE CASCADE;


--
-- Name: room_amenities room_amenities_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_amenities
    ADD CONSTRAINT room_amenities_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: room_images room_images_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_images
    ADD CONSTRAINT room_images_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: room_images room_images_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.room_images
    ADD CONSTRAINT room_images_room_id_fkey FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE;


--
-- Name: rooms rooms_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rooms
    ADD CONSTRAINT rooms_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: seasons seasons_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT seasons_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id);


--
-- Name: user_permission_overrides user_permission_overrides_permission_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT user_permission_overrides_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES public.permissions(key) ON DELETE CASCADE;


--
-- Name: user_permission_overrides user_permission_overrides_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT user_permission_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE RESTRICT;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: activity_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

--
-- Name: additional_charges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.additional_charges ENABLE ROW LEVEL SECURITY;

--
-- Name: amenities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.amenities ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_engine_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_engine_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: companies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

--
-- Name: dpdp_deletions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dpdp_deletions ENABLE ROW LEVEL SECURITY;

--
-- Name: dpdp_exports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dpdp_exports ENABLE ROW LEVEL SECURITY;

--
-- Name: folio_charges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.folio_charges ENABLE ROW LEVEL SECURITY;

--
-- Name: folios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.folios ENABLE ROW LEVEL SECURITY;

--
-- Name: group_block_rooms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_block_rooms ENABLE ROW LEVEL SECURITY;

--
-- Name: group_blocks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.group_blocks ENABLE ROW LEVEL SECURITY;

--
-- Name: gst_returns_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gst_returns_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: guest_follow_ups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guest_follow_ups ENABLE ROW LEVEL SECURITY;

--
-- Name: guest_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guest_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: guest_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guest_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: guests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.guests ENABLE ROW LEVEL SECURITY;

--
-- Name: housekeeping_task_steps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.housekeeping_task_steps ENABLE ROW LEVEL SECURITY;

--
-- Name: housekeeping_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.housekeeping_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: idempotency_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: invoice_line_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;

--
-- Name: invoices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

--
-- Name: maintenance_ticket_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.maintenance_ticket_events ENABLE ROW LEVEL SECURITY;

--
-- Name: maintenance_ticket_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.maintenance_ticket_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: maintenance_tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.maintenance_tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_consent_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketing_consent_log ENABLE ROW LEVEL SECURITY;

--
-- Name: message_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: night_audit_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.night_audit_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: otps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.otps ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: pending_bookings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pending_bookings ENABLE ROW LEVEL SECURITY;

--
-- Name: permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: pricing_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pricing_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: properties; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;

--
-- Name: rate_calendar; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rate_calendar ENABLE ROW LEVEL SECURITY;

--
-- Name: rate_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rate_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: reservation_rooms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reservation_rooms ENABLE ROW LEVEL SECURITY;

--
-- Name: reservations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: room_amenities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_amenities ENABLE ROW LEVEL SECURITY;

--
-- Name: room_images; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_images ENABLE ROW LEVEL SECURITY;

--
-- Name: room_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.room_types ENABLE ROW LEVEL SECURITY;

--
-- Name: rooms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

--
-- Name: schema_migrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: seasons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;

--
-- Name: settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

--
-- Name: user_permission_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_permission_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


