-- Backfill: turn legacy rooms.notes free-text into real maintenance_issues
-- rows. Before the maintenance module landed, staff used the notes
-- field as an ad-hoc issue tracker. Each non-empty notes value is
-- migrated to a single open issue (category=other, severity=normal)
-- so the per-room maintenance history surfaces it.
--
-- The notes field is cleared afterwards because the new module is now
-- the single source of truth. Reverting would mean reading from the
-- maintenance_issues table — the legacy field has no callers left.
--
-- Reported-by is set to the property's earliest admin profile (whoever
-- created the first reservation typically). This avoids a NULL in the
-- audit trail; the title makes clear it was backfilled, not a real
-- live report.

WITH first_admin AS (
  SELECT id FROM profiles
  WHERE role = 'admin'
  ORDER BY created_at
  LIMIT 1
)
INSERT INTO maintenance_issues
  (room_id, category, severity, title, description, status, reported_by, reported_at)
SELECT
  r.id,
  'other',
  'normal',
  r.notes,
  '(Backfilled from legacy housekeeping notes — original entry pre-dates the maintenance module.)',
  'open',
  (SELECT id FROM first_admin),
  NOW()
FROM rooms r
WHERE r.notes IS NOT NULL
  AND TRIM(r.notes) <> ''
  AND (SELECT id FROM first_admin) IS NOT NULL
  -- Idempotency guard: skip rooms that already have a backfill row.
  AND NOT EXISTS (
    SELECT 1 FROM maintenance_issues mi
    WHERE mi.room_id = r.id
      AND mi.description LIKE '(Backfilled from legacy housekeeping notes%)'
  );

-- Now clear the legacy notes so the housekeeping list doesn't keep
-- displaying it alongside the new issue row. The data lives in the
-- maintenance_issues row (title field) — nothing is lost.
UPDATE rooms
SET notes = NULL, updated_at = NOW()
WHERE notes IS NOT NULL AND TRIM(notes) <> '';
