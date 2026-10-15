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

Task 1: Ruling: connector events are actor=external (trust 0.4) — GitHub is a third-party surface; even the owner's own commit text must not cross the user_stated boundary (deterministic, no per-repo trust special-casing). kind stays "note" (no new event kinds); session_id `gh:{repo}` gives the dedupe pair (session_id, content_hmac) a second net behind the deterministic id.
Task 1: Ruling: sync is ADMIN-triggered via POST body (repos list per call) instead of env config: no new vars/secrets, explicit operator intent, free-tier API budget. Optional GITHUB_TOKEN secret (env type optional, NOT in wrangler secrets.required) upgrades rate limits only.
Task 1: gotcha: event ids must match /^[A-Za-z0-9_-]{1,64}$/ — repo slugs with dots/slashes get sanitized (`gh-{slug}-c-{sha12}`); sha truncated to 12.
Task 1: per-repo errors never fail the batch; a fully failed sync returns 502 so the operator sees it, partial success 200 with per-repo error entries.
Task 1: complete (commits ac84e30..700809a, tests: npx vitest run →    Duration  29.18s (transform 3.08s, setup 37.10s, import 5.55s, tests 20.29s, environment 5ms))

Task 2: Ruling: new route need `link` — the export download authenticates via the URL's HMAC-signed exp+token only (no bearer; browsers can't send one on navigation). The index.ts loop short-circuits `link` routes before requireScope and passes a placeholder scope ("MCP_READ"); exactly one route uses it, reviewable in one line.
Task 2: gotcha: R2 `list()` results do NOT surface customMetadata in the local runtime (test caught it). Retention/profile therefore live in an explicit sidecar `exports/{job}/meta.json` {profile, exp, exported_at, parts}; download and the sweep read that, never list metadata.
Task 2: format pinned: parts `exports/{job}/NNN.ndjson`, ~4 MiB per part, line grammar {kind:header,...} then {table,rows:<=500} chunks; payload blobs ride as {table:"r2_payloads", rows:[{key, b64}]}; sort order for download/restore = lexicographic key order (NNN padded).
Task 2: NDJSON round-trip test proves a backup artifact decrypts with the KEK alone (wrapped_key + b64 blob + decryptPayload) — the clean-account contract, later re-asserted post-restore in T4.
Task 2: interim state: profile=portable returns 501 until T3 lands the confirm-token + retention work (no test depended on it in T2).
Task 2: complete (commits 94894ef..266b5a0, tests: npx vitest run →    Duration  30.37s (transform 3.14s, setup 38.27s, import 5.58s, tests 21.32s, environment 8ms))

Task 3: Ruling: portable gate = admin bearer (route need) + `confirm_token` query param on the same GET, consumed via the existing single-use confirm-token machinery (target `export:portable`, 5-min TTL). Token in URL is acceptable here: single-use, 5-minute, admin-bearer also required; ledgered as a conscious trade for browser-navigable GET semantics.
Task 3: portable content rules: `event_keys` is filtered out of the table walk entirely; payload blobs are decrypted during the walk (KEK + wrapped key); orphan blobs and decrypt failures degrade to `text: null` — a portable export never fails over one bad blob.
Task 3: gotcha (test): R2 state is shared across tests in the file; the big-payload test leaves ~4.5MB of payloads in R2, so later exports span multiple parts and multiple `r2_payloads` chunks — assertions must concatenate ALL parts and flatten ALL chunks of a table (no `.find()` on the first chunk).
Task 3: deletion ordering: portable deletes run before writer.close(), so when the client sees EOF the job is already gone from R2 (no post-response race); meta.json is deleted too, hence a second download 404s (link itself would still verify).
Task 3: retention: `pruneExportObjects` prunes a job's whole prefix once `exp` + 5 min grace passed; ≤100 object deletes/run; a prefix without meta.json (crash mid-job) is skipped — unreachable without a link, no exp to trust (ledgered deferral). Called first in runSweep; count logged only when >0; SweepResult left untouched to avoid interface churn.
Task 3: complete (commits 0fb5cfd..8b8438c, tests: npx vitest run →    Duration  31.09s (transform 2.94s, setup 38.69s, import 5.57s, tests 23.31s, environment 4ms))
