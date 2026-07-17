-- Gender on guests + co-guest support on reservations.
--
-- Rules from product:
--   - numAdults = 1 → 1 KYC required (the booker)
--   - numAdults >= 2 → 2 KYC blocks required (capped at 2)
--   - Additional adults beyond 2 don't need their own KYC, but the
--     first 2 do.
--
-- Implementation:
--   - guests.gender — nullable enum-as-text so old rows don't break.
--     Required at the API layer for NEW guest records.
--   - reservation_co_guests — link table from a reservation to its
--     non-booker occupant(s). Each row references a real Guest row
--     so the co-guest is reusable across bookings (Aadhaar → guest
--     identity stays canonical).

ALTER TABLE guests
  ADD COLUMN IF NOT EXISTS gender text;

ALTER TABLE guests
  ADD CONSTRAINT guests_gender_check
  CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'prefer_not_to_say'));

CREATE TABLE IF NOT EXISTS reservation_co_guests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id   uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  guest_id         uuid NOT NULL REFERENCES guests(id),
  position         smallint NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, guest_id),
  UNIQUE (reservation_id, position)
);

CREATE INDEX IF NOT EXISTS idx_reservation_co_guests_reservation
  ON reservation_co_guests (reservation_id);
CREATE INDEX IF NOT EXISTS idx_reservation_co_guests_guest
  ON reservation_co_guests (guest_id);
