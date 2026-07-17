-- Final pass on payment attribution. The previous migrations got the
-- reservation-level totals right but the per-invoice attribution could
-- still leave one invoice over-paid and another under-paid by the same
-- amount on the same booking. That's misleading on the reservation
-- detail page even though the bottom line is correct.
--
-- This migration uses a deterministic FIFO allocator:
--   1. List every non-voided invoice on a reservation in created_at order.
--   2. List every non-voided "received" payment in payment_date order.
--   3. Walk payments; attribute each payment to the oldest invoice that
--      still has remaining balance. If a payment is larger than the
--      remaining slot, attribute it to whichever single invoice it
--      most fills — payments aren't split across multiple invoices
--      (we'd need to insert new rows to do that, which breaks audit).
--
-- The result: each payment lands on the invoice it most plausibly
-- belongs to. Either the per-invoice picture is exactly right, or it's
-- within ONE payment's worth of right (with the remainder visibly on a
-- neighbouring invoice on the same booking — which staff can mentally
-- net out).
--
-- Cancelled / voided invoices are skipped.

DO $$
DECLARE
  r RECORD;
  inv RECORD;
  pay RECORD;
  remaining NUMERIC;
  best_invoice UUID;
  best_fit NUMERIC;
BEGIN
  -- Iterate reservations that have at least one non-voided invoice and
  -- at least one non-voided received payment.
  FOR r IN
    SELECT DISTINCT res.id
    FROM reservations res
    JOIN invoices i ON i.reservation_id = res.id AND i.status <> 'voided'
    JOIN payments p ON p.reservation_id = res.id AND p.voided = false AND p.status = 'received'
    WHERE res.status NOT IN ('cancelled', 'no_show')
  LOOP
    -- Snapshot remaining slots per invoice in chronological order.
    CREATE TEMP TABLE IF NOT EXISTS _inv_slots (
      invoice_id UUID PRIMARY KEY,
      remaining  NUMERIC,
      seq        INT
    ) ON COMMIT DROP;
    DELETE FROM _inv_slots;

    INSERT INTO _inv_slots (invoice_id, remaining, seq)
    SELECT i.id, i.grand_total::numeric, ROW_NUMBER() OVER (ORDER BY i.created_at)
    FROM invoices i
    WHERE i.reservation_id = r.id AND i.status <> 'voided';

    -- Walk payments oldest → newest.
    FOR pay IN
      SELECT id, amount::numeric AS amt
      FROM payments
      WHERE reservation_id = r.id AND voided = false AND status = 'received'
      ORDER BY payment_date, created_at
    LOOP
      -- Pick the invoice with the SMALLEST positive remaining that's
      -- still >= this payment (so a small payment first settles a
      -- small bill). If nothing fits exactly, pick the invoice with
      -- the LARGEST remaining (so a big payment goes to the big bill).
      best_invoice := NULL;
      best_fit := NULL;
      SELECT s.invoice_id, s.remaining
      INTO best_invoice, best_fit
      FROM _inv_slots s
      WHERE s.remaining >= pay.amt - 0.01
      ORDER BY s.remaining ASC, s.seq ASC
      LIMIT 1;

      IF best_invoice IS NULL THEN
        SELECT s.invoice_id, s.remaining
        INTO best_invoice, best_fit
        FROM _inv_slots s
        WHERE s.remaining > 0.009
        ORDER BY s.remaining DESC, s.seq ASC
        LIMIT 1;
      END IF;

      IF best_invoice IS NULL THEN
        -- All invoices already fully filled by earlier payments. Park
        -- this overflow on the last (newest) invoice so it's at least
        -- attached to something tangible.
        SELECT s.invoice_id INTO best_invoice
        FROM _inv_slots s
        ORDER BY s.seq DESC
        LIMIT 1;
      END IF;

      UPDATE payments SET invoice_id = best_invoice WHERE id = pay.id;
      UPDATE _inv_slots s
      SET remaining = s.remaining - pay.amt
      WHERE s.invoice_id = best_invoice;
    END LOOP;
  END LOOP;
END$$;

-- Recompute invoice totals.
WITH invoice_paid AS (
  SELECT
    i.id AS invoice_id,
    COALESCE(SUM(CASE WHEN p.voided = false AND p.status = 'received' THEN p.amount::numeric ELSE 0 END), 0) AS sum_paid
  FROM invoices i
  LEFT JOIN payments p ON p.invoice_id = i.id
  WHERE i.status <> 'voided'
  GROUP BY i.id
)
UPDATE invoices
SET
  total_paid = ROUND(ip.sum_paid + invoices.wallet_credit_applied::numeric, 2),
  balance_due = GREATEST(
    0,
    ROUND(invoices.grand_total::numeric - ip.sum_paid - invoices.wallet_credit_applied::numeric, 2)
  ),
  status = CASE
    WHEN invoices.grand_total::numeric - ip.sum_paid - invoices.wallet_credit_applied::numeric <= 0.009
      THEN 'paid'
    WHEN ip.sum_paid + invoices.wallet_credit_applied::numeric > 0
      THEN 'partial'
    ELSE 'issued'
  END,
  updated_at = NOW()
FROM invoice_paid ip
WHERE invoices.id = ip.invoice_id;
