-- Tighten the DEFAULT front-desk role: remove edit_reservations (dates,
-- rooms, charge edits) - a cash-skim vector the desk shouldn't have out of
-- the box. Applies only to the SHARED system role; hotel-owned forks
-- (copy-on-write customisations) keep whatever the hotel chose.

DELETE FROM role_permissions
WHERE permission_key = 'edit_reservations'
  AND role_id IN (
    SELECT id FROM roles WHERE key = 'frontdesk' AND property_id IS NULL
  );
