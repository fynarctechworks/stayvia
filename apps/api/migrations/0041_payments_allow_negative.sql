-- Allow refund rows on payments by relaxing amount >= 0 to amount IS NOT NULL.
--
-- The cancel-reservation flow records refunds as a single payment row
-- with a negative amount (so the per-reservation sum of payments
-- reconciles to "what the property actually still owes / has
-- received"). The 0016 constraint enforced amount >= 0 which made
-- sense before refunds existed; the cancel flow added late June 2026
-- crashes against it.
--
-- The new constraint just keeps NULL out — we still don't want
-- "missing amount" rows in the ledger. Sign is now meaningful:
-- positive = money in, negative = money out (refund).

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payment_amount_nonneg;

-- Idempotent add: some environments already created this constraint by
-- hand before the migration was authored, which made a bare ADD
-- CONSTRAINT collide ("already exists") and abort the whole batch.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_amount_not_null'
      AND conrelid = 'payments'::regclass
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payment_amount_not_null CHECK (amount IS NOT NULL);
  END IF;
END $$;
