-- Track the previous room on an in-place swap.
--
-- In-place swaps (used for 1-night and day-use stays) re-point the
-- existing reservation_rooms row at the new room. That overwrites the
-- original room_id, so the UI has no way to tell the desk "this room
-- was originally 203 — swapped to 204 because of Maintenance".
--
-- Segmented swaps don't have this problem; they leave the closed leg
-- intact and create a new segment row. This column is only populated
-- by the in-place path going forward; historical in-place swaps will
-- be NULL and continue to show "Swapped here" without the from-number.

ALTER TABLE reservation_rooms
  ADD COLUMN IF NOT EXISTS swapped_from_room_id UUID REFERENCES rooms(id);
