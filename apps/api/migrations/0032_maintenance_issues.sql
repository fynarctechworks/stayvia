-- Maintenance issue tracking. Replaces the implicit "notes field +
-- room.status = maintenance" pattern with a proper issue ledger so
-- staff can see history, route work, and report on chronic problems.
--
-- One issue = one reported problem. Multiple issues can be open on
-- the same room (e.g. AC + leaking tap at the same time). The room's
-- status is independent: setting room.status = 'maintenance' is a
-- separate decision the admin makes when the issue is severe enough
-- to take the room out of service.

CREATE TABLE IF NOT EXISTS maintenance_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES properties(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,

  category TEXT NOT NULL CHECK (category IN (
    'electrical', 'plumbing', 'ac_hvac', 'furniture', 'fixtures',
    'appliances', 'cleanliness', 'safety', 'structural', 'other'
  )),
  severity TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN (
    'low', 'normal', 'urgent'
  )),
  title TEXT NOT NULL,
  description TEXT,

  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'in_progress', 'resolved', 'cancelled'
  )),

  reported_by UUID NOT NULL REFERENCES profiles(id),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_to UUID REFERENCES profiles(id),
  resolved_by UUID REFERENCES profiles(id),
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,

  cost_estimate NUMERIC(10, 2),
  cost_actual NUMERIC(10, 2),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maint_room_reported
  ON maintenance_issues (room_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_maint_status_severity
  ON maintenance_issues (status, severity)
  WHERE status IN ('open', 'in_progress');

CREATE TABLE IF NOT EXISTS maintenance_issue_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES maintenance_issues(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES profiles(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maint_comments_issue
  ON maintenance_issue_comments (issue_id, created_at);

INSERT INTO permissions (key, area, label, description) VALUES
  ('view_maintenance', 'Maintenance', 'View maintenance issues', 'Read the maintenance issue list and per-room history.'),
  ('manage_maintenance', 'Maintenance', 'Manage maintenance issues', 'Create, assign, comment on, and update maintenance issues.')
ON CONFLICT (key) DO NOTHING;
