-- Extra-bed (additional-person) charges.
--
-- A room sleeps room.max_occupancy people by default. When a group is
-- larger than the selected rooms can hold, the desk can add extra beds
-- to a room — each extra person raises that room's effective capacity
-- by one and adds a per-night fee. The fee is configured per room type
-- (extra_person_rate); the actual count + the rate snapshot are stored
-- per reservation_rooms row so the invoice/receipt can recompute the
-- bill exactly as it was at booking time even if the type's rate later
-- changes.
--
-- GST: the extra-bed amount is part of the room tariff and is taxed in
-- the same slab as the room (handled in application code, not here).

ALTER TABLE room_types
  ADD COLUMN IF NOT EXISTS extra_person_rate NUMERIC(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE reservation_rooms
  ADD COLUMN IF NOT EXISTS extra_beds INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_bed_rate NUMERIC(10, 2) NOT NULL DEFAULT 0;
