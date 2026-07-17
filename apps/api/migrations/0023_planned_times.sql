-- Per-reservation planned check-in / check-out times.
--
-- Background: the hotel has policy times (check_in 12:00, check_out
-- 11:00 — see settings table) that drive every display when a
-- reservation doesn't specify its own window. But staff often agrees
-- a specific window with a guest at booking time ("arriving 4 PM,
-- leaving 10 AM the next day"). We need a place to store that so
-- receipts, invoices, and the detail page reflect what was actually
-- promised, not the property default.
--
-- These columns are PLANNED / DISPLAY-only — they do NOT replace
-- `checked_in_at` (set at the desk when the guest physically arrives)
-- or `checked_out_at`. The same rules for billing, GST nights,
-- conflict detection, and same-day re-let continue to key off the
-- date columns. This is purely about communicating expectations.
--
-- Both columns are nullable. Existing reservations stay NULL and the
-- UI falls back to the hotel policy time for those (no backfill
-- needed — that would imply we knew the planned times retroactively,
-- which we don't).

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS planned_check_in_at  timestamptz,
  ADD COLUMN IF NOT EXISTS planned_check_out_at timestamptz;

-- Sanity check: when both ends are set, check_out_at must be after
-- check_in_at. NULL on either side bypasses the constraint so we
-- can save partial info if the form only filled one end.
ALTER TABLE reservations
  ADD CONSTRAINT reservations_planned_window_valid CHECK (
    planned_check_in_at IS NULL
    OR planned_check_out_at IS NULL
    OR planned_check_out_at > planned_check_in_at
  );
