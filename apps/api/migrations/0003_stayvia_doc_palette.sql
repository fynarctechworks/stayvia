-- Align invoice/receipt PDF colours with the Stayvia design system:
-- ink near-black primary + emerald accent, replacing the legacy
-- navy-green + brass palette.
--
-- Only rows still on the OLD defaults are updated - a hotel that
-- customised its document colours keeps them.

ALTER TABLE settings ALTER COLUMN doc_primary_color SET DEFAULT '#171717';
ALTER TABLE settings ALTER COLUMN doc_accent_color SET DEFAULT '#24B47E';

UPDATE settings SET doc_primary_color = '#171717' WHERE doc_primary_color = '#0F3D2E';
UPDATE settings SET doc_accent_color = '#24B47E' WHERE doc_accent_color = '#B08A4A';
