-- Expand the frontdesk role's permissions to cover workflows that
-- were added after the role was seeded.
--
-- Added:
--   manage_maintenance — frontdesk already had flag_maintenance and
--     view_maintenance; the new Maintenance module's POST/PATCH/comment
--     endpoints all gate on manage_maintenance. Without it the desk
--     can flag issues from Housekeeping but can't actually CREATE the
--     issue (the API returned 403). Matches what staff already does
--     in practice.
--
--   reissue_invoices — added for the Consolidate / Split invoice
--     conversion flow. Voiding stays separate (void_invoices remains
--     admin-only); reissue covers the path that voids-as-part-of-
--     reissue. Without this perm the convert-invoices endpoint 403s
--     and the new UI buttons error on click.
--
-- Idempotent: ON CONFLICT DO NOTHING means re-running is a no-op
-- once the rows exist.

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'manage_maintenance'
FROM roles r
WHERE r.key = 'frontdesk'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'reissue_invoices'
FROM roles r
WHERE r.key = 'frontdesk'
ON CONFLICT DO NOTHING;
