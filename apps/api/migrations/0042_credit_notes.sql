-- Credit notes for reorganising a PAID reservation's invoices.
--
-- When a guest has already paid (e.g. a combined invoice) and later
-- needs a different shape (per-room invoices for their company's GST
-- claim), we cannot void the paid invoice — under GST law a settled tax
-- document is reversed with a CREDIT NOTE, not a void. The original
-- stays valid and on file; the credit note reverses its tax on the
-- return; the new invoices add the sale back. Net GST is unchanged, and
-- there's a clean legal trail.
--
-- Credit notes live in the invoices table (they share ~all columns:
-- hotel/guest snapshot, subtotal, CGST/SGST, line items) and are told
-- apart by document_type. credit_note_for points at the invoice being
-- reversed. They get their own SLDT-CN-#### number sequence.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS document_type text NOT NULL DEFAULT 'invoice';

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_document_type_check;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_document_type_check
  CHECK (document_type IN ('invoice', 'credit_note'));

-- The invoice this credit note reverses (NULL for ordinary invoices).
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS credit_note_for uuid REFERENCES invoices(id);

-- Separate human-facing sequence for credit notes: SLDT-CN-0001, ...
CREATE SEQUENCE IF NOT EXISTS sldt_credit_note_seq START 1;

CREATE INDEX IF NOT EXISTS idx_invoices_credit_note_for
  ON invoices(credit_note_for)
  WHERE credit_note_for IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_document_type
  ON invoices(document_type);
