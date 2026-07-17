-- Relax payments.amount > 0 → amount >= 0.
--
-- Several application flows record a "placeholder" ₹0 receipt to keep
-- the receipt-number sequence and audit trail consistent even when no
-- money was collected:
--   - check-in with no advance ("Check-in — no advance collected")
--   - pre-booking with no advance ("Booking — no advance collected")
--
-- The original 0001_baseline.sql constraint enforced strict > 0, which
-- crashes the API on those code paths. The trail-of-zeroes is a
-- deliberate pattern (every check-in produces a receipt row, even if
-- it's ₹0) — so we tighten the rule to allow zero and keep the
-- "no negative" guarantee.

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payment_amount_positive;

ALTER TABLE payments
  ADD CONSTRAINT payment_amount_nonneg CHECK (amount >= 0);
