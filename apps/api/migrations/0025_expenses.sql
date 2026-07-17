-- Expenses ledger for the property side of the business.
--
-- Background: the existing tables track INFLOWS (reservations,
-- invoices, payments). Owners need a place to record OUTFLOWS so
-- they can answer "what did the property cost us this month?" and
-- "where is the money going?". This is intentionally minimal — a
-- single flat table, no separate vendors table, no double-entry
-- accounting. If/when the property grows into needing a real GL,
-- normalising into vendors + journal entries is the next migration.
--
-- Categories are an enum so reports can group reliably. Subcategory
-- stays free-text so staff can write "water bill" / "plumber call"
-- without admin having to predefine every nuance.
--
-- payment_method is the same enum used by guest payments — keeps
-- the cash/upi/card vocabulary consistent property-wide. Adds
-- 'pending' so a recorded-but-unpaid bill has a place to live.
--
-- attachment_url points at Supabase Storage (mirrors guest KYC
-- storage pattern). NULL when no bill was uploaded.
--
-- Index strategy: most queries filter by date range + category, so
-- a composite index on those is what the dashboard / reports use.

CREATE TYPE expense_category AS ENUM (
  'utilities',
  'repairs_maintenance',
  'supplies',
  'salaries_wages',
  'food_kitchen',
  'marketing',
  'government_compliance',
  'other'
);

CREATE TYPE expense_payment_method AS ENUM (
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'pending'
);

CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  expense_date date NOT NULL,
  category expense_category NOT NULL,
  -- Free-form qualifier ("water", "electricity", "plumber"). NULL
  -- when the category itself is specific enough.
  subcategory text,
  description text NOT NULL,
  amount numeric(10, 2) NOT NULL CHECK (amount >= 0),
  -- Input GST captured for future GST-input-credit reporting. Not
  -- surfaced anywhere yet, but staff can record it so the data is
  -- there when we wire it into the GST report later.
  gst_amount numeric(10, 2) NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
  payment_method expense_payment_method NOT NULL DEFAULT 'cash',
  -- When the bill was actually paid. NULL while payment_method is
  -- 'pending'. Used by KPIs to split "paid this month" from "owed
  -- this month".
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

CREATE INDEX IF NOT EXISTS idx_expenses_date_category
  ON expenses (expense_date DESC, category);

CREATE INDEX IF NOT EXISTS idx_expenses_property_date
  ON expenses (property_id, expense_date DESC);

-- Partial index for the "pending bills" list — bills recorded but
-- not yet paid. Keeps the index small (most expenses are paid at
-- the time of recording) while making the pending view instant.
CREATE INDEX IF NOT EXISTS idx_expenses_pending
  ON expenses (expense_date DESC)
  WHERE payment_method = 'pending';

-- Register the new permission keys in the catalogue table FIRST so
-- the role_permissions inserts below don't FK-fail. There IS a
-- permissions table (added in migration 0013) and role_permissions
-- has a FK against it; the code-managed seed in
-- apps/api/src/lib/permissions.ts is what runs at app startup, not
-- migration time.
INSERT INTO permissions (key, area, label, description) VALUES
  ('view_expenses',   'Expenses', 'View expenses',
   'See the property expenses ledger and per-category totals.'),
  ('manage_expenses', 'Expenses', 'Record / edit / delete expenses',
   'Create new expense rows, edit existing ones, and remove them.')
ON CONFLICT (key) DO NOTHING;

-- Permission grants. The 'admin' system role is hardcoded to god-
-- mode in apps/api/src/lib/permissions.ts (it gets "*"), so no
-- explicit grant is needed there. Other senior roles (owner,
-- manager, accountant) get the view permission so the owner can
-- see overheads on the dashboard; manage stays behind manual
-- assignment so cashiers can't be promoted accidentally.

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM roles r
CROSS JOIN (VALUES ('view_expenses')) AS p(key)
WHERE r.key IN ('owner', 'manager', 'accountant')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM roles r
CROSS JOIN (VALUES ('manage_expenses')) AS p(key)
WHERE r.key IN ('manager', 'accountant')
ON CONFLICT DO NOTHING;
