-- First-time hotels start with the complimentary feature OFF: new settings
-- rows default hide_complimentary = false, so fresh signups see no comp
-- button/booking source/report until they opt in (which then requires a
-- report access code).
--
-- Deliberately NO update of existing rows - hotels that already have the
-- discreet flow (or explicitly chose a value) keep it.

ALTER TABLE settings ALTER COLUMN hide_complimentary SET DEFAULT false;
