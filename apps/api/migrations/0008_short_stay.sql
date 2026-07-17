-- Day-use / short-stay support.
--
-- A short stay is a same-calendar-day booking measured in hours rather
-- than nights (transit guests, after-flight nap rooms, etc). The previous
-- model required check_out > check_in by at least one day; we now keep
-- that constraint ONLY for overnight bookings.
--
-- Columns:
--   reservations.stay_type      enum overnight | short_stay
--   reservations.duration_hours numeric, populated only for short_stay
--   room_types.short_stay_bands jsonb of {label, hours, rate} rows
--
-- The existing check_out > check_in CHECK is relaxed: short_stay rows are
-- allowed to have check_out_date == check_in_date.

-- 1. New columns.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS stay_type text NOT NULL DEFAULT 'overnight'
    CHECK (stay_type IN ('overnight', 'short_stay'));

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS duration_hours numeric(5, 2);

ALTER TABLE room_types
  ADD COLUMN IF NOT EXISTS short_stay_bands jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2. Relax the overnight constraint so same-day check_in/check_out is
-- allowed when stay_type='short_stay'. We drop and re-add the named
-- check constraint from the baseline migration.
ALTER TABLE reservations
  DROP CONSTRAINT IF EXISTS res_checkout_after_checkin;

ALTER TABLE reservations
  ADD CONSTRAINT res_checkout_after_checkin
  CHECK (
    (stay_type = 'short_stay' AND check_out_date >= check_in_date)
    OR (stay_type = 'overnight' AND check_out_date > check_in_date)
  );

-- 3. Index for reports queries filtering by stay_type.
CREATE INDEX IF NOT EXISTS idx_reservations_stay_type
  ON reservations (stay_type);
