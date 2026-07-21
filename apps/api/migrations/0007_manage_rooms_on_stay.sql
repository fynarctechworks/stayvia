-- New permission: manage_rooms_on_stay.
--
-- Context: every mutating reservation route used to be gated on the READ key
-- `view_reservations`, so the read-only Hotel Owner and Accountant roles could
-- cancel stays, swap rooms, rewrite nightly rates and zero out revenue. Those
-- routes now carry real write keys (create_reservations, check_in, check_out,
-- cancel_reservations, extend_stay, record_payments, edit_reservations).
--
-- Moving a guest between rooms is normal front-desk work, but it falls inside
-- edit_reservations ("dates, rooms, charges") - the key migration 0006
-- deliberately removed from the front desk as a cash-skim control. Folding
-- room moves into that key would take a routine operation away from the desk;
-- leaving them on a read key would keep the hole open. So the capability gets
-- its own key: room moves yes, rate and date edits no.
--
-- Granted to EVERY frontdesk/manager role row - shared system roles AND
-- hotel-owned copy-on-write forks. Unlike 0006, which REMOVED a capability and
-- so deliberately left forks alone, this ADDS one the desk already exercises
-- today; skipping forks would silently break room swap for any hotel that has
-- customised its front-desk role.
--
-- Idempotent: safe to re-run.

INSERT INTO permissions (key, area, label, description)
VALUES (
  'manage_rooms_on_stay',
  'Reservations',
  'Move guests between rooms (swap / add room)',
  'Swap a guest into a different room, or add a room to an in-progress stay. Does not permit rate or date changes.'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT id, 'manage_rooms_on_stay'
FROM roles
WHERE key IN ('frontdesk', 'manager')
ON CONFLICT (role_id, permission_key) DO NOTHING;
