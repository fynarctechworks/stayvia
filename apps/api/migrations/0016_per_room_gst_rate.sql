-- 0016 — per-room GST slab on reservation_rooms.
--
-- India's hotel GST is slabbed on the ROOM TARIFF PER NIGHT (exempt below
-- ₹1,000, 5% up to ₹7,500, 18% above). The booking path decided that slab once,
-- from the AVERAGE rate across every room on the reservation, and snapshotted
-- the single result onto reservations.gst_rate — which every later path
-- (invoice builder, both checkout branches, the preview, recalc) then applied
-- to every room line.
--
-- On a mixed-rate booking that is the wrong tax on both rooms. One booking of a
-- ₹900 standard + a ₹9,000 suite for 2 nights averages ₹4,950, which lands in
-- the 5% band: the suite's ₹18,000 of tariff is billed at 5% instead of 18%
-- (₹2,340 of output GST under-collected and filed short), and the ₹900 room is
-- billed 5% when it is below the exemption threshold. Neither figure can be
-- corrected afterwards without a credit note.
--
-- reservation_rooms already carries each room's true rate_per_night, so the
-- slab belongs next to it. NULLABLE on purpose:
--   * every existing row keeps NULL and therefore keeps inheriting
--     reservations.gst_rate — no reservation created before this migration
--     changes its tax, and no invoice already issued is re-derived;
--   * new rows carry their own slab, and reservations.gst_rate stays as the
--     headline/fallback rate for the booking.
ALTER TABLE reservation_rooms
  ADD COLUMN IF NOT EXISTS gst_rate numeric(5,2);

COMMENT ON COLUMN reservation_rooms.gst_rate IS
  'GST slab for THIS room''s tariff, derived from its own rate_per_night at booking. NULL = legacy row; fall back to reservations.gst_rate.';
