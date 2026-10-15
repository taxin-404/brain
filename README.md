# brain

Personal neural memory for OpenCode sessions — capture, redact, encrypt at rest,
search, and recall into future sessions. Runs on Cloudflare Workers (D1 + R2).

**Status: Phase 0 delivered & live · Phase 1 complete · Phase 2 (semantic) complete · Phase 3 (truth) complete** — the
memory layer extracts durable facts through the AI Gateway, blends semantic + keyword
search, lands reviewable proposals, and applies them through a reversible review engine
(supersession + provenance + confirm-gated forgets): 27 test files / 168 tests green
offline (zero network); live acceptance passed 2026-10-15 single-shot post-merge
(evidence in the Phase 3 plan). Capture and MCP
recall are registered globally in
the owner's OpenCode config and proven live end-to-end (owner-approved 2026-10-15; see
`.superpowers/sdd/2026-10-15-brain-phase-0-1/task-14-log.md`).

## ⚠️ Free-tier rules — every agent must read this

This account runs on Cloudflare's free tier (plus a small, capped Gemini budget in
Phase 2). An agent once "tested" a deployed worker with a request loop and burned
the account's daily free request limit in seconds. No exceptions, ever:

- **Never run load, stress, soak, or benchmark tests against deployed workers**
  (`*.workers.dev`). No request loops, no parallel hammering. All tests run
  locally: `npx vitest run` uses real `workerd` with zero network.
- **Prod verification = single-shot requests only.** A few one-off curls are
  fine; a `for` loop against the live URL is not. (Cloudflare's management API
  and Workers Builds endpoints don't consume the worker request quota, but keep
  polling there minimal too.)
- **Quotas to respect:** Workers 100k requests/day · D1 100k row-writes/day (the
  in-app `rate_budgets` breaker at 80k protects this) · Vectorize 5M stored dims ·
  Queues 10k ops/day · Gemini calls under the Google Cloud budget alert (~$5/mo).

## Phase 2 (semantic)

Events are projected into durable **facts**: the `*/30` sweep (and the admin
`POST /v1/extract` kick) sends unprocessed event excerpts to Gemini through the AI
Gateway and stores facts with bi-temporal bookkeeping, entities, and provenance.

- **Models (pinned):** extraction `gemini-3.5-flash-lite`; embeddings
  `gemini-embedding-001` at `outputDimensionality: 768`. Gateway base
  `https://gateway.ai.cloudflare.com/v1/<account>/brain/google-ai-studio`
  (gateway id `brain`).
- **Vectorize:** index `brain-memory` (768 dims, cosine) with metadata indexes on
  `type`/`status`/`sensitivity`; fact vectors are upserted at the end of each
  extraction run (vector id = fact id).
- **Caps & privacy:** sweep `{maxEvents: 40, maxCalls: 4}`; manual kick
  `{maxEvents: 100, maxCalls: 10}`; retries stop after 3 attempts;
  `privacy='restricted'` events are never queued or sent; restricted fact
  candidates are stored redacted (`object_text='[REDACTED]'`).
- **Search:** `GET /v1/search` returns `results` (keyword, unchanged) **and**
  `facts` — a blended RRF of Vectorize top-20 and FTS5 top-20 with recency +
  confidence modifiers (`degraded: true` when embeddings are unavailable).
  `GET /v1/facts/:id` serves a fact with its source events.
- **Proposals:** the MCP server now exposes 8 tools; `propose_correction` /
  `propose_forget` / `propose_block_edit` / `propose_procedure` land reviewable
  `proposals` rows (auto tier only for user-evidenced, non-sensitive corrections;
  everything else manual). `GET /v1/proposals` lists them; pending proposals
  expire after 14 days.
- **Evals:** `test/eval-semantic.test.ts` gates paraphrased recall@5 ≥ 0.9 offline
  through a deterministic fake-embedding oracle; `npm run eval:live` is the
  owner-run live check — `--q "…"` (top-5 facts), `--seed` (plants two notes +
  one kick + bounded polls), `--injection` (a planted injection must never land
  as a fact). It reads `.secrets/prod.env`, prints its request count, and is
  single-shot by construction.
- **Free tier:** the sweep is the only recurring Gemini consumer (≤4 calls per
  30 min plus embedding batches ≤100 facts); never loop against the deployed
  worker — see the rules above.

## Phase 3 (truth)

Reviewing a proposal now applies it for real: one engine serves the REST
surface and the auto tier, every write is audited, and the reversible ones can
be undone.

- **Review engine:** proposals remain the only path to corrections, disputes,
  forgets and block edits. Corrections auto-apply only when the evidence is an
  `actor=user` event and the fact is not sensitive; disputes auto-apply only for
  normal-sensitivity facts; everything else is manual. Auto-applied rows apply
  at creation (`actor=system`) and stay undoable.
- **Supersession:** a correction inserts a new `user_stated` 0.9 fact
  (sensitivity inherited, evidence carried, old sources copied) and
  soft-supersedes the old one — `status='superseded'`, `invalid_at`,
  `superseded_by` set, text + FTS row kept for provenance. `undo` restores the
  old fact and archives the replacement; the replacement can still re-embed
  through the normal sweep if needed.
- **Forget:** hard and irreversible, gated by a single-use confirm token minted
  for `fact:{id}` / `event:{id}`. Fact purge nulls `object_text`, deletes the
  FTS row and the vector, closes edges; event purge is the crypto-shred flow.
  Disputes mark `status='disputed'` (never embedded, never searched).
- **Contradiction handling (deterministic, no LLM):** multivalued predicates
  never conflict; a `user_stated` new supersedes conflicting actives; a
  non-user fact contradicting a `user_stated` old (or hitting an exclusive
  predicate) inserts `disputed`; unknown predicates coexist. Runs report
  `superseded` / `disputed` counters.
- **Routes:** `POST /v1/facts/:id/{correct|dispute|purge}` →
  `{proposal_id, review_mode, applied}`; `POST /v1/proposals/:id/{apply|discard|undo}`
  (apply of a forget needs the confirm token); `GET /v1/why/:id` (read) →
  fact + full version chain (both directions; purged versions keep `object:null`)
  + sources (`purged` flag; restricted-privacy excerpts masked for non-admin);
  `GET /v1/entities/:id` (read) → entity with direction-relative edges. The
  proposal listing hides restricted rows from non-admin scopes.
- **Evals:** `test/eval-forget.test.ts` gates the five forget semantics
  (supersession / drift / dispute / purge / restricted) with cosine-1.0 fake
  vectors — a miss can only mean the forgetting worked, never weak similarity.
- **Ops:** no new migrations (schema complete since 0001–0005) and no new
  secrets; MCP still only proposes — applying stays on the Bearer HTTP API.
- **Acceptance (2026-10-15, single-shot, post-merge):** corrected the live
  `helios` fact → auto-applied (`review_mode:"auto"`, `applied:true`); `why`
  showed both versions (old text kept for provenance); the keyword search ranked
  the corrected object #1 (vector catches up on the next sweep); `undo`
  restored the original fact. Full evidence in the
  [Phase 3 plan](docs/plans/2026-10-15-brain-phase-3.md) closing section.

## Phase 4 (consolidation)

The brain keeps itself tidy on four crons: the 30-minute sweep, a nightly
consolidation pass, and weekly/monthly reflections.

- **Crons:** `*/30` sweep (extract + embed), `0 3 * * *` consolidation,
  `0 4 * * 1` weekly reflection, `0 4 1 * *` monthly reflection. The scheduled
  handler dispatches on the trigger string (`routeCron`); unknown triggers log
  and no-op; every job is wrapped so a cron never dies silently.
- **Retirement:** active `temporary` facts past `expires_at` →
  `status='archived'`, `expired_at` set, vector pruned, edge closed, audit
  `expire` (≤100/run; text kept for `why`).
- **Consolidation (one model call per run, ≤20 groups / ≤200 facts):** active
  `inferred` facts grouped by (subject, predicate); a group reaches the model
  only when ≥2 distinct evidence units (session + UTC calendar day) back it.
  Merges apply only when the victim adds ≥1 new unit; confidence = noisy-OR
  over distinct units capped 0.85; sources unioned, `first_seen=min`,
  `last_confirmed=max`; the victim is soft-superseded (`superseded_by` =
  survivor). Deleted/restricted material never serializes. Conflicts are
  counted and reported, never resolved. Model failure → `degraded` run;
  deterministic stages still apply; every run lands in `consolidation_runs`
  + audit.
- **Reflections:** weekly (last 7d) / monthly (last 30d) insight sets (≤300
  facts, ≤80 events in-window) stored as JSON with `reflection_sources`
  evidence; restricted and purged material filtered before the prompt and the
  model's fact ids re-intersected with what was sent; an empty window skips
  without a model call; degraded runs still store a row.
- **Routes:** `POST /v1/consolidate` (admin ops kick, mirrors `/v1/extract`),
  `POST /v1/reflect {period}` (admin), `GET /v1/reflections/latest` (read) →
  newest reflection + fact ids (404 when none).
- **Health:** `consolidation.last_run` summary (id, finished_at, merged,
  superseded, conflicts, pruned) + `reflections` count.
- **Eval:** `test/eval-consolidation.test.ts` pins the §8 "done when": cross-unit
  merges only, tombstones honored, restricted never serialized, vectors pruned.
- **Acceptance (2026-10-16, single-shot, post-merge):** health exposed the new
  fields; `POST /v1/consolidate` → run `01M50BYJ…` recorded (0 candidate groups
  on live data yet — 5 active inferred facts, no pairs); `POST /v1/reflect
  {week}` → run `01M50BZA…` with 2 evidence-backed insights; latest read + post
  health both green. Full evidence in the
  [Phase 4 plan](docs/plans/2026-10-15-brain-phase-4.md) closing section.

## Phase 5 (procedural)

Repeated workflows move from "the agent noticed a pattern" to an approved,
versioned procedure — and only a human can flip the approval switch.

- **Flow:** `propose_procedure` (MCP, propose scope) lands a `procedure`
  proposal that is **always manual**; `POST /v1/proposals/:id/apply` (ADMIN)
  promotes it into `procedures` as **draft v1** plus a `procedure_versions`
  row; `POST /v1/procedures/:id/approve` (ADMIN) is the only path to
  `approved`. The approve route is **not** an MCP tool — agent tokens get
  403, so the agent cannot self-approve.
- **Trust on origin:** proposals may cite `evidence_event_id`; an
  `actor=external` evidence event is a hard refuse at apply
  (`400 untrusted_origin`, nothing written), and evidence-based promotions
  carry `origin_trust` = the event's trust. No evidence → neutral 0.5.
- **Versioning:** `procedure_id` targets an existing procedure (otherwise a
  normalized name match); applying lands version N+1, keeping every prior
  version intact. **Any new version flips an approved procedure back to
  draft** — every version needs its own approval. Deprecated procedures
  refuse new versions. Promotion has no undo (manual tier; versions are
  append-only history).
- **Routes:** `POST /v1/procedures/:id/approve` (admin), `GET /v1/procedures`
  and `GET /v1/procedures/:id` (read; detail returns the full newest-first
  version history).
- **Eval:** `test/eval-procedure.test.ts` runs the §8 done-when end to end:
  MCP propose → 403 for agent tokens on apply/approve → ADMIN apply → ADMIN
  approve → approved procedure; refinement → re-approval gate; poisoned
  external origin dies with zero rows.
- **Acceptance (2026-10-16, single-shot, post-merge):** agent proposed via MCP
  (`01M50DDG…`, manual) → ADMIN applied (draft v1, `01M50DDW…`) → ADMIN
  approved → approve retried with both agent tokens → **403** → final read
  `approved`. Full evidence in the
  [Phase 5 plan](docs/plans/2026-10-16-brain-phase-5.md) closing section.

## Phase 6 (reach)

The brain syncs from GitHub, backs itself up in two profiles, restores onto a
clean account with nothing but the escrowed KEK — and ships a small read-only
inspector.

- **GitHub connector:** `POST /v1/connectors/github/sync` (ADMIN) pulls recent
  commits for up to 10 `owner/name` repos (lookback ≤ 720 h) and lands them
  through the normal ingest path. Events are `source: github`, **`actor:
  external` (trust 0.4)** — a third-party surface, so connector text can never
  become `user_stated` material. Deterministic ids (`gh-{repo}-c-{sha12}`)
  make re-syncs idempotent. Optional `GITHUB_TOKEN` secret raises rate limits;
  public-repo sync works unauthenticated without it.
- **Export profiles:** `GET /v1/export?profile=backup|portable` (ADMIN) walks
  the content tables (FTS is re-derived, not copied) into chunked NDJSON parts
  under `exports/{job}/` in R2 with a `meta.json` sidecar. `backup` (default)
  ships ciphertext + wrapped keys — a leaked link exposes nothing without the
  KEK. `portable` additionally requires a single-use confirm token
  (`POST /v1/confirm/token`, target `export:portable`), decrypts payloads on
  the walk, and omits wrapped keys.
- **Links + retention:** downloads ride an HMAC-signed URL (`?exp&token`,
  15-minute TTL, constant-time compare) requiring **no bearer** token.
  Portable jobs delete themselves from R2 right after the first download;
  every other job is pruned by the sweep once expired (+5 min grace, ≤100
  objects per run).
- **Restore:** `POST /v1/restore {job}` (ADMIN) reads a backup export back
  into a fresh account — schema from migrations, zero rows — and rebuilds
  both FTS indexes. Payloads stay encrypted at rest; the wrapped keys unwrap
  with `PAYLOAD_KEK` alone. The clean-account proof is
  `test/eval-restore.test.ts`: the §8 done-when sentence (export → wipe →
  restore → verified through the read routes, payload decrypted with the KEK).
- **Inspector:** `GET /inspector` serves a single self-contained page (zero
  data, no build step); paste a read token and it shows health, search,
  procedures, and the latest reflection.

## Read-first map

| Doc | What it is |
| --- | --- |
| [`docs/design-v1.2.md`](docs/design-v1.2.md) | Approved design spec — authority for behavior, SQL, budgets |
| [`docs/plans/2026-10-15-brain-phase-0-1.md`](docs/plans/2026-10-15-brain-phase-0-1.md) | Execution plan (Phase 0/1) — 15 tasks with exact interfaces and tests |
| [`docs/plans/2026-10-15-brain-phase-2.md`](docs/plans/2026-10-15-brain-phase-2.md) | Phase 2 plan — semantic layer (extraction, embeddings, search blend) |
| [`docs/plans/2026-10-15-brain-phase-3.md`](docs/plans/2026-10-15-brain-phase-3.md) | Phase 3 plan — review engine, why/entity views, contradictions |
| [`docs/plans/2026-10-15-brain-phase-4.md`](docs/plans/2026-10-15-brain-phase-4.md) | Phase 4 plan — crons, consolidation, reflections, health |
| [`docs/plans/2026-10-16-brain-phase-5.md`](docs/plans/2026-10-16-brain-phase-5.md) | Phase 5 plan — procedures, versioning, approval gate |
| [`docs/plans/2026-10-16-brain-phase-6.md`](docs/plans/2026-10-16-brain-phase-6.md) | Phase 6 plan — connector, export profiles, restore, inspector |
| [`.superpowers/sdd/2026-10-15-brain-phase-0-1/progress.md`](.superpowers/sdd/2026-10-15-brain-phase-0-1/progress.md) | Running ledger — rulings, gotchas, environment facts. **Read before changing anything.** |
| [`.superpowers/sdd/2026-10-15-brain-phase-2/progress.md`](.superpowers/sdd/2026-10-15-brain-phase-2/progress.md) | Phase 2 ledger — rulings + gotchas |
| [`.superpowers/sdd/2026-10-15-brain-phase-3/progress.md`](.superpowers/sdd/2026-10-15-brain-phase-3/progress.md) | Phase 3 ledger — rulings + gotchas |
| [`.superpowers/sdd/2026-10-15-brain-phase-4/progress.md`](.superpowers/sdd/2026-10-15-brain-phase-4/progress.md) | Phase 4 ledger — rulings + gotchas |
| [`.superpowers/sdd/2026-10-16-brain-phase-5/progress.md`](.superpowers/sdd/2026-10-16-brain-phase-5/progress.md) | Phase 5 ledger — rulings + gotchas |
| [`.superpowers/sdd/2026-10-16-brain-phase-6/progress.md`](.superpowers/sdd/2026-10-16-brain-phase-6/progress.md) | Phase 6 ledger — rulings + gotchas |
| `.superpowers/sdd/2026-10-15-brain-phase-0-1/task-N-brief.md` | Per-task briefs (interfaces, verbatim tests) |
| [`docs/key-rotation.md`](docs/key-rotation.md) | PAYLOAD_KEK rotation procedure |

## Layout

```
src/            Worker source — routes, auth, crypto, redact, budget, ingest,
                purge, audit, rebuild (FTS5), search, blocks, mcp, sweep,
                extract, factstore, graph, review, consolidate, reflect,
                procedures, health, connector-github, exporter, inspector
migrations/     D1 schema 0001–0005 (wrangler d1 migrations apply)
test/           vitest suite (@cloudflare/vitest-plugin, D1 via miniflare)
plugin/         OpenCode capture plugin — event-sourced capture + diagnostics (Tasks 13–14)
docs/           spec + plan + key rotation
wrangler.jsonc  Worker config: D1 brain-db, R2 brain-raw, crons (*/30 sweep,
                nightly consolidation, weekly/monthly reflections),
                keep_vars + secrets.required (see Deploy & CI)
```

## Develop

```bash
npm install
npx vitest run        # full Worker suite
npx tsc --noEmit      # typecheck
npx wrangler dev      # local worker (create .dev.vars from vitest.config.ts bindings)

cd plugin && npm i && npx vitest run   # capture plugin tests
```

Dev-only tokens (`dev-kek`, `dev-hmac`, `dev-read`, `dev-propose`, `dev-admin`)
live in `vitest.config.ts` miniflare bindings — the suite runs from a fresh clone.

## Ops facts

- Worker `brain-api` → `https://brain-api.taxin-404.workers.dev` (deployed)
- D1 `brain-db` + R2 `brain-raw` live (APAC region), 5/5 remote migrations applied
- Prod secrets set via `wrangler secret put`; values escrowed out-of-band, **never in the repo**
- Crons: `*/30` sweep + nightly consolidation (`0 3 * * *`) + weekly/monthly reflections (`0 4 * * 1` / `0 4 1 * *`)

## Deploy & CI (Cloudflare Workers Builds)

Pushing to `master` makes Cloudflare build and deploy `brain-api` automatically
(GitHub repo `taxin-404/brain`, production branch `master`).

- **Build command:** `npm ci && npm test` — a red test suite blocks the deploy.
- **Deploy command:** `npx wrangler deploy --env=""` — the trailing `--env=""`
  targets the top-level config on purpose: `env` blocks do **not** inherit
  bindings, so `--env prod` would deploy a worker with zero D1/R2 bindings.
- **Secrets survive deploys** (worker-level, never touched by a deploy):
  `PAYLOAD_KEK`, `CONTENT_HMAC_KEY`, `MCP_READ_TOKEN`, `MCP_PROPOSE_TOKEN`,
  `ADMIN_TOKEN`. `keep_vars: true` additionally protects dashboard-set plain-text
  vars, and `secrets.required` in `wrangler.jsonc` makes a deploy *fail loudly*
  if any of the 5 secrets is missing. Symptom of a missing secret: every
  authenticated route 401s.
- **Preview builds are intentionally NOT configured** — previews would run
  against the same prod D1/R2; there is no preview isolation yet.
- **Push-triggered builds go silent if the GitHub App loses repo access.** The
  repo is public, so manual API-triggered builds keep working even when webhooks
  are dead — before debugging anything else, verify the *Cloudflare Workers and
  Pages* app still lists `brain` (https://github.com/settings/installations).

Builds API (for agents; management token in `.secrets/cf-builds.env` —
user-scoped, `Workers Builds Configuration:Edit` + `Workers Scripts:Read`):

```bash
T=$(source .secrets/cf-builds.env && echo -n "$CF_BUILDS_TOKEN"); A=1ce49401e2d9c63449f7621e4f5e10e9
TAG=000d2f15931e461dad9bb9b423ab461a          # brain-api worker tag (external_script_id)
TRIGGER=a69e5d96-f3e4-4505-8cb9-99ad22fcde70  # "Deploy production" trigger

# list builds / trigger one manually / read logs
curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/accounts/$A/builds/workers/$TAG/builds"
curl -s -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$A/builds/triggers/$TRIGGER/builds" -d '{"branch":"master"}'
curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/accounts/$A/builds/builds/<build_uuid>/logs"
```

The deploy step authenticates with the account's **"terabox build token"**
(`7d897a7d-0b7f-4ba7-a13a-a2237258c485`), reused because build tokens cannot be
created via API without token-creation permissions. It is account-scoped and
nothing about it is terabox-specific; deleting it would break both projects'
builds.

## Progress

| Tasks | What | State |
| --- | --- | --- |
| 1 | scaffold: repo, tsconfig, vitest, health route | ✅ |
| 2 | D1 migrations 0001–0005 (events, FTS, budgets, confirm_tokens, audit) | ✅ |
| 3 | auth (read/propose/admin, strict propose≠read), budget read, Phase 0 gate | ✅ |
| 4 | redaction (payload + excerpt, sensitive KEY-name rule) | ✅ |
| 5 | crypto: AES-GCM envelope, HMAC, ULID, key-rotation doc | ✅ |
| 6 | budget charge: 10k cap, 70k warn, 80k breaker, admin exempt | ✅ |
| 7 | encrypted idempotent ingest `/v1/events/batch` + routes | ✅ |
| 8 | crypto-shred purge (exact 6-step sequence) + audit | ✅ |
| 9 | FTS rebuild honoring tombstones | ✅ |
| 10 | search + working-memory blocks | ✅ |
| 11 | MCP server: recall, get_blocks, health_report, remember | ✅ |
| 12 | `*/30` sweep cron | ✅ |
| 13 | OpenCode capture plugin (`plugin/`) | ✅ |
| 14 | Phase 1 acceptance — live capture + MCP recall proven, race fix | ✅ |
| 15 | keyword eval harness: recall@5 ≥ 0.9 regression gate (12 real pairs) | ✅ |
| — | Phase 2: semantic layer (extraction, embeddings, hybrid search) | ✅ |
| — | Phase 3: review engine, why/entity views, deterministic contradictions | ✅ |
| — | Phase 4: crons, consolidation, reflections, health | ✅ |
| — | Phase 5: procedures — versioning + human approval gate | ✅ |
| — | Phase 6: reach — GitHub connector, exports + clean-account restore, inspector | ✅ |

## For AI agents

- Read the design doc and the progress ledger before touching code — the ledger
  records non-obvious rulings (vitest-plugin storage isolation, `redacted` flag
  semantics, MCP need-token gating) that will otherwise cost you hours.
- TDD: write the failing test first, watch it fail, then implement.
- Gate every commit on `npx vitest run` and `npx tsc --noEmit`. Do not pipe
  vitest when you need its exit code.
- Test isolation gotcha: miniflare storage is fresh per test **file**, shared
  across tests **within** a file — use unique ids/sessions/days per test and
  budget assertions as deltas.
- Secrets policy: `.secrets/` and `.dev.vars` are gitignored; the `dev-*` tokens
  in `vitest.config.ts` are intentionally public and local-only.
- Capture plugin: sessions are discovered from the global event stream
  (`ctx.session` has no `list` at runtime); diagnostics land in
  `/tmp/opencode/brain-capture-diag.log` — plugin console output is invisible in
  server logs. Live E2E without touching global config: a project-local
  `opencode.json` with the plugin entry in a scratch dir (see `task-14-log.md`).
- Registered globally (owner-approved 2026-10-15): the capture plugin and the
  `brain` MCP server (recall / get_blocks / health_report / remember) live in
  `~/.config/opencode/opencode.json` — every session captures automatically.
