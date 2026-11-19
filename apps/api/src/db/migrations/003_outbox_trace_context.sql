-- W3C trace context of the request that made the change, captured in the same transaction, so the
-- delayed publish to Hookrelay continues that request's trace (e.g. the incident that killed a flag).
ALTER TABLE event_outbox ADD COLUMN trace_context jsonb;
