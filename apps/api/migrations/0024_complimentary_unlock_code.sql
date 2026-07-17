-- Soft access gate for the Complimentary report.
--
-- Background: comping a stay is an exception, not routine. Front-desk
-- staff shouldn't accidentally — or casually — comp a room. We don't
-- want a full RBAC overhaul for this single report, so we add a
-- per-property "access code" that the UI prompts for before revealing
-- the Complimentary tab.
--
-- IMPORTANT — this is obscurity-grade, not security-grade:
--   * The code is validated server-side (POST /settings/unlock-
--     complimentary) so it doesn't sit in the JS bundle.
--   * The Complimentary report endpoint itself stays open to anyone
--     with `view_reports`. A determined user who hits the API URL
--     directly will still get the data. This change only blocks the
--     UI reveal.
--
-- The column is nullable. NULL = no gate — older properties / fresh
-- installs default to the legacy behaviour where the toggle just
-- shows/hides the tab without prompting. Setting any non-empty
-- string turns the gate on.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS complimentary_unlock_code text;
