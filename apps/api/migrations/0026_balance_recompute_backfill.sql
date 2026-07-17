-- One-off backfill for the reservations.balance_due / advance_paid
-- columns and the invoices.total_paid / balance_due / status columns.
--
-- Background: prior to this migration, several code paths wrote
-- reservations.balance_due = one_invoice.balance_due, which silently
-- zeroed out other invoices' debt on multi-invoice bookings. Forward-
-- credited advances (the "Collected at check-out of SLDT-RES-XXXX"
-- flow) also stayed orphan (invoice_id IS NULL) past invoice issue,
-- so those payments never landed on the bill they were meant for.
--
-- The single source of truth, going forward, is:
--   advance_paid = SUM(payments where reservation_id=R, voided=false, status='received')
--   balance_due  = max(0, grand_total − advance_paid − wallet_credit_applied)
-- Cancelled / no-show / complimentary bookings keep balance_due = 0
-- regardless (those statuses zero the bill at the time of action).
--
-- Invoice columns mirror the same idea, scoped to invoice_id:
--   total_paid  = SUM(payments where invoice_id=I, voided=false, status='received')
--                 + wallet_credit_applied
--   balance_due = max(0, grand_total − total_paid)
--   status      = paid if balance ≤ 0, partial if any paid, else issued

-- Step 1: re-attach any orphan payments to the most-likely correct
-- invoice. Strategy: for each orphan payment on a reservation that
-- HAS one or more invoices, attach the payment to the invoice with
-- the highest grand_total (proxy for "the actual stay invoice", not
-- a swap-leg micro-invoice). If a reservation has only one invoice,
-- this attaches the orphan there.
WITH orphan_targets AS (
  SELECT
    p.id AS payment_id,
    (
      SELECT i.id
      FROM invoices i
      WHERE i.reservation_id = p.reservation_id
        AND i.status <> 'voided'
      ORDER BY i.grand_total::numeric DESC, i.created_at DESC
      LIMIT 1
    ) AS target_invoice_id
  FROM payments p
  WHERE p.invoice_id IS NULL
    AND p.voided = false
    AND p.status = 'received'
)
UPDATE payments
SET invoice_id = ot.target_invoice_id
FROM orphan_targets ot
WHERE payments.id = ot.payment_id
  AND ot.target_invoice_id IS NOT NULL;

-- Step 2: recompute every non-voided invoice's totals from the
-- payments attached to it. Wallet credit on the invoice still counts
-- toward total_paid.
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

-- Step 3: recompute every reservation's advance_paid + balance_due
-- from the payments table, EXCEPT cancelled / no-show. Those keep
-- their intentional zero balance. Complimentary stays use the same
-- formula — they have grand_total = 0 anyway.
WITH reservation_paid AS (
  SELECT
    r.id AS reservation_id,
    COALESCE(SUM(CASE WHEN p.voided = false AND p.status = 'received' THEN p.amount::numeric ELSE 0 END), 0) AS sum_paid
  FROM reservations r
  LEFT JOIN payments p ON p.reservation_id = r.id
  GROUP BY r.id
)
UPDATE reservations
SET
  advance_paid = ROUND(rp.sum_paid, 2),
  balance_due = GREATEST(
    0,
    ROUND(reservations.grand_total::numeric - rp.sum_paid - reservations.wallet_credit_applied::numeric, 2)
  ),
  updated_at = NOW()
FROM reservation_paid rp
WHERE reservations.id = rp.reservation_id
  AND reservations.status NOT IN ('cancelled', 'no_show');
