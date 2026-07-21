-- Mark which additional_charges rows the SYSTEM owns.
--
-- Extending a stay writes two things that only make sense together:
--   1. reservations.check_out_date / num_nights / original_check_out_date
--   2. a "Stay extension rate adjustment" charge holding ONLY the difference
--      between the room's stored rate and the agreed extension rate — the
--      extra night itself is billed on the room line at the stored rate.
--
-- That charge rendered in Additional Charges beside manual lines like
-- "extra bed", with an identical delete button and no warning. Deleting it
-- silently re-prices the extension down to the old room rate — a real
-- under-billing (observed: a night agreed at ₹2,000 quietly reverting to
-- ₹1,700) — while leaving the stay extended, because the dates live on the
-- reservation and are untouched by removing a charge.
--
-- `source` lets the API refuse that deletion and point staff at Undo
-- Extension instead, and lets the undo sweep every extension charge without
-- pattern-matching a human-readable description that is free to change.
--
-- 'manual' = staff-entered, freely editable and deletable (the default, so
-- every existing and future hand-added charge keeps behaving exactly as now).

ALTER TABLE additional_charges
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

-- Backfill the rows the extend route created before this column existed.
-- Safe to match on the description here precisely BECAUSE it is one-time and
-- the historical format is known and fixed; nothing at runtime depends on it.
UPDATE additional_charges
SET source = 'stay_extension'
WHERE source = 'manual'
  AND description LIKE 'Stay extension rate adjustment%';

-- Undo Extension filters by (reservation_id, source).
CREATE INDEX IF NOT EXISTS idx_additional_charges_reservation_source
  ON additional_charges (reservation_id, source);
