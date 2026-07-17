-- Backfill view_maintenance for the frontdesk role.
--
-- The /maintenance/:id page (and the GET maintenance routes) gate on
-- view_maintenance. Migration 0040 granted manage_maintenance to
-- frontdesk and its comment *claimed* "frontdesk already had ...
-- view_maintenance" — but for any deployment whose frontdesk role was
-- seeded before 0013/0032 (or had the key cleared), view_maintenance
-- was never actually present. Result: the desk can flag and manage
-- issues but hitting a room's maintenance history returns the
-- "Access restricted" screen (frontend PermissionGuard any={["view_maintenance"]}).
--
-- roles.key is globally UNIQUE, so this touches the single frontdesk
-- row. role_permissions PK is (role_id, permission_key); ON CONFLICT
-- DO NOTHING keeps this idempotent and re-runnable.

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'view_maintenance'
FROM roles r
WHERE r.key = 'frontdesk'
ON CONFLICT DO NOTHING;
