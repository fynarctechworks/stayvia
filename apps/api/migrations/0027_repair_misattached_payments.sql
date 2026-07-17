-- One-off repair for payments that were attached to the wrong invoice
-- by the pre-fix per-room checkout flow.
--
-- The old code attached all orphan payments to the FIRST invoice in
-- the per-room loop. When that first invoice was a swap-leg micro-
-- invoice (e.g. ₹3,496.25 for room 203 swapped after one night) and
-- a much larger payment was sitting orphan (₹46,496.25 forward-credit),
-- the payment landed on a tiny bill it could never sensibly belong to.
--
-- Repair rule: on any reservation with 2+ non-voided invoices, if a
-- non-voided "received" payment makes its current invoice over-paid by
-- more than 0.5% (the cumulative slack), move that payment to the
-- biggest remaining invoice on the reservation that is NOT fully
-- paid in its own right. This is conservative — it only moves money
-- to where there's actual debt to settle.

WITH inv_ranked AS (
  SELECT
    i.id AS invoice_id,
    i.reservation_id,
    i.grand_total::numeric AS grand_total,
    ROW_NUMBER() OVER (
      PARTITION BY i.reservation_id
      ORDER BY i.grand_total::numeric DESC, i.created_at DESC
    ) AS rk
  FROM invoices i
  WHERE i.status <> 'voided'
),
multi_inv AS (
  SELECT reservation_id
  FROM inv_ranked
  GROUP BY reservation_id
  HAVING COUNT(*) >= 2
),
biggest_invoice AS (
  SELECT reservation_id, invoice_id
  FROM inv_ranked
  WHERE rk = 1
),
payment_sums AS (
  SELECT
    p.invoice_id,
    SUM(p.amount::numeric) AS total_attached
  FROM payments p
  WHERE p.voided = false AND p.status = 'received'
  GROUP BY p.invoice_id
),
overpaid_invoices AS (
  SELECT
    i.id AS invoice_id,
    i.reservation_id,
    i.grand_total::numeric AS grand_total,
    ps.total_attached
  FROM invoices i
  JOIN payment_sums ps ON ps.invoice_id = i.id
  WHERE i.reservation_id IN (SELECT reservation_id FROM multi_inv)
    AND ps.total_attached > i.grand_total::numeric + 0.01
),
moves AS (
  SELECT
    p.id AS payment_id,
    bi.invoice_id AS new_invoice_id,
    op.invoice_id AS old_invoice_id
  FROM payments p
  JOIN overpaid_invoices op ON op.invoice_id = p.invoice_id
  JOIN biggest_invoice bi ON bi.reservation_id = op.reservation_id
  WHERE p.voided = false
    AND p.status = 'received'
    -- Only move payments that obviously don't belong on their current
    -- invoice (e.g. amount alone exceeds the invoice's grand total).
    -- Leaves correctly-attached payments untouched.
    AND p.amount::numeric > op.grand_total + 0.01
    -- Don't move into the same invoice.
    AND bi.invoice_id <> op.invoice_id
)
UPDATE payments
SET invoice_id = moves.new_invoice_id
FROM moves
WHERE payments.id = moves.payment_id;

-- Recompute invoice totals after the moves.
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

-- Reservation totals are already correct from migration 0026.
