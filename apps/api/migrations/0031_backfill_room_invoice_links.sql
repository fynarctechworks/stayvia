-- Backfill: link reservation_rooms.invoice_id for legacy single-room
-- reservations where the invoice was issued before the per-room
-- linking code existed. The reservation has exactly one non-voided
-- invoice and exactly one reservation_rooms row that's missing the
-- link; pair them up.
--
-- Safe by construction:
--   - only touches rows where invoice_id IS NULL
--   - only acts when the reservation has exactly one non-voided
--     invoice (multi-invoice bookings are skipped; their attribution
--     is already explicit)
--   - only acts when the reservation has exactly one reservation_room
--     (multi-room bookings are skipped)
UPDATE reservation_rooms rr
SET invoice_id = sub.invoice_id
FROM (
  SELECT r.id AS reservation_id,
         (array_agg(i.id))[1] AS invoice_id
  FROM reservations r
  JOIN invoices i ON i.reservation_id = r.id AND i.status <> 'voided'
  WHERE r.id IN (
    SELECT reservation_id FROM reservation_rooms
    WHERE invoice_id IS NULL
    GROUP BY reservation_id
    HAVING COUNT(*) = 1
  )
  GROUP BY r.id
  HAVING COUNT(*) = 1
) sub
WHERE rr.reservation_id = sub.reservation_id
  AND rr.invoice_id IS NULL;
