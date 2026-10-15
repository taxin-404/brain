# Brain — Phase 6 (reach) plan

> Branch `phase-6` from `master` @ `2434bd0` (Phase 5 closed, merged, accepted,
> CI green). Same discipline as phases 0–5: tests-first per task (watch RED),
> one commit per task with its plan boxes ticked in the same commit, gate =
> unpiped `npx vitest run` + `npx tsc --noEmit` before every commit, ledger
> rulings in `.superpowers/sdd/2026-10-16-brain-phase-6/`. Free-tier: no new
> model calls anywhere in this phase; live acceptance single-shot.

## Context

Design §8 Phase 6: **"GitHub connector, inspector UI, export profiles
(backup/portable), clean-account restore test. Done when: Connector syncs; a
`backup` export restores a working brain on a fresh account using only the
escrowed KEK."**

Spec anchors that pin the behavior:
- §3 (amendments): `backup` = encrypted payloads + wrapped keys, readable only
  with the KEK ("a leaked link exposes nothing"), admin token suffices;
  `portable` = decrypted, admin token **+ confirmation token**, short-lived
  link, **auto-delete from R2 after download** (enforced TTL fallback), audit
  row; **chunked NDJSON job → R2 → short-TTL signed link**.
- §5: `GET /v1/export?profile=backup|portable` (admin).
- §4: events carry `source` (already includes `github`), actor trust table
  (user 1.0 / assistant 0.9 / tool 0.7 / external 0.4); D1 native `.export`
  excludes virtual tables — our export reads content tables only; FTS is
  rebuilt on restore (`rebuildProjections` exists).
- §10: raw evidence is per-event key-wrapped; losing the KEK = brain and
  backups unrecoverable; restore must work with the KEK alone.
- §11: `export` is **not** an MCP tool (REST admin only).

## Pinned decisions (Phase 6)

1. **GitHub connector.** `POST /v1/connectors/github/sync` (ADMIN) with body
   `{repos: ["owner/name", …], lookback_hours?, max_per_repo?, now?}`.
   Caps: ≤10 repos, lookback ≤ 720 h (default 48), max_per_repo ≤ 50
   (default 30). Fetches `GET https://api.github.com/repos/{repo}/commits`
   (`since`, `per_page`; optional `GITHUB_TOKEN` secret upgrades rate limits —
   never required). Maps commits to events: **deterministic id
   `gh-{owner}_{name}-c-{sha12}`** (charset-safe, ≤64) → idempotent re-sync
   through `ingestEvents` (ADMIN scope, budget-exempt); `actor: "external"`
   (trust 0.4 — GitHub is a third-party surface; injection boundary stays),
   `source: "github"`, `session_id: gh:{repo}`, excerpt `{repo}: {first line}`,
   payload `{repo, sha, message, author, url, committed_at}`. Report: per-repo
   `{fetched, stored, duplicates}` or `{error}`; a bad repo never fails the
   others; body-shape errors 400. Manual/admin-triggered only (no cron — API
   budget discipline); no new vars/secrets.
2. **Export tables (both profiles):** `events`, `event_keys`, `entities`,
   `entity_aliases`, `facts`, `fact_sources`, `edges`, `blocks`, `proposals`,
   `procedures`, `procedure_versions`, `reflections`, `reflection_sources`,
   `audit_log`. Excluded on purpose (ledgered): FTS virtual tables (rebuilt on
   restore), `extractions`/`consolidation_runs` (operational state),
   `rate_budgets`/`confirm_tokens` (ephemeral). Format: NDJSON — header line
   `{kind:"header", format:"brain-export", version:1, profile, exported_at,
   tables}` then `{table, rows}` chunks (≤500 rows). Object:
   `exports/{job_id}.ndjson` in `BRAIN_RAW`.
3. **Profiles.** `backup` (default): rows verbatim — encrypted payload blobs +
   wrapped keys, admin token only. `portable`: requires `confirm_token`
   (minted for target `export:portable` through the existing
   `POST /v1/confirm/token`, consumed single-use), decrypts event payloads on
   the walk with the KEK and **omits `event_keys`** (nothing wrapped ships).
   Both write an audit row (`action: export`, target `export:{job}`).
4. **Links.** `?token={hmac}&exp={ms}` where hmac =
   `contentHmac(CONTENT_HMAC_KEY, "export:{job}:{exp}")` (HMAC key ≠ KEK, as
   required), constant-time compare; **TTL 15 min** for both profiles; after
   `exp` the download refuses (403). R2 object `customMetadata.exp` = the same
   exp; **portable objects are deleted immediately after the first successful
   download** and otherwise pruned by the sweep once `exp` passed (+5 min
   grace); backup objects prune the same way. Sweep gains
   `pruneExportObjects` (R2 list + delete; ≤100/run).
5. **Restore.** `POST /v1/restore {job}` (ADMIN): reads
   `exports/{job}.ndjson`, `INSERT OR REPLACE` into the allowlisted tables
   (column names validated against `PRAGMA table_info`, unknown keys ignored),
   batched; finishes with `rebuildProjections` (FTS rebuilt from content
   tables — D1 virtual-table export is impossible, by design we re-derive).
   **Restore touches only `PAYLOAD_KEK`-protected data read-side** (payloads
   stay encrypted at rest; the clean-account test decrypts with the KEK to
   prove it). No HMAC verification on restore (fidelity over re-derivation:
   stored `content_hmac` values are kept verbatim).
6. **Inspector.** `GET /inspector` — a single self-contained HTML page
   (vanilla JS, no build step, no data embedded): token input kept in
   `sessionStorage`, then live sections for health, search, procedures,
   reflections via the existing read routes. The shell is unauthenticated
   (it contains zero brain data); every data call demands the bearer token.
   Security headers: `nosniff` + `no-referrer`.
7. **No new migrations, secrets, crons, or model calls.** Vector index is
   derived data and is not exported (re-embedding via the sweep restores
   semantic search after a clean-account restore — ledgered; FTS/keyword
   search works immediately).

## Review Focus (attack these)

- A leaked `backup` link → ciphertext only; R2 object useless without KEK.
- `portable` without confirm token → 403; token single-use; link dies at exp;
  object gone after one download and not before.
- Restore on a wiped DB yields: searchable facts (FTS), working
  `why`/provenance, intact procedures/reflections, and an event payload that
  decrypts with the KEK alone.
- Connector re-sync duplicates nothing (deterministic ids).

### Task 1 — GitHub connector

**Files:** Create `src/connector-github.ts`; modify `src/index.ts`; create
`test/connector-github.test.ts`.

- [ ] **Step 1: Tests** (MSW stubs api.github.com) — commits map to events
  (deterministic id, source/actor/session/excerpt/payload, ts from commit
  date); re-sync of the same response stores 0 new (duplicates); per-repo
  error surfaces without failing others; caps/validation 400s; ADMIN-only.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement** fetch + mapping + route.
- [ ] **Step 4: Gate + commit** — `feat(connector): github activity sync`.

### Task 2 — export (backup) + links

**Files:** Create `src/exporter.ts`; modify `src/index.ts`; create
`test/export.test.ts`.

- [ ] **Step 1: Tests** — backup job writes NDJSON to R2 (header + table
  chunks; payload blobs stay encrypted; `event_keys` present); download with
  a valid link returns the file; tampered/expired token 403; audit row
  present; ADMIN-only; artifact round-trips as parseable NDJSON.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement** walk + R2 put + link + download route.
- [ ] **Step 4: Gate + commit** — `feat(export): backup profile + signed links`.

### Task 3 — portable profile + retention

**Files:** Modify `src/exporter.ts`, `src/sweep.ts`; extend
`test/export.test.ts`.

- [ ] **Step 1: Tests** — portable without confirm token 403; with token:
  payloads decrypted, `event_keys` absent, single-use enforced; download once
  works then the R2 object is **gone**; expired link 403; sweep prunes
  objects past exp (+grace) and keeps fresh ones.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement** profile + delete-after-download + `pruneExportObjects` in the sweep.
- [ ] **Step 4: Gate + commit** — `feat(export): portable profile + retention`.

### Task 4 — restore + clean-account test (done-when core)

**Files:** Modify `src/exporter.ts`, `src/index.ts`; create
`test/eval-restore.test.ts`.

- [ ] **Step 1: Tests** — seed a small brain (events incl. payload, facts,
  block, approved procedure, reflection) → backup export → **wipe every
  content table** (fresh account) → restore → `/v1/search` finds the fact
  (FTS rebuilt), `GET /v1/facts/:id` + `why` work, procedure approved with
  version history, reflection present, and the event payload decrypts using
  **only `PAYLOAD_KEK`**; restore is idempotent (second run = no duplicates).
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement** restore + FTS rebuild.
- [ ] **Step 4: Gate + commit** — `feat(export): restore + clean-account eval`.

### Task 5 — inspector UI

**Files:** Create `src/inspector.ts`; modify `src/index.ts`; create
`test/inspector.test.ts`.

- [ ] **Step 1: Tests** — `GET /inspector` 200 `text/html`, contains the
  token input and fetch calls to existing read routes, contains **no** seeded
  fact text; security headers present.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement** the single-file page + route.
- [ ] **Step 4: Gate + commit** — `feat(inspector): read-only console page`.

### Task 6 — docs + close-out

**Files:** Modify `README.md`; ledger close-out; mirror plan.

- [ ] **Step 1: Full gate** — `npx vitest run` + `npx tsc --noEmit`.
- [ ] **Step 2: README** Phase 6 section (connector, export profiles, links +
  retention, restore + clean-account proof, inspector) + status line.
- [ ] **Step 3: Tick every box; ledger close-out; mirror.**
- [ ] **Step 4: Commit** — `docs: close phase 6 (reach + restore)`.

## Merge + acceptance (closing — one push)

- [ ] Merge `phase-6` → `master`, push; watch the CI build once. No migration.
- [ ] Live acceptance, single-shot each:
      1. `POST /v1/connectors/github/sync` (ADMIN) with `taxin-404/brain`
         lookback 720 h → fetched ≥1, stored, duplicates on second call.
      2. `GET /v1/export?profile=backup` → job + link → download → NDJSON
         header + rows; audit row present.
      3. `GET /v1/export?profile=portable` without token → 403; mint confirm
         token → export → download once → R2 object gone (D1/R2 check).
- [ ] Owner actions (reminder only): Google Cloud budget alert; key rotation
      from the Phase-2 ledger; escrow `.secrets/prod.env` then delete.
