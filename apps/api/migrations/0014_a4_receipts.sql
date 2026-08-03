-- Receipts print on A4, like invoices.
--
-- doc_receipt_page_size defaulted to A5, so a receipt PDF downloaded or
-- printed from the app came out half-page while the invoice came out A4.
-- Hotels print both on the same office paper, so a mixed size means one of
-- the two is always scaled or wasteful. Standardise on A4.
--
-- Non-destructive: the column, its enum-ish contract (A4/A5/A6/Letter) and
-- every other setting are untouched. A hotel that deliberately wants A5
-- receipts can still set it back; this only moves the default and the rows
-- that were still sitting on that default.

ALTER TABLE settings
  ALTER COLUMN doc_receipt_page_size SET DEFAULT 'A4';

UPDATE settings
SET doc_receipt_page_size = 'A4'
WHERE doc_receipt_page_size = 'A5';
