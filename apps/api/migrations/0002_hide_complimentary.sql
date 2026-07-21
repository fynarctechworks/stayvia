-- Per-hotel toggle for complimentary-booking visibility.
--
-- true  (default) — current behaviour: complimentary bookings are hidden
--                   from the calendar, reservations list, activity feed,
--                   invoices and dashboard alerts; they live only in the
--                   code-gated Complimentary report.
-- false           — complimentary bookings show in the normal operational
--                   views like any other booking. Revenue/report exclusions
--                   are UNAFFECTED: comp money never counts as revenue.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS hide_complimentary boolean NOT NULL DEFAULT true;
