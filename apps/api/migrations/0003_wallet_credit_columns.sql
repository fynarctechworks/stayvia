-- Adds wallet_credit_applied columns so we can record wallet credit redeemed
-- as a discount on bookings and invoices. Default 0 keeps existing rows safe.

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS wallet_credit_applied numeric(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS wallet_credit_applied numeric(10, 2) NOT NULL DEFAULT 0;
