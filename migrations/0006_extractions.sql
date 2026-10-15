-- EXTRACTION QUEUE (Phase 2): one row per non-restricted, non-redacted event,
-- tracking the Gemini fact-extraction lifecycle. Restricted events are never
-- queued (filtered at INSERT..SELECT time); status moves
-- pending -> running -> done|failed, with attempts<3 retried by the sweep.
CREATE TABLE extractions (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  model TEXT, error TEXT,
  facts_created INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  injection_suspected INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_extractions_status ON extractions(status);
