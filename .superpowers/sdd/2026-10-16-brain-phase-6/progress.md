# Phase 6 (reach) — ledger

Branch `phase-6` from `master` @ 2434bd0 (Phase 5 closed + accepted 2026-10-16).
Discipline: tests-first per task (watch RED); unpiped `npx vitest run` +
`npx tsc --noEmit` before every commit; one commit per task (plan boxes in the
same commit); rulings appended here; hub mirror `docs/superpowers/plans/` after
plan edits. No new model calls, secrets, or migrations this phase.

## Pinned at plan time (see docs/plans/2026-10-16-brain-phase-6.md)

- Connector: POST /v1/connectors/github/sync ADMIN; ≤10 repos, lookback ≤720h,
  ≤50/repo; deterministic ids `gh-{owner}_{name}-c-{sha12}`; actor external
  (trust 0.4); source github; ingestEvents ADMIN (budget-exempt); per-repo
  errors isolated; no cron, no new vars (optional GITHUB_TOKEN if ever set).
- Export: tables = events, event_keys, entities, entity_aliases, facts,
  fact_sources, edges, blocks, proposals, procedures, procedure_versions,
  reflections, reflection_sources, audit_log; NDJSON header + ≤500-row chunks;
  R2 key exports/{job}.ndjson. Excluded: FTS (rebuilt on restore), extractions/
  consolidation_runs (operational), rate_budgets/confirm_tokens (ephemeral).
- Profiles: backup verbatim (admin only); portable = confirm token
  (target export:portable), payloads decrypted, no event_keys.
- Links: hmac token via contentHmac(CONTENT_HMAC_KEY) + exp, TTL 15 min,
  constant-time compare; object customMetadata.exp; portable deleted after
  first download; both pruned by sweep after exp + 5 min grace (≤100/run).
- Restore: POST /v1/restore ADMIN; INSERT OR REPLACE, columns via PRAGMA
  whitelist; rebuildProjections for FTS; payloads stay encrypted (KEK
  read-side only).
- Inspector: GET /inspector, unauthenticated shell with zero data, token in
  sessionStorage, live sections over read routes.
