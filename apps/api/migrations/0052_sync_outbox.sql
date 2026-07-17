-- Phase 2 sync capture. A generic AFTER INSERT/UPDATE/DELETE trigger records
-- the full post-image of every change on the syncable business tables into
-- sync_outbox, INSIDE the same transaction as the business write. The desk
-- pusher drains this to the cloud replica (one-way, upsert-by-UUID). Idempotent.
--
-- Only the OFFLINE desk runs these triggers (they're created here but the
-- pusher only runs when OFFLINE_MODE is set). Online/cloud never enables the
-- pusher, so the cloud is a passive replica.

-- Monotonic per-device change counter. A single desk is the only writer, so a
-- plain sequence gives a total causal order (the trigger runs in-tx, so a
-- payment's seq always follows its parent reservation's).
CREATE SEQUENCE IF NOT EXISTS sync_change_seq;

CREATE TABLE IF NOT EXISTS sync_outbox (
  change_seq   bigint PRIMARY KEY DEFAULT nextval('sync_change_seq'),
  table_name   text   NOT NULL,
  op           text   NOT NULL CHECK (op IN ('I','U','D')),
  row_id       uuid   NOT NULL,
  -- Full post-image for I/U (upsert on the replica); for D, just the id.
  row_data     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Set by the pusher when the cloud has acked this change.
  pushed_at    timestamptz
);

-- The pusher drains un-pushed rows in change_seq order.
CREATE INDEX IF NOT EXISTS sync_outbox_unpushed_idx
  ON sync_outbox (change_seq)
  WHERE pushed_at IS NULL;

-- Generic capture function. Uses NEW for I/U, OLD for D.
CREATE OR REPLACE FUNCTION sync_capture() RETURNS trigger AS $$
DECLARE
  v_op   text;
  v_id   uuid;
  v_data jsonb;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    v_op := 'D'; v_id := OLD.id; v_data := NULL;
  ELSIF (TG_OP = 'UPDATE') THEN
    v_op := 'U'; v_id := NEW.id; v_data := to_jsonb(NEW);
  ELSE
    v_op := 'I'; v_id := NEW.id; v_data := to_jsonb(NEW);
  END IF;

  INSERT INTO sync_outbox (table_name, op, row_id, row_data)
  VALUES (TG_TABLE_NAME, v_op, v_id, v_data);

  IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

-- Attach to each syncable business table. Reference/config tables (rooms,
-- settings, rbac, message_templates, amenities, properties) are PULLED from
-- cloud, not pushed, so they get no capture trigger. Local-only tables
-- (local_credentials, message_outbox, idempotency_keys, otps, sync_outbox) are
-- never synced.
DO $$
DECLARE
  t text;
  syncable text[] := ARRAY[
    'reservations','reservation_rooms','reservation_co_guests',
    'invoices','payments','guests','guest_ledger',
    'expenses','maintenance_issues','housekeeping_tasks'
  ];
BEGIN
  FOREACH t IN ARRAY syncable LOOP
    -- Only attach if the table exists (housekeeping_tasks etc. are raw-migration
    -- tables that may lag the schema in some environments).
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'sync_capture_'||t, t);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I
           FOR EACH ROW EXECUTE FUNCTION sync_capture()',
        'sync_capture_'||t, t);
    END IF;
  END LOOP;
END $$;
