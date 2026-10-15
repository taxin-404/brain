-- AUDIT / OPS
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL,  -- user|agent|system
  action TEXT NOT NULL,               -- create|correct|supersede|purge|approve|export|undo
  target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  before_json TEXT, after_json TEXT, reason TEXT
);
CREATE TABLE consolidation_runs (
  id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER,
  new_facts INTEGER, merged INTEGER, superseded INTEGER, conflicts INTEGER, pruned INTEGER,
  report TEXT
);
