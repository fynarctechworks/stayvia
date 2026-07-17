-- Grant view_daily_collections to the frontdesk role.
--
-- The front desk settles the cash drawer at shift end, so it needs to
-- see TODAY's collections (the dashboard "Collections by Method" cash-up
-- panel + "Revenue Today" tile). A new finer-grained permission —
-- view_daily_collections — unlocks just that, WITHOUT exposing
-- month-to-date revenue or the property-wide outstanding balance, which
-- stay behind view_revenue (management-only).
--
-- role_permissions.permission_key has an FK to permissions.key, so the
-- catalog row must exist BEFORE the grant. Seed it first (mirrors
-- permissions.ts PERMISSION_CATALOG), then grant to frontdesk.
--
-- Both statements use ON CONFLICT DO NOTHING so re-running is a no-op.
-- roles.key is globally UNIQUE; role_permissions PK is
-- (role_id, permission_key).

INSERT INTO permissions (key, area, label, description) VALUES
  ('view_daily_collections', 'Reports', 'View today''s cash-up (daily collections)',
   'See today''s collections (Collections by Method + Revenue Today) to settle the drawer, without month-to-date revenue or outstanding balance.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'view_daily_collections'
FROM roles r
WHERE r.key = 'frontdesk'
ON CONFLICT DO NOTHING;
