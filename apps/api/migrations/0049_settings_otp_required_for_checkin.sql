-- Property-wide OTP policy. When false, New Reservation skips the OTP step
-- entirely (no code sent, no verification modal) and the reservation create
-- is accepted with skipOtp. Defaults to true so existing behaviour (OTP
-- always required) is preserved until an admin turns it off in Settings.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, so re-running is a no-op.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS otp_required_for_checkin boolean NOT NULL DEFAULT true;
