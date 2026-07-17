-- Offline message queue. Enqueue WhatsApp/email sends while offline; a
-- connectivity-gated drainer delivers them when the desk reconnects.
-- Idempotent.

CREATE TABLE IF NOT EXISTS message_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL CHECK (channel IN ('sms','email')),
  recipient       text NOT NULL,
  payload         text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The drainer polls pending rows whose next_attempt_at has passed, oldest first.
CREATE INDEX IF NOT EXISTS message_outbox_pending_idx
  ON message_outbox (next_attempt_at)
  WHERE status = 'pending';
