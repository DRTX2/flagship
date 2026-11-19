-- Transactional outbox for events published to Hookrelay (flag.created / flag.updated / flag.archived).
-- Rows are written in the same transaction as the flag change, so a committed change always has its
-- event and a rolled-back one never does. A dispatcher delivers them with retries (see hookrelay-notifier.ts).
CREATE TABLE event_outbox (
  id              bigserial PRIMARY KEY,
  event_type      text        NOT NULL,
  payload         jsonb       NOT NULL,
  idempotency_key text        NOT NULL UNIQUE,
  attempts        int         NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  dead_at         timestamptz  -- gave up after too many attempts (e.g. a request Hookrelay will always reject)
);
CREATE INDEX event_outbox_due ON event_outbox (next_attempt_at) WHERE sent_at IS NULL AND dead_at IS NULL;
