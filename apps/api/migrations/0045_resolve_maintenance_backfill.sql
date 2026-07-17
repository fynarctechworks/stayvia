-- Backfill resolve_maintenance for frontdesk + housekeeping.
--
-- The Housekeeping board exposes a "resolve maintenance" action
-- (POST /housekeeping/:roomId/resolve) that clears a room's
-- maintenance flag and returns it to dirty. That route gates on
-- resolve_maintenance — but neither system role was ever seeded with
-- it, even though both already have flag_maintenance. Net effect: a
-- clerk or housekeeper can FLAG a room for maintenance but gets a 403
-- the moment they try to clear it. Same class of gap as the
-- view_maintenance miss fixed in 0044.
--
-- roles.key is globally UNIQUE; role_permissions PK is
-- (role_id, permission_key). ON CONFLICT DO NOTHING keeps this
-- idempotent. The permission key itself already exists in the catalog
-- (seeded in earlier phases), so the FK is satisfied.

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'resolve_maintenance'
FROM roles r
WHERE r.key IN ('frontdesk', 'housekeeping')
ON CONFLICT DO NOTHING;
