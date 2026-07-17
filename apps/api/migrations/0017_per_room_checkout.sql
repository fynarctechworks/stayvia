-- Per-room check-in/check-out + per-room invoicing.
--
-- Up to now: one reservation = one stay event. Today: a 3-room booking
-- where 3 different guests stay needs independent check-out timing and
-- separate invoices. This migration adds:
--
--   reservation_rooms.guest_id              — actual occupant of THIS room
--                                              (defaults to the booker, then
--                                              edited room-by-room)
--   reservation_rooms.status                — one of confirmed | checked_in |
--                                              checked_out | cancelled
--   reservation_rooms.checked_in_at/by      — per-room check-in timestamps
--   reservation_rooms.checked_out_at/by     — per-room check-out timestamps
--   reservation_rooms.invoice_id            — when a per-room invoice has
--                                              been issued, links here
--
-- Back-fill rules:
--   guest_id   = parent reservation.guest_id (lead booker stays in
--                every room until staff reassigns)
--   status     = parent reservation.status (one-stay-event reservations
--                still work as before)
--   timestamps = copies of the parent's so existing rows stay accurate
--
-- The parent reservation's status + timestamps become a ROLL-UP of its
-- rooms (handled in application code, not in this migration — we don't
-- want a trigger fighting the existing checkout endpoint).

ALTER TABLE reservation_rooms
  ADD COLUMN IF NOT EXISTS guest_id uuid REFERENCES guests(id),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed','checked_in','checked_out','cancelled')),
  ADD COLUMN IF NOT EXISTS checked_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS checked_in_by uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS checked_out_at timestamptz,
  ADD COLUMN IF NOT EXISTS checked_out_by uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES invoices(id);

-- Back-fill from parent.
UPDATE reservation_rooms rr
SET
  guest_id       = COALESCE(rr.guest_id, r.guest_id),
  status         = COALESCE(
                     -- preserve any explicit per-room status that's
                     -- already set; otherwise inherit parent's. Map
                     -- pre-confirmation states to 'confirmed' since
                     -- the per-room enum doesn't carry inquiry/hold.
                     CASE WHEN rr.status IS NULL OR rr.status = 'confirmed'
                          THEN CASE r.status
                                 WHEN 'checked_in'  THEN 'checked_in'
                                 WHEN 'checked_out' THEN 'checked_out'
                                 WHEN 'cancelled'   THEN 'cancelled'
                                 WHEN 'no_show'     THEN 'cancelled'
                                 ELSE 'confirmed'
                               END
                          ELSE rr.status
                     END,
                     'confirmed'
                   ),
  checked_in_at  = COALESCE(rr.checked_in_at,  r.checked_in_at),
  checked_in_by  = COALESCE(rr.checked_in_by,  r.checked_in_by),
  checked_out_at = COALESCE(rr.checked_out_at, r.checked_out_at),
  checked_out_by = COALESCE(rr.checked_out_by, r.checked_out_by)
FROM reservations r
WHERE r.id = rr.reservation_id;

-- All future inserts default to the booker until staff assigns a real
-- occupant; existing rows are back-filled above so the column is safe
-- to require.
ALTER TABLE reservation_rooms
  ALTER COLUMN guest_id SET NOT NULL;

-- Index for the dashboard's "find rooms occupied by guest X" lookup —
-- comes up in the new per-room invoice rendering.
CREATE INDEX IF NOT EXISTS idx_reservation_rooms_guest
  ON reservation_rooms (guest_id);

-- Index for the per-room status filter on the reservation detail page
-- ("show me rooms still to check out").
CREATE INDEX IF NOT EXISTS idx_reservation_rooms_status
  ON reservation_rooms (reservation_id, status);

-- Invoice scope tag. A reservation that issued per-room invoices will
-- have N rows in invoices, each tagged with which room subset they
-- cover. NULL means "the whole reservation" (legacy / combined).
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'combined'
    CHECK (scope IN ('combined','room','partial')),
  ADD COLUMN IF NOT EXISTS scope_room_ids uuid[];

-- For invoices already issued, leave scope='combined' (the back-fill
-- default). scope_room_ids stays NULL on those.
