-- Chain of in-place swap hops on a reservation_rooms row.
--
-- Background: 0036 added `swapped_from_room_id` to capture the prior
-- room on an in-place swap. That works for one swap, but a second
-- in-place swap on the same row overwrites the value — so a chain
-- like 202 -> 201 -> 301 was collapsing down to "from 201" and the
-- 202 origin was lost.
--
-- This table preserves every hop. One row per swap event on the
-- holding reservation_rooms row, ordered by `created_at`. Read it
-- whole to reconstruct the ladder; write one new row per swap.
--
-- Scope: only in-place swaps (1-night and day-use) need this. Mid-
-- stay segmented swaps keep using the parent reservation_rooms table
-- — each leg is a real row there. To keep the UI uniform, the API
-- returns this table's contents alongside the active row.

CREATE TABLE IF NOT EXISTS reservation_room_swap_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_room_id UUID NOT NULL REFERENCES reservation_rooms(id) ON DELETE CASCADE,
  from_room_id UUID NOT NULL REFERENCES rooms(id),
  to_room_id UUID NOT NULL REFERENCES rooms(id),
  reason TEXT NOT NULL,
  -- Snapshot the per-night rate that applied to the closed leg, so
  -- the UI can show "₹1500/n" alongside the closed room number even
  -- though the rate has since changed on the active row.
  rate_per_night NUMERIC(10, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_swap_history_rr
  ON reservation_room_swap_history (reservation_room_id, created_at);
