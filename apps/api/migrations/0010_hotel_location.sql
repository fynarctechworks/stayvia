-- Adds optional GPS coordinates for the property pin (Settings → Hotel Profile).
-- NUMERIC(9,6) gives ~10 cm precision worldwide and is the standard storage
-- shape for WGS84 lat/lng. NULL means "no precise pin set yet" — the address
-- text is the authoritative location until coordinates are captured.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS hotel_latitude  NUMERIC(9, 6),
  ADD COLUMN IF NOT EXISTS hotel_longitude NUMERIC(9, 6);

-- Defensive sanity bounds. Doesn't catch a typo in the right hemisphere but
-- does stop someone storing 999/-200 by accident.
ALTER TABLE settings
  ADD CONSTRAINT settings_latitude_range  CHECK (hotel_latitude  IS NULL OR (hotel_latitude  BETWEEN -90  AND 90)),
  ADD CONSTRAINT settings_longitude_range CHECK (hotel_longitude IS NULL OR (hotel_longitude BETWEEN -180 AND 180));
