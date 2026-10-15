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

Task 4: Ruling (gap found by the eval): `rebuildProjections` rebuilt only `events_fts`; `facts_fts` is manual-insert (factstore) so a restore left keyword fact-search empty. Rebuild now re-derives BOTH external-content indexes; `fts_rows` still counts events only (historical callers assert on it). This is exactly the class of bug the clean-account eval exists to catch.
Task 4: restore mechanics: header must be format brain-export v1; unknown tables ignored (forward compat); rows inserted INSERT OR REPLACE batched 50; columns filtered by /^[a-z_]+$/ AND PRAGMA table_info (schema-drift tolerant); values normalized (boolean→0/1); r2_payloads written back to R2 with a payloads/ prefix guard; rebuildProjections at the end; audit action `restore`. Portable exports refuse with 400 — restore demands backup fidelity (wrapped keys + ciphertext).
Task 4: fresh-account simulation (test): DROP child-before-parent (D1 enforces FKs even for DROP's implicit DELETE) inside one batch with `PRAGMA defer_foreign_keys = true`, then re-apply TEST_MIGRATIONS — structurally identical to a new deployment; R2 payload objects are wiped separately so the restore demonstrably re-puts ciphertext from the NDJSON.
Task 4: gotchas: (a) reflections.text is JSON `ReflectionInsight[]` ({text, fact_ids}) — the latest route parses it, plain strings show as insights:[]; (b) `PRAGMA table_info` + batch for insert plumbing works fine in D1; (c) INSERT OR REPLACE does NOT fire the events append-only DELETE trigger (recursive_triggers is off by default) — restore can rewrite rows safely.
Task 4: done-when evidence: eval asserts search/facts/why/procedure/block/reflection through the real read routes after restore, payload decrypt with PAYLOAD_KEK alone, and idempotent second restore.
Task 4: complete (commits 3ea90ea..1a1374b, tests: npx vitest run →    Duration  32.43s (transform 2.94s, setup 39.08s, import 5.36s, tests 25.10s, environment 4ms))

Task 5: Ruling: the `link` route need is renamed `public` — it now covers two handlers with no bearer auth: the HMAC-signed export download (self-authenticating URL) and the inspector shell (data-free HTML). Exact list is two routes; the index.ts loop short-circuits both identically.
Task 5: inspector is a single template-string page (no build step, no CDN, no external fonts): token field kept in sessionStorage, live sections for health / search / procedures (list + detail) / reflections-latest over the existing read routes. The shell tests assert zero data and zero secrets; headers: nosniff, no-referrer, CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'`, cache-control no-store.
Task 5: gotcha: Handler type returns Promise<Response> — the sync handleInspector needs an `async () =>` wrapper in the route table.
Task 5: complete (commits 57b5d3e..74655c5, tests: npx vitest run →    Duration  32.95s (transform 2.95s, setup 40.38s, import 5.54s, tests 25.01s, environment 1ms))

Task 6: Close-out. Full gate green: 38 files / 225 tests, tsc clean. README gains the Phase 6 section (connector, export profiles, links + retention, restore + clean-account proof, inspector), map/layout/progress rows updated. Hub mirror refreshed. Merge + acceptance boxes stay unticked until the post-merge single-shot acceptance pass. Deferred with reasons: vector index not exported (derived data; re-embed via sweep restores semantic search after restore — FTS/keyword works immediately); portable profiles are not restorable (by design: no wrapped keys; restore demands backup fidelity); export prefixes without meta.json skipped by the sweep (unreachable without a live link); GITHUB_TOKEN not configured in prod (unauthenticated public-repo sync is the baseline).
Task 6: complete (commits fad99b0..be82175, tests: npx vitest run →    Duration  33.35s (transform 3.08s, setup 41.12s, import 5.56s, tests 25.27s, environment 2ms))

Acceptance (first attempt): connector sync green live (fetched 5, stored 5; re-sync 0 stored / 5 duplicates). Backup export FAILED live with CF error 1101 — root cause: Workers Free plan caps subrequests per invocation at 50 external / 1000 to Cloudflare services (2026-02 changelog confirms free stays capped); prod has ~1.33k payload objects so a one-shot walk could never fit. Ruling (Task 7): export/restore become genuinely resumable — meta.json carries {state, cursor, seq}; the admin repeats GET /v1/export?job=… until done:true. Slices are R2 list pages (default 200 objects, ?limit= for tests 1..500). Download of a running job 409s; restore of a non-done job 409s. Portable resume needs no new confirm token (admin bearer + existing meta). Mid-slice crash leaves already-flushed parts; a resumed slice may re-emit lines for objects whose part was flushed but whose cursor update didn't land — duplicate NDJSON lines are tolerated by design (restore is INSERT OR REPLACE + payload re-put; both idempotent). Work continues on master directly (phase-6 already merged; hotfix continuation, one commit per task + ledger).
Task 7: restore gets a restore-state.json sidecar inside the job prefix: {tables_done, payload_index, done, fts_rows}; table inserts once, payload re-puts sliced (default 800, body ?limit= 1..1200), FTS rebuild + audit exactly once on the final call; a completed restore call returns the cached result. Download filters part keys by /\/\d{3}\.ndjson$/ so the sidecars never stream; sweep deletes the whole prefix as before.

Task 7: implementation notes. Export meta.json is now the job state machine: {profile, exp, exported_at, state:"running"|"done", cursor, seq, parts, tables}. Legacy metas (written only at completion, no `state`) normalize to done. Slices are R2 list pages: default 200 objects, `?limit=` (1..500) for tests/ops; each call writes its parts, then meta; resume `GET /v1/export?job=…`. Download of state=running → 409; resume of a done job re-derives the view (fresh link token) with no extra audit. Parts no longer carry customMetadata (nothing ever read it; list never surfaces it locally).
Task 7: restore progress sidecar `exports/{job}/restore-state.json`: {tables_done, restored_tables, payload_index, done, fts_rows}. Table inserts happen exactly once (first call); payload re-puts sliced (default 800, body `limit` ≤1200); FTS rebuild + the single audit row happen on the completing call; after done, calls return the cached result. Restore of a running job 409s. Download filters part keys by /\d{3}\.ndjson$/ so sidecars never stream; the sweep still deletes the whole prefix after exp.
Task 7: crash-window ruling: parts flush BEFORE the meta cursor update, so a crash between the two can leave a resumed slice re-emitting lines for payloads already present in flushed parts. Tolerated by design: restore is INSERT OR REPLACE + idempotent R2 re-put, and the rare duplicate line in an artifact is harmless (the resume test asserts no duplicates in the normal path). Window is two adjacent awaits; accepted over a two-phase commit for data that is a derived snapshot anyway.
Task 7: portable resume needs no new confirm token (admin bearer + existing meta carry the authorization); starting portable still requires a freshly consumed single-use token. Confirm token is consumed only on start, never on resume.
Task 7: complete (commits 1015729..8e39df5, tests: npx vitest run →    Duration  33.08s (transform 2.96s, setup 41.05s, import 5.52s, tests 25.60s, environment 4ms))

Task 8: root cause of the 1102 flake: (a) decryptPayload derived the KEK (SHA-256 + importKey) per object — 100× on a portable page; (b) the table phase stringified ~1 MB in one call. Fixes: `payloadKek` + `decryptPayloadWithKek` (KEK imported once per invocation; decryptPayload delegates so all callers keep working); tables walk in ≤400-row LIMIT/OFFSET slices tracked by {table_index, row_offset} in meta.json with an early return while tables are unfinished; portable payload pages capped at 100 objects (backup keeps the 200 default — it survived live at 200).
Task 8: gotcha: the tables-early-return path MUST flush the buffer before persisting meta — the first cut returned with the header + 400 rows still in memory and the test caught zero event rows in R2. Flush-then-meta is now the fixed order there too.
Task 8: readMeta defaults table_index/row_offset to 0 so T7-era metas stay resumable. Restore still parses whole parts per call (idempotent, retry-safe); prod-scale restore on the free plan may need a retry after a 1102 — correctness is proven by the eval, capacity is acceptable-by-retry. Ledgered rather than slicing the parse.
Task 8: complete (commits 129fe52..1150ab5, tests: npx vitest run →    Duration  33.43s (transform 3.04s, setup 40.81s, import 5.53s, tests 27.32s, environment 7ms))

Task 9: acceptance caught duplicate headers — every call with unfinished tables re-emitted the header (10 headers in the 6.8 MB prod artifact). Fix: `header` flag in meta.json (start=false, set true on the first call that writes it; readMeta defaults legacy metas to true since the old code always wrote it on call one). Test now asserts exactly one header mid-walk and in the finished artifact of the >400-event export.
Task 9: note for the record: pre-fix prod artifacts (and any job resumed across the fix) could carry >1 header; restore tolerates duplicate headers (they only set headerOk), and all such jobs expire in 15 min and are swept.
Task 9: complete (commits 8e45517..5450602, tests: npx vitest run →    Duration  33.31s (transform 2.98s, setup 40.36s, import 5.56s, tests 27.23s, environment 3ms))
