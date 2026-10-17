// GENERATED — do not edit by hand.
// Source of truth: migrations/*.sql. Regenerate: npm run migrations:embed.
// The Worker applies pending migrations at first request (src/bootstrap.ts);
// test/migrations.test.ts fails the suite if this copy goes stale.
//
// Migrations recorded in d1_migrations keep wrangler and the vitest plugin
// interoperable — same table, same names, same statement split.

export interface EmbeddedMigration {
  readonly name: string;
  readonly queries: readonly string[];
}

export const MIGRATIONS: readonly EmbeddedMigration[] = [
  {
    "name": "0001_events.sql",
    "queries": [
      "-- EPISODIC: immutable metadata, enforced by triggers (only the purge path may UPDATE)\nCREATE TABLE events (\n  id TEXT PRIMARY KEY,            -- ulid\n  ts INTEGER NOT NULL,            -- unix ms, event time\n  ingested_at INTEGER NOT NULL,\n  source TEXT NOT NULL,           -- opencode|file|github|manual\n  actor TEXT NOT NULL,            -- user|assistant|tool|external   ← authorship\n  trust REAL NOT NULL,            -- user 1.0, assistant 0.9, tool 0.7, external 0.4\n  session_id TEXT,\n  kind TEXT NOT NULL,             -- message|tool_call|file_edit|decision|note|purge_tombstone\n  privacy TEXT NOT NULL DEFAULT 'normal',  -- normal|sensitive|restricted\n  importance REAL NOT NULL DEFAULT 0.5,\n  excerpt TEXT,                   -- redacted, ≤500 chars; feeds FTS5 (raw payload never indexed);\n                                  -- NULL after purge\n  content_hmac TEXT NOT NULL,     -- HMAC(signing secret, redacted payload); keyed dedupe/integrity. Secret = CONTENT_HMAC_KEY when set, else KEK-derived\n  redacted INTEGER NOT NULL DEFAULT 0\n)",
      "CREATE INDEX idx_events_session ON events(session_id, ts)",
      "CREATE INDEX idx_events_ts ON events(ts)",
      "CREATE INDEX idx_events_session_hmac ON events(session_id, content_hmac)",
      "-- Immutability: everything frozen except the one purge transition (redacted 0→1, excerpt nulled)\nCREATE TRIGGER events_no_update BEFORE UPDATE ON events\nWHEN NOT (NEW.redacted = 1 AND OLD.redacted = 0\n          AND NEW.id IS OLD.id AND NEW.ts IS OLD.ts AND NEW.ingested_at IS OLD.ingested_at\n          AND NEW.source IS OLD.source AND NEW.actor IS OLD.actor AND NEW.trust IS OLD.trust\n          AND NEW.session_id IS OLD.session_id AND NEW.kind IS OLD.kind\n          AND NEW.privacy IS OLD.privacy AND NEW.importance IS OLD.importance\n          AND NEW.content_hmac IS OLD.content_hmac\n          AND (NEW.excerpt IS NULL OR NEW.excerpt IS OLD.excerpt))\nBEGIN SELECT RAISE(ABORT, 'events is append-only'); END",
      "CREATE TRIGGER events_no_delete BEFORE DELETE ON events\nBEGIN SELECT RAISE(ABORT, 'events is append-only'); END",
      "-- Per-event data key: purge = DELETE this row + R2 object (crypto-shred), then write a tombstone event\nCREATE TABLE event_keys (\n  event_id TEXT PRIMARY KEY REFERENCES events(id),\n  wrapped_key TEXT NOT NULL,      -- payload key wrapped by PAYLOAD_KEK\n  created_at INTEGER NOT NULL\n)",
      "-- FTS5 over redacted excerpts only (external-content; INSERT trigger, purge deletes manually)\nCREATE VIRTUAL TABLE events_fts USING fts5(excerpt, content='events', content_rowid='rowid')",
      "CREATE TRIGGER events_fts_insert AFTER INSERT ON events\nBEGIN INSERT INTO events_fts(rowid, excerpt) VALUES (NEW.rowid, NEW.excerpt); END"
    ]
  },
  {
    "name": "0002_semantic.sql",
    "queries": [
      "-- TEMPORAL GRAPH (entities/aliases/edges precede facts so FK targets exist)\nCREATE TABLE entities (\n  id TEXT PRIMARY KEY,\n  type TEXT NOT NULL,             -- Person|Project|Service|Database|Tool|Goal|Preference|Event|Document\n  name TEXT NOT NULL,\n  norm_name TEXT NOT NULL,\n  summary TEXT, first_seen_at INTEGER, last_seen_at INTEGER,\n  UNIQUE(type, norm_name)         -- same-named entities of different types allowed\n)",
      "CREATE TABLE entity_aliases (\n  entity_id TEXT NOT NULL REFERENCES entities(id),\n  alias TEXT NOT NULL,\n  norm_alias TEXT NOT NULL,\n  PRIMARY KEY(entity_id, norm_alias)\n)",
      "CREATE TABLE edges (\n  id TEXT PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL,\n  rel TEXT NOT NULL,              -- uses|maintains|prefers|works_on|depends_on|decided|learned|dislikes|supersedes\n  confidence REAL NOT NULL DEFAULT 0.5,\n  valid_at INTEGER, invalid_at INTEGER,\n  expires_at INTEGER, expired_at INTEGER,\n  learned_at INTEGER NOT NULL,\n  source_event_id TEXT NOT NULL\n)",
      "CREATE INDEX idx_edges_src ON edges(src, rel, invalid_at)",
      "-- SEMANTIC: bi-temporal; supersession never deletion; hard purge nulls object_text\nCREATE TABLE facts (\n  id TEXT PRIMARY KEY,\n  subject_id TEXT NOT NULL REFERENCES entities(id),\n  predicate TEXT NOT NULL,        -- uses|prefers|works_on|decided|lives_in|...\n  object_text TEXT,               -- NULLed by hard purge (forgotten)\n  object_entity_id TEXT REFERENCES entities(id),\n  fact_kind TEXT NOT NULL,        -- user_stated|observed|inferred|temporary|guess\n  confidence REAL NOT NULL,\n  status TEXT NOT NULL DEFAULT 'active',  -- active|superseded|disputed|archived|deleted\n  valid_at INTEGER,               -- when it became true\n  invalid_at INTEGER,             -- when it stopped being true (world changed)\n  expires_at INTEGER,             -- for `temporary` facts: when it is expected to lapse\n  expired_at INTEGER,             -- when the system retired the belief\n  learned_at INTEGER NOT NULL,    -- when we learned it\n  first_seen_at INTEGER, last_confirmed_at INTEGER,\n  sensitivity TEXT NOT NULL DEFAULT 'normal',\n  source_event_id TEXT NOT NULL REFERENCES events(id),\n  superseded_by TEXT REFERENCES facts(id),\n  embedding_model TEXT NOT NULL,  -- 'gemini-embedding' | 'bge-base-en-v1.5'\n  vec_id TEXT\n)",
      "CREATE INDEX idx_facts_active ON facts(status, subject_id, predicate)",
      "CREATE TABLE fact_sources (fact_id TEXT, event_id TEXT, PRIMARY KEY(fact_id, event_id))",
      "CREATE VIRTUAL TABLE facts_fts USING fts5(object_text, content='facts', content_rowid='rowid')",
      "-- PROCEDURAL (never promoted from `external`-origin evidence)\nCREATE TABLE procedures (\n  id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version INTEGER NOT NULL DEFAULT 0,\n  status TEXT NOT NULL DEFAULT 'draft',    -- draft|approved|deprecated\n  origin_trust REAL NOT NULL DEFAULT 0,\n  last_success_at INTEGER, created_at INTEGER NOT NULL\n)",
      "CREATE TABLE procedure_versions (\n  id TEXT PRIMARY KEY, procedure_id TEXT NOT NULL, version INTEGER NOT NULL,\n  trigger TEXT, steps TEXT NOT NULL,        -- JSON array\n  tools TEXT, success_criteria TEXT, failure_notes TEXT,\n  promoted_from_events TEXT, created_at INTEGER NOT NULL, UNIQUE(procedure_id, version)\n)"
    ]
  },
  {
    "name": "0003_reflective.sql",
    "queries": [
      "-- REFLECTIVE\nCREATE TABLE reflections (\n  id TEXT PRIMARY KEY, period TEXT NOT NULL,   -- week|month\n  period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,\n  text TEXT NOT NULL, created_at INTEGER NOT NULL\n)",
      "CREATE TABLE reflection_sources (reflection_id TEXT, fact_id TEXT, event_id TEXT)",
      "-- WORKING (small, always-fetched blocks; writes require ADMIN)\nCREATE TABLE blocks (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    ]
  },
  {
    "name": "0004_safety.sql",
    "queries": [
      "-- PROPOSALS: MCP propose-* land here; auto/manual tier decided at creation (v1.2 amendment 2)\nCREATE TABLE proposals (\n  id TEXT PRIMARY KEY,\n  kind TEXT NOT NULL,             -- correction|forget|block_edit|procedure|dispute\n  payload_json TEXT NOT NULL,\n  target_type TEXT, target_id TEXT,\n  evidence_event_id TEXT REFERENCES events(id),\n  sensitivity TEXT NOT NULL DEFAULT 'normal',\n  review_mode TEXT NOT NULL,      -- auto|manual (computed from tier rules at creation)\n  status TEXT NOT NULL DEFAULT 'pending',  -- pending|applied|discarded|expired\n  created_at INTEGER NOT NULL,\n  expires_at INTEGER NOT NULL,    -- created + 14 days\n  applied_at INTEGER, applied_by TEXT, undone_at INTEGER\n)",
      "-- Confirmation tokens for irreversible admin actions (single-use, 5-min, never via MCP)\nCREATE TABLE confirm_tokens (\n  token TEXT PRIMARY KEY, target TEXT NOT NULL,\n  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER\n)",
      "-- Flooding controls (v1.2 amendment 5): per-token caps + global budget + breaker\nCREATE TABLE rate_budgets (\n  scope TEXT NOT NULL,            -- MCP_READ|MCP_PROPOSE|ADMIN|__global__\n  day TEXT NOT NULL,              -- YYYY-MM-DD (UTC)\n  rows_written INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY(scope, day)\n)"
    ]
  },
  {
    "name": "0005_audit.sql",
    "queries": [
      "-- AUDIT / OPS\nCREATE TABLE audit_log (\n  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL,  -- user|agent|system\n  action TEXT NOT NULL,               -- create|correct|supersede|purge|approve|export|undo\n  target_type TEXT NOT NULL, target_id TEXT NOT NULL,\n  before_json TEXT, after_json TEXT, reason TEXT\n)",
      "CREATE TABLE consolidation_runs (\n  id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER,\n  new_facts INTEGER, merged INTEGER, superseded INTEGER, conflicts INTEGER, pruned INTEGER,\n  report TEXT\n)"
    ]
  },
  {
    "name": "0006_extractions.sql",
    "queries": [
      "-- EXTRACTION QUEUE (Phase 2): one row per non-restricted, non-redacted event,\n-- tracking the Gemini fact-extraction lifecycle. Restricted events are never\n-- queued (filtered at INSERT..SELECT time); status moves\n-- pending -> running -> done|failed, with attempts<3 retried by the sweep.\nCREATE TABLE extractions (\n  event_id TEXT PRIMARY KEY REFERENCES events(id),\n  status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed\n  attempts INTEGER NOT NULL DEFAULT 0,\n  model TEXT, error TEXT,\n  facts_created INTEGER NOT NULL DEFAULT 0,\n  tokens_in INTEGER NOT NULL DEFAULT 0,\n  tokens_out INTEGER NOT NULL DEFAULT 0,\n  injection_suspected INTEGER NOT NULL DEFAULT 0,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)",
      "CREATE INDEX idx_extractions_status ON extractions(status)"
    ]
  }
];
