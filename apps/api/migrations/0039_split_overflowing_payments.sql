-- Split payments that overflow a single invoice's grand_total across
-- multiple invoices on the same reservation.
--
-- Background: 0035 rewrote per-reservation payment attribution but only
-- assigned each payment row to ONE invoice. When a single advance was
-- larger than the first invoice's grand_total (e.g. ₹5000 advance,
-- ₹2500 Room 201 invoice, then Room 202 and Room 303 unpaid), the
-- spillover stayed on the first invoice as an over-payment instead of
-- flowing to the next invoice. Result: one invoice clamped to balance
-- ₹0 (over-paid by the surplus), other invoices still showed a balance.
--
-- The fix: a payment row can't span two invoices (FK is on the row),
-- so when the source row exceeds the target invoice's need we split
-- it into multiple rows. The original row is reduced to the first
-- invoice's need; new rows are inserted for each spillover slice. Each
-- new row carries a fresh receipt number from the standard sequence
-- and a note pointing back to the source receipt for the audit trail.
-- The reservation's sum of payments stays exactly the same.
--
-- Idempotent: re-running converges to the same allocation. Rows that
-- already match the new allocation are no-ops.

DO $$
DECLARE
  res RECORD;
  pay RECORD;
  inv_row RECORD;
  remaining NUMERIC;
  consumed NUMERIC;
  best_inv UUID;
  best_owed NUMERIC;
  hint_room TEXT;
  slice_count INTEGER;
  slice_index INTEGER;
  base_notes TEXT;
  source_receipt TEXT;
  new_rcp TEXT;
BEGIN
  FOR res IN
    SELECT r.id AS reservation_id
    FROM reservations r
    WHERE EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.reservation_id = r.id AND i.status <> 'voided'
      GROUP BY i.reservation_id HAVING COUNT(*) > 1
    )
  LOOP
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

    -- Walk every received non-voided payment for this reservation in
    -- chronological order. For each payment, allocate across invoices
    -- (splitting rows where needed) so each invoice gets its share.
    FOR pay IN
      SELECT p.id, p.amount, p.notes, p.receipt_number, p.payment_method,
             p.property_id, p.received_by, p.payment_date
      FROM payments p
      WHERE p.reservation_id = res.reservation_id
        AND p.voided = false
        AND p.status = 'received'
      ORDER BY p.created_at, p.id
    LOOP
      remaining := pay.amount;
      base_notes := pay.notes;
      source_receipt := pay.receipt_number;

      IF remaining <= 0.009 THEN
        SELECT invoice_id INTO best_inv FROM _need ORDER BY created_at LIMIT 1;
        IF best_inv IS NOT NULL THEN
          UPDATE payments SET invoice_id = best_inv WHERE id = pay.id;
        END IF;
        CONTINUE;
      END IF;

      hint_room := NULL;
      IF pay.notes IS NOT NULL THEN
        hint_room := substring(pay.notes FROM 'Room (\d+)');
      END IF;

      -- Build the slice list in a temp table so we know slice_count
      -- before we issue any UPDATE/INSERT. Order: hinted invoice first
      -- (when it has unfilled need), then remaining invoices oldest
      -- first.
      CREATE TEMP TABLE _slices (
        seq SERIAL PRIMARY KEY,
        invoice_id UUID NOT NULL,
        amount NUMERIC NOT NULL
      ) ON COMMIT DROP;

      -- Hinted slice.
      IF hint_room IS NOT NULL THEN
        SELECT n.invoice_id, n.owed INTO best_inv, best_owed
        FROM _need n
        JOIN invoices i ON i.id = n.invoice_id
        WHERE n.owed > 0.009
          AND EXISTS (
            SELECT 1 FROM rooms rm
            WHERE rm.room_number = hint_room
              AND rm.id = ANY(i.scope_room_ids)
          )
        LIMIT 1;
        IF best_inv IS NOT NULL THEN
          consumed := LEAST(remaining, best_owed);
          INSERT INTO _slices (invoice_id, amount) VALUES (best_inv, consumed);
          UPDATE _need SET owed = owed - consumed WHERE invoice_id = best_inv;
          remaining := remaining - consumed;
        END IF;
      END IF;

      -- Greedy fill across remaining invoices.
      WHILE remaining > 0.009 LOOP
        SELECT invoice_id, owed INTO best_inv, best_owed
        FROM _need
        WHERE owed > 0.009
        ORDER BY created_at
        LIMIT 1;
        EXIT WHEN best_inv IS NULL;
        consumed := LEAST(remaining, best_owed);
        INSERT INTO _slices (invoice_id, amount) VALUES (best_inv, consumed);
        UPDATE _need SET owed = owed - consumed WHERE invoice_id = best_inv;
        remaining := remaining - consumed;
      END LOOP;

      -- Overflow: every invoice is satisfied but money remains. Park
      -- the remainder on the oldest invoice so the row keeps a home.
      IF remaining > 0.009 THEN
        SELECT invoice_id INTO best_inv FROM _need ORDER BY created_at LIMIT 1;
        INSERT INTO _slices (invoice_id, amount) VALUES (best_inv, remaining);
        remaining := 0;
      END IF;

      SELECT COUNT(*) INTO slice_count FROM _slices;

      IF slice_count = 0 THEN
        DROP TABLE _slices;
        CONTINUE;
      END IF;

      -- First slice updates the source row in place.
      slice_index := 1;
      FOR inv_row IN SELECT invoice_id, amount FROM _slices ORDER BY seq LOOP
        IF slice_index = 1 THEN
          UPDATE payments SET
            invoice_id = inv_row.invoice_id,
            amount = ROUND(inv_row.amount::numeric, 2),
            notes = CASE
              WHEN slice_count = 1 THEN base_notes
              WHEN base_notes IS NULL OR base_notes = '' THEN format('Part 1/%s', slice_count)
              ELSE format('%s · part 1/%s', base_notes, slice_count)
            END
          WHERE id = pay.id;
        ELSE
          new_rcp := 'SLDT-RCP-' || lpad(nextval('sldt_receipt_seq')::text, 4, '0');
          INSERT INTO payments (
            receipt_number, property_id, invoice_id, reservation_id,
            amount, payment_method, status, received_by, payment_date, notes
          ) VALUES (
            new_rcp, pay.property_id, inv_row.invoice_id, res.reservation_id,
            ROUND(inv_row.amount::numeric, 2), pay.payment_method, 'received',
            pay.received_by, pay.payment_date,
            CASE
              WHEN base_notes IS NULL OR base_notes = ''
                THEN format('Part %s/%s (split from %s)', slice_index, slice_count, source_receipt)
              ELSE format('%s · part %s/%s (split from %s)',
                          base_notes, slice_index, slice_count, source_receipt)
            END
          );
        END IF;
        slice_index := slice_index + 1;
      END LOOP;

      DROP TABLE _slices;
    END LOOP;

    DROP TABLE _need;
  END LOOP;
END$$;

-- Recompute every non-voided invoice's totals from the now-split rows.
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
