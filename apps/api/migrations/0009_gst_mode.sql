-- GST pricing mode.
--
-- 'exclusive' (legacy default): the rate quoted is the NET price, and GST
--   is added on top. ₹1000 room + 5% = ₹1050 grand total. This is what
--   the system did until this migration.
--
-- 'inclusive': the rate quoted is the GROSS price already including GST.
--   ₹1000 room AT 5% = ₹952.38 net + ₹47.62 GST = ₹1000 grand total.
--
-- We default the property to 'inclusive' per the owner's decision (their
-- hotel quotes round numbers including tax). Existing reservations are
-- NOT recomputed — they keep whatever totals they were created with.
-- Only NEW bookings honour the mode.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS gst_mode text NOT NULL DEFAULT 'inclusive'
  CHECK (gst_mode IN ('exclusive', 'inclusive'));

-- Flip the single existing row to inclusive so we don't sit half-applied.
-- The DEFAULT only kicks in for new rows; this UPDATE covers the row that
-- already exists.
UPDATE settings SET gst_mode = 'inclusive';

-- Per-reservation mode snapshot. Captured at create time so that if the
-- property flips its setting later, recalcs / edits on the old booking
-- keep using its original math. Defaults to 'exclusive' for backfill of
-- every booking that existed before this column existed.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS gst_mode text NOT NULL DEFAULT 'exclusive'
  CHECK (gst_mode IN ('exclusive', 'inclusive'));
