-- PROPOSALS: MCP propose-* land here; auto/manual tier decided at creation (v1.2 amendment 2)
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- correction|forget|block_edit|procedure|dispute
  payload_json TEXT NOT NULL,
  target_type TEXT, target_id TEXT,
  evidence_event_id TEXT REFERENCES events(id),
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  review_mode TEXT NOT NULL,      -- auto|manual (computed from tier rules at creation)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|applied|discarded|expired
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,    -- created + 14 days
  applied_at INTEGER, applied_by TEXT, undone_at INTEGER
);

-- Confirmation tokens for irreversible admin actions (single-use, 5-min, never via MCP)
CREATE TABLE confirm_tokens (
  token TEXT PRIMARY KEY, target TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);

-- Flooding controls (v1.2 amendment 5): per-token caps + global budget + breaker
CREATE TABLE rate_budgets (
  scope TEXT NOT NULL,            -- MCP_READ|MCP_PROPOSE|ADMIN|__global__
  day TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  rows_written INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope, day)
);
