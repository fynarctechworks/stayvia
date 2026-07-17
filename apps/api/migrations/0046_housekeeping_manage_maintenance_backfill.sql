-- Backfill manage_maintenance for housekeeping.
--
-- The maintenance-issue module's write routes (POST create, PATCH
-- update, comment) all gate on manage_maintenance. The housekeeping
-- role's seed list in permissions.ts already includes it, but existing
-- deployments carry a stale row from the old phase-2 ticketing
-- migration (0013), which seeded the now-defunct create_maintenance key
-- instead. Net effect: housekeeping can view issues but gets a 403
-- trying to create or update one from the maintenance module — even
-- though the "New Issue" button is shown to them.
--
-- This grants the key the seed file already promises. roles.key is
-- globally UNIQUE; role_permissions PK is (role_id, permission_key);
-- ON CONFLICT DO NOTHING keeps it idempotent.
--
-- The defunct create_maintenance key is left in place: it's harmless
-- (no route checks it) and retiring it is a separate cleanup.

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'manage_maintenance'
FROM roles r
WHERE r.key = 'housekeeping'
ON CONFLICT DO NOTHING;
