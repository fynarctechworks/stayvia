-- Flips the receipt PDF default from A5 → A4 so the generated PDF matches
-- what staff see in the browser print preview (always A4). Updates the
-- column default for future inserts AND any existing row that still has
-- the old A5 value. Rows where staff has manually picked a different size
-- (e.g. Letter) are left alone.

ALTER TABLE settings
  ALTER COLUMN doc_receipt_page_size SET DEFAULT 'A4';

UPDATE settings
  SET doc_receipt_page_size = 'A4'
  WHERE doc_receipt_page_size = 'A5';
