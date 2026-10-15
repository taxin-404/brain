-- REFLECTIVE
CREATE TABLE reflections (
  id TEXT PRIMARY KEY, period TEXT NOT NULL,   -- week|month
  period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
  text TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE reflection_sources (reflection_id TEXT, fact_id TEXT, event_id TEXT);

-- WORKING (small, always-fetched blocks; writes require ADMIN)
CREATE TABLE blocks (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
-- identity · preferences · active_projects · infrastructure · constraints · objective
