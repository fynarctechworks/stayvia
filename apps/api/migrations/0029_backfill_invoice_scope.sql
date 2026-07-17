-- Backfill: downgrade invoices.scope from 'combined' to 'room' when
-- the invoice actually covers a single room. The old combined-branch
-- checkout insert left scope to its DB default ('combined') even on
-- single-room bookings, so every 1-room legacy invoice was tagged as
-- combined. The UI now hides the badge based on the reservation's
-- room count, but reports/exports still read scope directly, so
-- normalising the column matches the new write path.
UPDATE invoices
SET scope = 'room', updated_at = NOW()
WHERE scope = 'combined'
  AND (
    array_length(scope_room_ids, 1) <= 1
    OR scope_room_ids IS NULL
  );
