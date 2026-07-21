-- Indexes for the three hottest lookups on the money path.
--
-- These are SHARED multi-tenant tables, so a sequential scan costs in
-- platform-wide row count, not per-hotel — the bill grows for every hotel each
-- time a new one is onboarded.
--
--   additional_charges: 13 query sites filter on reservation_id, but the table
--     carried exactly one index (a partial on room_id). reservation_id is also
--     declared ON DELETE CASCADE, and Postgres does NOT auto-index FK columns,
--     so deleting a reservation seq-scanned the child table too.
--
--   invoice_line_items: 10 query sites filter on invoice_id; the table had no
--     index at all beyond its primary key. Every invoice/receipt PDF render
--     scanned the whole table.
--
--   invoices: indexed on (property_id, created_at) but not reservation_id,
--     which recomputeReservationBalance hits on every check-in, check-out,
--     add-charge and recorded payment.
--
-- CREATE INDEX (not CONCURRENTLY): the migration runner wraps each file in a
-- transaction, and CONCURRENTLY cannot run inside one. These tables are small
-- at current scale, so the brief lock is acceptable; revisit if that changes.

CREATE INDEX IF NOT EXISTS idx_additional_charges_reservation
  ON additional_charges (reservation_id);

CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice
  ON invoice_line_items (invoice_id);

CREATE INDEX IF NOT EXISTS idx_invoices_reservation
  ON invoices (reservation_id);
