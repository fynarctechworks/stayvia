-- Emergency RLS lockdown.
--
-- The anon key (VITE_SUPABASE_ANON_KEY) is shipped in the browser
-- bundle. Without RLS, any visitor with the JS bundle could read
-- guests, payments, OTPs, invoices, and every other row directly via
-- the Supabase REST/GraphQL endpoints.
--
-- Enabling RLS without any policy produces a deny-all default for the
-- anon and authenticated roles. The Express API is unaffected because
-- it uses SUPABASE_SERVICE_ROLE_KEY, which is a privileged role that
-- bypasses RLS entirely.
--
-- If we ever need direct browser access to a specific table (we
-- shouldn't — every read should go through the API), add narrowly
-- scoped policies in a follow-up migration. Do NOT broaden these by
-- creating an "allow anon select" policy on any table containing
-- guest data.
--
-- Already applied to production via the Supabase MCP. This file exists
-- so apps/api/scripts/migrate.mjs sees it (the matching entry in
-- schema_migrations was inserted alongside the apply).

ALTER TABLE public.activity_log               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guests                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_rooms          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.additional_charges         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_line_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_types                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_notes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_follow_ups           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.otps                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_templates          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_permission_overrides  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_ledger               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schema_migrations          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys           ENABLE ROW LEVEL SECURITY;
