-- TEMPORAL GRAPH (entities/aliases/edges precede facts so FK targets exist)
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,             -- Person|Project|Service|Database|Tool|Goal|Preference|Event|Document
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  summary TEXT, first_seen_at INTEGER, last_seen_at INTEGER,
  UNIQUE(type, norm_name)         -- same-named entities of different types allowed
);
CREATE TABLE entity_aliases (
  entity_id TEXT NOT NULL REFERENCES entities(id),
  alias TEXT NOT NULL,
  norm_alias TEXT NOT NULL,
  PRIMARY KEY(entity_id, norm_alias)
);
CREATE TABLE edges (
  id TEXT PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL,
  rel TEXT NOT NULL,              -- uses|maintains|prefers|works_on|depends_on|decided|learned|dislikes|supersedes
  confidence REAL NOT NULL DEFAULT 0.5,
  valid_at INTEGER, invalid_at INTEGER,
  expires_at INTEGER, expired_at INTEGER,
  learned_at INTEGER NOT NULL,
  source_event_id TEXT NOT NULL
);
CREATE INDEX idx_edges_src ON edges(src, rel, invalid_at);

-- SEMANTIC: bi-temporal; supersession never deletion; hard purge nulls object_text
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES entities(id),
  predicate TEXT NOT NULL,        -- uses|prefers|works_on|decided|lives_in|...
  object_text TEXT,               -- NULLed by hard purge (forgotten)
  object_entity_id TEXT REFERENCES entities(id),
  fact_kind TEXT NOT NULL,        -- user_stated|observed|inferred|temporary|guess
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- active|superseded|disputed|archived|deleted
  valid_at INTEGER,               -- when it became true
  invalid_at INTEGER,             -- when it stopped being true (world changed)
  expires_at INTEGER,             -- for `temporary` facts: when it is expected to lapse
  expired_at INTEGER,             -- when the system retired the belief
  learned_at INTEGER NOT NULL,    -- when we learned it
  first_seen_at INTEGER, last_confirmed_at INTEGER,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  source_event_id TEXT NOT NULL REFERENCES events(id),
  superseded_by TEXT REFERENCES facts(id),
  embedding_model TEXT NOT NULL,  -- 'gemini-embedding' | 'bge-base-en-v1.5'
  vec_id TEXT
);
CREATE INDEX idx_facts_active ON facts(status, subject_id, predicate);

CREATE TABLE fact_sources (fact_id TEXT, event_id TEXT, PRIMARY KEY(fact_id, event_id));
CREATE VIRTUAL TABLE facts_fts USING fts5(object_text, content='facts', content_rowid='rowid');

-- PROCEDURAL (never promoted from `external`-origin evidence)
CREATE TABLE procedures (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, current_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',    -- draft|approved|deprecated
  origin_trust REAL NOT NULL DEFAULT 0,
  last_success_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE procedure_versions (
  id TEXT PRIMARY KEY, procedure_id TEXT NOT NULL, version INTEGER NOT NULL,
  trigger TEXT, steps TEXT NOT NULL,        -- JSON array
  tools TEXT, success_criteria TEXT, failure_notes TEXT,
  promoted_from_events TEXT, created_at INTEGER NOT NULL, UNIQUE(procedure_id, version)
);
