-- Folds the previously-untracked .mjs scripts into the migration history.
-- Idempotent: skips work if the table/column already exists.

ALTER TABLE guests ADD COLUMN IF NOT EXISTS guest_photo TEXT;

CREATE TABLE IF NOT EXISTS guest_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id      uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  entry_type    text NOT NULL CHECK (entry_type IN ('credit_issued','credit_used','cashout','adjustment')),
  amount        numeric(10,2) NOT NULL,
  reservation_id uuid,
  invoice_id    uuid,
  payment_id    uuid,
  note          text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guest_ledger_guest ON guest_ledger(guest_id);
CREATE INDEX IF NOT EXISTS idx_guest_ledger_created ON guest_ledger(created_at);
