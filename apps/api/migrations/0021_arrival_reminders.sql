-- Pre-arrival reminders + no-show watch.
--
-- arrival_reminder_sent_at — set once we WhatsApp the guest their
-- pre-arrival reminder. Prevents double-sending on subsequent
-- dashboard ticks. NULL until the reminder fires; non-NULL means
-- "don't send again."
--
-- The two new property_settings keys configure the windows:
--   arrival_reminder_hours_before  — N hours before check-in we send
--                                    the guest reminder. Default 24.
--   no_show_cutoff_hours           — N hours past hotel check-in time
--                                    after which a confirmed booking
--                                    is flagged "likely no-show".
--                                    Default 6. Staff still has to
--                                    manually mark no-show.

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS arrival_reminder_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_reservations_arrival_reminder
  ON reservations (check_in_date, status)
  WHERE status = 'confirmed' AND arrival_reminder_sent_at IS NULL;

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS arrival_reminder_hours_before integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS no_show_cutoff_hours integer NOT NULL DEFAULT 6;
