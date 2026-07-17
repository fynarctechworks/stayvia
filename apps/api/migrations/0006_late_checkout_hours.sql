-- Adds a queryable late_checkout_hours column to reservations so the
-- dashboard's checkout-alert query can compute the effective checkout
-- time without parsing additional_charges descriptions or activity_log
-- metadata.
--
-- Existing rows default to 0 (no extension).

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS late_checkout_hours numeric(4,2) NOT NULL DEFAULT 0;
