-- Mid-stay room swap support.
--
-- A "swap" closes the current reservation_rooms row at an effective date
-- and inserts a new row pointing at a different physical room for the
-- remainder of the stay. Charges, GST, advance — none of that moves;
-- only the room_id (and housekeeping/status state of the two rooms).
--
-- The two rows are linked by a shared swap_id so reports / activity
-- can show the timeline as one event:
--
--   Row A: 201, effective_from=2026-05-29, effective_to=2026-06-01, swap_id=S
--   Row B: 305, effective_from=2026-06-01, effective_to=2026-06-03, swap_id=S
--
-- effective_from / effective_to NULL = "for the whole stay" — the
-- existing single-row behaviour. No back-fill needed.

ALTER TABLE reservation_rooms
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to   date,
  ADD COLUMN IF NOT EXISTS swap_id        uuid,
  ADD COLUMN IF NOT EXISTS swap_reason    text;

-- Range sanity. NULL on either end is allowed (legacy / whole-stay rows).
ALTER TABLE reservation_rooms
  ADD CONSTRAINT res_rooms_effective_range
  CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to > effective_from);

CREATE INDEX IF NOT EXISTS idx_reservation_rooms_swap
  ON reservation_rooms (swap_id) WHERE swap_id IS NOT NULL;
