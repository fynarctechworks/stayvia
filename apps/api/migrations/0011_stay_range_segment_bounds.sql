-- Make reservation_rooms.stay_range track SEGMENT bounds.
--
-- stay_range backs the GiST exclusion constraint reservation_rooms_no_overlap,
-- which is what actually prevents double-booking a room. Two defects let it
-- drift out of step with effective_from / effective_to, so the DB guard and
-- the availability API disagreed about which rooms were free.
--
-- 1. TRIGGER SCOPE. trg_reservation_rooms_sync_stay_range fired only
--    `BEFORE INSERT OR UPDATE OF reservation_id`. The mid-stay swap path
--    updates effective_to (not reservation_id), so the trigger never ran and
--    the vacated room's stay_range kept the FULL original window. Meanwhile
--    lib/availability.ts reads COALESCE(effective_to, check_out_date) and
--    correctly reported the room free — so the desk saw it as sellable, and
--    the INSERT then tripped exclusion_violation and surfaced as a raw 500.
--
-- 2. PROPAGATION. reservations_propagate_to_rooms rewrote stay_range for
--    EVERY row of the reservation to the full parent window, ignoring segment
--    bounds entirely. So extending a swapped reservation re-blocked the
--    vacated room for the whole extended stay — and if that room had since
--    been legitimately re-let, the UPDATE itself raised exclusion_violation
--    and the extend 500'd.
--
-- Both functions are CREATE OR REPLACE and the trigger is recreated, so this
-- is safe to re-run.

-- --- 1. Propagation now honours per-row segment bounds ----------------------
CREATE OR REPLACE FUNCTION reservations_propagate_to_rooms() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND (
        NEW.check_in_date IS DISTINCT FROM OLD.check_in_date OR
        NEW.check_out_date IS DISTINCT FROM OLD.check_out_date OR
        NEW.status IS DISTINCT FROM OLD.status
      )) THEN
    UPDATE reservation_rooms rr SET
      -- A segmented row keeps ITS OWN window; only unsegmented rows (both
      -- bounds NULL) follow the parent reservation's dates.
      stay_range = daterange(
        COALESCE(rr.effective_from, NEW.check_in_date),
        GREATEST(
          COALESCE(rr.effective_to, NEW.check_out_date),
          COALESCE(rr.effective_from, NEW.check_in_date) + 1
        ),
        '[)'
      ),
      reservation_status_snapshot = NEW.status
    WHERE rr.reservation_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

-- --- 2. Trigger must also fire when the segment bounds change ---------------
DROP TRIGGER IF EXISTS trg_reservation_rooms_sync_stay_range ON reservation_rooms;

CREATE TRIGGER trg_reservation_rooms_sync_stay_range
  BEFORE INSERT OR UPDATE OF reservation_id, effective_from, effective_to
  ON reservation_rooms
  FOR EACH ROW EXECUTE FUNCTION reservation_rooms_sync_stay_range();

-- --- 3. Backfill rows whose stay_range drifted before this fix --------------
-- Same expression the (unchanged) sync function uses, applied to segmented
-- rows only. Non-segmented rows already match. If any hotel has a genuine
-- overlap on disk this UPDATE will raise exclusion_violation and abort the
-- migration — which is the correct outcome: it means two bookings really do
-- claim one room and that needs a human, not a silent overwrite.
UPDATE reservation_rooms rr
SET stay_range = daterange(
      COALESCE(rr.effective_from, r.check_in_date),
      GREATEST(
        COALESCE(rr.effective_to, r.check_out_date),
        COALESCE(rr.effective_from, r.check_in_date) + 1
      ),
      '[)'
    )
FROM reservations r
WHERE r.id = rr.reservation_id
  AND (rr.effective_from IS NOT NULL OR rr.effective_to IS NOT NULL)
  AND rr.stay_range IS DISTINCT FROM daterange(
      COALESCE(rr.effective_from, r.check_in_date),
      GREATEST(
        COALESCE(rr.effective_to, r.check_out_date),
        COALESCE(rr.effective_from, r.check_in_date) + 1
      ),
      '[)'
    );
