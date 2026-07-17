-- Per-room attribution for additional_charges. Lets us bill charges
-- on the per-room invoice for the right occupant.
--
-- - room_id NULL = "reservation-wide" charge. Falls onto the combined
--   invoice; if every room got its own per-room invoice, these go
--   onto whichever invoice covers the last-remaining room (so they
--   don't get lost).
-- - room_id NOT NULL = charge for that specific room/occupant. Lands
--   only on that room's invoice.

ALTER TABLE additional_charges
  ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES rooms(id);

CREATE INDEX IF NOT EXISTS idx_additional_charges_room
  ON additional_charges (room_id) WHERE room_id IS NOT NULL;
