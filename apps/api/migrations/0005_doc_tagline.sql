-- Per-hotel tagline shown under the hotel name on invoices/receipts.
-- Was hardcoded "Hospitality & Stays" in the PDF templates.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS doc_tagline text NOT NULL DEFAULT 'Hospitality & Stays';
