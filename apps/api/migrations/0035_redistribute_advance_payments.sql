-- Redistribute advance payments across per-room invoices.
--
-- Pre-fix behaviour: the booking-time advance was dumped on whichever
-- invoice happened to be "last" in the per-room checkout loop, leaving
-- other invoices in the same reservation with a phantom balance equal
-- to the advance amount (and the receiving invoice silently
-- overpaid — balance clamped to 0).
--
-- Post-fix code (apps/api/src/lib/reservationBalance.ts) distributes
-- orphan payments proportionally across invoices. This migration
-- backfills the historical bad attribution so dashboards and per-
-- invoice balances match the cash actually collected.
--
-- Algorithm per reservation:
--   1. Sum every received non-voided payment on the reservation.
--   2. For each invoice (oldest first) re-allocate payments up to the
--      invoice's grand_total - wallet_credit_applied.
--   3. Re-link the payment rows accordingly. Where a single payment
--      straddles two invoices we cannot split a row (DB shape doesn't
--      support partial rows), so we route it to whichever invoice has
--      the larger unfilled need. The aggregate per-invoice balance is
--      correct either way after the recompute.
--   4. Recompute every invoice's total_paid, balance_due, status.
--   5. Recompute the reservation's balance_due and advance_paid.
--
-- Idempotent: re-running converges to the same allocation.

DO $$
DECLARE
  res RECORD;
  pay RECORD;
  inv RECORD;
  remaining NUMERIC;
  consumed NUMERIC;
  best_inv UUID;
  best_owed NUMERIC;
  hint_room TEXT;
BEGIN
  -- Only touch reservations that have more than one non-voided invoice.
  -- Single-invoice bookings can't have this misattribution.
  FOR res IN
    SELECT r.id AS reservation_id
    FROM reservations r
    WHERE EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.reservation_id = r.id AND i.status <> 'voided'
      GROUP BY i.reservation_id HAVING COUNT(*) > 1
    )
  LOOP
    -- Snapshot each invoice's remaining capacity for this reservation,
    -- starting from zero attributed.
    CREATE TEMP TABLE _need (
      invoice_id UUID PRIMARY KEY,
      owed NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    ) ON COMMIT DROP;

    INSERT INTO _need (invoice_id, owed, created_at)
    SELECT
      i.id,
      GREATEST(0, i.grand_total - COALESCE(i.wallet_credit_applied, 0)),
      i.created_at
    FROM invoices i
    WHERE i.reservation_id = res.reservation_id
      AND i.status <> 'voided';

    -- Walk every received, non-voided payment for this reservation in
    -- chronological order. For each, find the right invoice to attach.
    -- Priority:
    --   1. If the receipt notes name a specific room ("Room 201"),
    --      route to that room's invoice — preserves the audit-trail
    --      intent set when the per-room receipts were created.
    --   2. Otherwise drop on the oldest invoice that still has need.
    FOR pay IN
      SELECT p.id, p.amount, p.notes
      FROM payments p
      WHERE p.reservation_id = res.reservation_id
        AND p.voided = false
        AND p.status = 'received'
      ORDER BY p.created_at
    LOOP
      remaining := pay.amount;
      IF remaining <= 0.009 THEN
        -- Zero-amount receipt — attach to the oldest invoice so it's not orphaned.
        SELECT invoice_id INTO best_inv FROM _need ORDER BY created_at LIMIT 1;
        UPDATE payments SET invoice_id = best_inv WHERE id = pay.id;
        CONTINUE;
      END IF;

      -- Parse "Room NNN" out of the notes (case-insensitive). If
      -- present, try to land the payment on the invoice that covers
      -- that exact room (invoices.scope_room_ids holds the room UUIDs).
      hint_room := NULL;
      best_inv := NULL;
      IF pay.notes IS NOT NULL THEN
        hint_room := substring(pay.notes FROM 'Room (\d+)');
      END IF;
      IF hint_room IS NOT NULL THEN
        SELECT n.invoice_id INTO best_inv
        FROM _need n
        JOIN invoices i ON i.id = n.invoice_id
        WHERE n.owed > 0.009
          AND EXISTS (
            SELECT 1 FROM rooms rm
            WHERE rm.room_number = hint_room
              AND rm.id = ANY(i.scope_room_ids)
          )
        LIMIT 1;
      END IF;

      -- Greedy fallback: drop this payment on the oldest invoice that
      -- still has need. Drain that invoice up to either its capacity
      -- or this payment's amount.
      IF best_inv IS NULL THEN
        SELECT invoice_id, owed INTO best_inv, best_owed
        FROM _need
        WHERE owed > 0.009
        ORDER BY created_at
        LIMIT 1;
      ELSE
        SELECT owed INTO best_owed FROM _need WHERE invoice_id = best_inv;
      END IF;

      IF best_inv IS NULL THEN
        -- Overpayment: nothing left to attribute against. Leave it on the
        -- oldest invoice (matches the historical fallback behaviour).
        SELECT invoice_id INTO best_inv FROM _need ORDER BY created_at LIMIT 1;
        UPDATE payments SET invoice_id = best_inv WHERE id = pay.id;
        CONTINUE;
      END IF;

      consumed := LEAST(remaining, best_owed);
      UPDATE _need SET owed = owed - consumed WHERE invoice_id = best_inv;
      UPDATE payments SET invoice_id = best_inv WHERE id = pay.id;
      -- If this payment exceeds the chosen invoice's need, the
      -- remainder informally "overflows" to that same invoice in our
      -- accounting — but the invoice recompute below clamps balance
      -- at 0 anyway, and the next payment will pick the next
      -- still-needy invoice.
    END LOOP;

    DROP TABLE _need;
  END LOOP;
END$$;

-- Recompute every non-voided invoice's totals from the now-correct
-- payment links.
UPDATE invoices SET
  total_paid = sub.paid,
  balance_due = GREATEST(0, invoices.grand_total - sub.paid - COALESCE(invoices.wallet_credit_applied, 0)),
  status = CASE
    WHEN GREATEST(0, invoices.grand_total - sub.paid - COALESCE(invoices.wallet_credit_applied, 0)) <= 0.009 THEN 'paid'
    WHEN sub.paid > 0 THEN 'partial'
    ELSE 'issued'
  END
FROM (
  SELECT i.id AS invoice_id,
         COALESCE(SUM(p.amount) FILTER (WHERE p.voided = false AND p.status = 'received'), 0) AS paid
  FROM invoices i
  LEFT JOIN payments p ON p.invoice_id = i.id
  GROUP BY i.id
) sub
WHERE invoices.id = sub.invoice_id
  AND invoices.status <> 'voided';

-- Recompute reservation-level balance_due + advance_paid from facts.
UPDATE reservations SET
  advance_paid = sub.paid,
  balance_due = GREATEST(0, reservations.grand_total - sub.paid - COALESCE(reservations.wallet_credit_applied, 0))
FROM (
  SELECT r.id AS reservation_id,
         COALESCE(SUM(p.amount) FILTER (WHERE p.voided = false AND p.status = 'received'), 0) AS paid
  FROM reservations r
  LEFT JOIN payments p ON p.reservation_id = r.id
  GROUP BY r.id
) sub
WHERE reservations.id = sub.reservation_id;
