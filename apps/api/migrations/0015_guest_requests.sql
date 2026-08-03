-- 0015 — guest_requests: the in-room QR service request gets a real queue.
--
-- Today POST /public/qr/room/:token/request fires a notification, writes a
-- log line and persists NOTHING. A request nobody happens to see is simply
-- gone: no queue, no status, no history, no way to ask "what did room 204
-- want yesterday".
--
-- A guest request is a *guest communication*, not a work order. It carries
-- the guest's own wording, and "towels please" fits neither the housekeeping
-- task nor the maintenance issue model. So it lands in its own table with its
-- own lifecycle (open → acknowledged → done | cancelled), and staff promote
-- it into the real modules in one tap:
--
--   cleaning → housekeeping task    issue → maintenance    amenity → no target
--
-- The conversion is recorded on the request row itself, so "convert" is an
-- UPDATE ... WHERE <link> IS NULL and converting twice cannot mint two work
-- items. The partial uniques below make that a database invariant rather than
-- a route-level promise.
--
-- Three conversion links exist because the two maintenance tables differ in
-- how alive they are:
--   * maintenance_issue_id  → maintenance_issues, the LIVE module (routes/
--     maintenance.ts, pages/MaintenanceDetail.tsx). Use this one.
--   * maintenance_ticket_id → maintenance_tickets, the dormant Phase-2
--     revenue-ops table (zero code references; ticket_number needs a
--     property_counters key that does not exist yet). Reserved.
--   * housekeeping_task_id  → housekeeping_tasks, also currently unread by
--     any route; the live housekeeping surface is the rooms.status board.
--
-- Naming: deliberately NOT the existing "Booking Requests" (/requests), which
-- is QR self-booking holds on `reservations`. Different thing, different page
-- (/guest-requests).
--
-- Tenancy: property_id is NOT NULL + FK and is the leading column of every
-- index here, so the cheap query is also the correctly-scoped one.
--
-- Idempotent: guarded DO blocks + IF NOT EXISTS throughout.

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE guest_request_kind AS ENUM ('cleaning', 'amenity', 'issue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE guest_request_status AS ENUM (
    'open', 'acknowledged', 'done', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

-- reservation_id / guest_id are nullable so the row survives the stay it came
-- from: reservations and guests can be purged (DPDP deletions) without taking
-- the hotel's service history with them. room_id is NOT NULL because a
-- request without a room is meaningless — the QR sticker IS the room.
--
-- completed_at / completed_by stamp BOTH terminal states (done and
-- cancelled); status says which one it was.
CREATE TABLE IF NOT EXISTS guest_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  guest_id uuid REFERENCES guests(id) ON DELETE SET NULL,
  kind guest_request_kind NOT NULL,
  status guest_request_status NOT NULL DEFAULT 'open',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  completed_at timestamptz,
  completed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  housekeeping_task_id uuid REFERENCES housekeeping_tasks(id) ON DELETE SET NULL,
  maintenance_issue_id uuid REFERENCES maintenance_issues(id) ON DELETE SET NULL,
  maintenance_ticket_id uuid REFERENCES maintenance_tickets(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- The queue page: one hotel, filtered by status, newest first.
CREATE INDEX IF NOT EXISTS idx_guest_requests_queue
  ON guest_requests (property_id, status, created_at DESC);

-- The sidebar badge and the default "what needs me now" view. Partial, so it
-- stays small forever no matter how much history accumulates.
CREATE INDEX IF NOT EXISTS idx_guest_requests_open
  ON guest_requests (property_id, created_at DESC)
  WHERE status = 'open';

-- Room timeline (room detail page, housekeeping board drill-in).
CREATE INDEX IF NOT EXISTS idx_guest_requests_room
  ON guest_requests (property_id, room_id, created_at DESC);

-- Stay timeline (reservation detail page).
CREATE INDEX IF NOT EXISTS idx_guest_requests_reservation
  ON guest_requests (property_id, reservation_id, created_at DESC)
  WHERE reservation_id IS NOT NULL;

-- Conversion is one-to-one: a work item belongs to at most one request, so a
-- double-tap that raced past the WHERE ... IS NULL guard fails loudly instead
-- of silently producing a second task.
CREATE UNIQUE INDEX IF NOT EXISTS uq_guest_requests_housekeeping_task
  ON guest_requests (housekeeping_task_id) WHERE housekeeping_task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_guest_requests_maintenance_issue
  ON guest_requests (maintenance_issue_id) WHERE maintenance_issue_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_guest_requests_maintenance_ticket
  ON guest_requests (maintenance_ticket_id) WHERE maintenance_ticket_id IS NOT NULL;
