-- Make reservation_rooms.stay_range honour per-row segment bounds.
--
-- Migration 0011 introduced stay_range + a trigger that derived it
-- from the parent reservation's check_in / check_out dates. Migration
-- 0019 added per-row segment columns (effective_from / effective_to)
-- for mid-stay room swaps, but the trigger was never updated, so a
-- closed-leg row (e.g. room 303 covering only 03-04 Jun) still had
-- stay_range = [03 Jun, 08 Jun) — the full reservation window.
--
-- Consequence: the reservation_rooms_no_overlap exclusion constraint
-- treated room 303 as booked for the entire parent stay, blocking
-- any new in-place / segmented swap into that room for dates the
-- closed leg no longer actually covers. The runtime availability
-- probe (isRoomAvailable) had been updated for segments, so the UI
-- listed the room as free, the API approved the swap, and then the
-- DB rejected the insert and crashed the request.
--
-- Fix: derive stay_range from COALESCE(effective_from, check_in_date)
-- to COALESCE(effective_to, check_out_date). For unsegmented rows
-- (both NULLs) this is identical to the old behaviour. For segmented
-- rows the range now matches the segment, lining up the trigger with
-- the runtime probe and unblocking legitimate swaps.
--
-- Also backfill every existing row so historical data lines up.

CREATE OR REPLACE FUNCTION reservation_rooms_sync_stay_range()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

-- Explicit backfill that mirrors the new function's logic. Doing it
-- inline (rather than relying on the trigger) means we don't depend
-- on the trigger's WHEN clause to fire on a no-op UPDATE.
UPDATE reservation_rooms rr
SET stay_range = daterange(
  COALESCE(rr.effective_from, res.check_in_date),
  CASE
    WHEN COALESCE(rr.effective_to, res.check_out_date) <= COALESCE(rr.effective_from, res.check_in_date)
      THEN COALESCE(rr.effective_from, res.check_in_date) + 1
    ELSE COALESCE(rr.effective_to, res.check_out_date)
  END,
  '[)'
)
FROM reservations res
WHERE res.id = rr.reservation_id;
