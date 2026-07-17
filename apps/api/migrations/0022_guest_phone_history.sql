-- Guest phone history for stable URLs across phone changes.
--
-- Background: /guests/:id resolves either a UUID or a phone. When a
-- guest updates their phone, old shared URLs (Slack, bookmarks)
-- would otherwise 404. This table preserves every phone a guest has
-- ever had so the resolver can fall back to history on a miss.
--
-- Shape:
--   guest_id    — owning guest
--   phone       — the phone (normalised, no spaces/dashes/parens —
--                 matches the resolver's normalisation)
--   valid_from  — when this phone became active
--   valid_to    — when it stopped being active (NULL = still current)
--
-- Invariant: exactly one row per guest with valid_to IS NULL, for
-- guests whose phone has been touched at least once. (The very first
-- INSERT during signup also follows this; see the backfill below.)
--
-- The phone column is NOT unique — two guests may have shared the
-- same number at different times, especially with family phones.
-- The resolver picks the most-recent owner via valid_from DESC.

CREATE TABLE IF NOT EXISTS guest_phone_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  phone text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Lookups: by phone (resolver fallback) and by guest_id (profile page
-- history view if we ever add it). The valid_to partial index makes
-- "current phone for guest X" queries free.
CREATE INDEX IF NOT EXISTS idx_phone_history_phone
  ON guest_phone_history (phone);

CREATE INDEX IF NOT EXISTS idx_phone_history_guest
  ON guest_phone_history (guest_id, valid_from DESC);

CREATE INDEX IF NOT EXISTS idx_phone_history_current
  ON guest_phone_history (guest_id)
  WHERE valid_to IS NULL;

-- Backfill: every existing guest gets one row representing their
-- current phone as the only one we know about. valid_from comes from
-- the guest's created_at so historical reporting lines up. valid_to
-- is NULL because this phone is still current.
INSERT INTO guest_phone_history (guest_id, phone, valid_from, valid_to)
SELECT id, phone, created_at, NULL
FROM guests
WHERE NOT EXISTS (
  SELECT 1 FROM guest_phone_history h WHERE h.guest_id = guests.id
);
