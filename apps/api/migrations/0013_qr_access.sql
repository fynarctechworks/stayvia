-- 0013 — QR access: per-room stickers + hotel master QR + self-booking holds.
--
-- rooms.qr_token / properties.qr_token: permanent opaque tokens behind the
-- printed QR codes. Random 32-hex, DB-generated on insert so every code path
-- (routes, seeds, provisioning) gets one without knowing about the feature.
--
-- reservations.hold_expires_at: QR self-bookings arrive as status='hold'
-- (deliberately non-blocking) and must die if the front desk never confirms.
-- The API sweeps expired holds to 'cancelled'.
--
-- reservations.created_by becomes nullable: a guest self-booking has no staff
-- author. Every staff-created row still stamps it.
--
-- settings.qr_unlock_radius_m: advisory geofence radius for the in-room QR
-- unlock. Distance is logged, never used to hard-block (GPS is spoofable and
-- indoor accuracy is worse than a hotel's footprint).

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS qr_token text;
UPDATE rooms SET qr_token = encode(gen_random_bytes(16), 'hex') WHERE qr_token IS NULL;
ALTER TABLE rooms ALTER COLUMN qr_token SET NOT NULL;
ALTER TABLE rooms ALTER COLUMN qr_token SET DEFAULT encode(gen_random_bytes(16), 'hex');
CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_qr_token ON rooms (qr_token);

ALTER TABLE properties ADD COLUMN IF NOT EXISTS qr_token text;
UPDATE properties SET qr_token = encode(gen_random_bytes(16), 'hex') WHERE qr_token IS NULL;
ALTER TABLE properties ALTER COLUMN qr_token SET NOT NULL;
ALTER TABLE properties ALTER COLUMN qr_token SET DEFAULT encode(gen_random_bytes(16), 'hex');
CREATE UNIQUE INDEX IF NOT EXISTS uq_properties_qr_token ON properties (qr_token);

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_reservations_hold_expiry
  ON reservations (hold_expires_at)
  WHERE hold_expires_at IS NOT NULL;

ALTER TABLE reservations ALTER COLUMN created_by DROP NOT NULL;

ALTER TABLE settings ADD COLUMN IF NOT EXISTS qr_unlock_radius_m integer NOT NULL DEFAULT 100;
