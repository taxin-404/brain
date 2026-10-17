-- EPISODIC: immutable metadata, enforced by triggers (only the purge path may UPDATE)
CREATE TABLE events (
  id TEXT PRIMARY KEY,            -- ulid
  ts INTEGER NOT NULL,            -- unix ms, event time
  ingested_at INTEGER NOT NULL,
  source TEXT NOT NULL,           -- opencode|file|github|manual
  actor TEXT NOT NULL,            -- user|assistant|tool|external   ← authorship
  trust REAL NOT NULL,            -- user 1.0, assistant 0.9, tool 0.7, external 0.4
  session_id TEXT,
  kind TEXT NOT NULL,             -- message|tool_call|file_edit|decision|note|purge_tombstone
  privacy TEXT NOT NULL DEFAULT 'normal',  -- normal|sensitive|restricted
  importance REAL NOT NULL DEFAULT 0.5,
  excerpt TEXT,                   -- redacted, ≤500 chars; feeds FTS5 (raw payload never indexed);
                                  -- NULL after purge
  content_hmac TEXT NOT NULL,     -- HMAC(signing secret, redacted payload); keyed dedupe/integrity. Secret = CONTENT_HMAC_KEY when set, else KEK-derived
  redacted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_events_session ON events(session_id, ts);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_session_hmac ON events(session_id, content_hmac);

-- Immutability: everything frozen except the one purge transition (redacted 0→1, excerpt nulled)
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
WHEN NOT (NEW.redacted = 1 AND OLD.redacted = 0
          AND NEW.id IS OLD.id AND NEW.ts IS OLD.ts AND NEW.ingested_at IS OLD.ingested_at
          AND NEW.source IS OLD.source AND NEW.actor IS OLD.actor AND NEW.trust IS OLD.trust
          AND NEW.session_id IS OLD.session_id AND NEW.kind IS OLD.kind
          AND NEW.privacy IS OLD.privacy AND NEW.importance IS OLD.importance
          AND NEW.content_hmac IS OLD.content_hmac
          AND (NEW.excerpt IS NULL OR NEW.excerpt IS OLD.excerpt))
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

-- Per-event data key: purge = DELETE this row + R2 object (crypto-shred), then write a tombstone event
CREATE TABLE event_keys (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  wrapped_key TEXT NOT NULL,      -- payload key wrapped by PAYLOAD_KEK
  created_at INTEGER NOT NULL
);

-- FTS5 over redacted excerpts only (external-content; INSERT trigger, purge deletes manually)
CREATE VIRTUAL TABLE events_fts USING fts5(excerpt, content='events', content_rowid='rowid');
CREATE TRIGGER events_fts_insert AFTER INSERT ON events
BEGIN INSERT INTO events_fts(rowid, excerpt) VALUES (NEW.rowid, NEW.excerpt); END;
