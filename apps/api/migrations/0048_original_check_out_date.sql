-- Track the original (first-booked) check-out date so the UI can show an
-- "Extended" marker on reservations whose stay was lengthened.
--
-- The /extend handler stamps this column once, on the first extension, from
-- the then-current check_out_date. NULL = never extended.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the backfill below only fills
-- rows that are still NULL, so re-running is a no-op.

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS original_check_out_date date;

-- Backfill reservations extended BEFORE this column existed. The original
-- check-out lives in the activity log: the FIRST 'reservation_extended'
-- entry's metadata.oldCheckOut holds the date the stay was booked with.
-- Take the earliest such entry per reservation so multi-extend stays get
-- the true original, not an intermediate one.
WITH first_extend AS (
  SELECT DISTINCT ON (entity_id)
         entity_id,
         (metadata ->> 'oldCheckOut')::date AS original_out
  FROM activity_log
  WHERE action = 'reservation_extended'
    AND entity_type = 'reservation'
    AND metadata ->> 'oldCheckOut' IS NOT NULL
  ORDER BY entity_id, created_at ASC
)
UPDATE reservations r
SET original_check_out_date = fe.original_out
FROM first_extend fe
WHERE r.id = fe.entity_id
  AND r.original_check_out_date IS NULL;
