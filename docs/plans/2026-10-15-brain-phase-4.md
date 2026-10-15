# Brain — Phase 4 (consolidation) plan

> Branch `phase-4` from `master` @ `52f925a` (Phase 3 closed, merged, CI green,
> live acceptance passed). Same discipline as phases 0–3: TDD per task (tests
> first, watch them fail), one commit per task with its plan boxes ticked in the
> same commit, gate = unpiped `npx vitest run` + `npx tsc --noEmit` before every
> commit, ledger rulings in `.superpowers/sdd/2026-10-15-brain-phase-4/`.
> Free-tier discipline: never loop against deploys; every test offline (MSW +
> fake Vectorize); live acceptance single-shot.

## Context

Design §8 Phase 4: **"4 crons, evidence-unit merge, retire expired facts,
reflections, health report. Done when: Nightly run merges cross-unit duplicates
only, honors tombstones, reports conflicts."**

Already in place: `reflections` + `reflection_sources` (migration 0003) and
`consolidation_runs` (0005) tables; `facts.expires_at` / `expired_at`; evidence
units derivable from `fact_sources → events` (session_id + calendar day);
`MULTIVALUED_PREDICATES` / `EXCLUSIVE_PREDICATES` rule table (Phase 3);
factstore lifecycle (`createFact` / `confirmFact` / `supersedeFact` /
`disputeFact` / `purgeFact` / `deleteFactVector`); `geminiJson` via AI Gateway;
sweep on `*/30` only; AUDIT actions free-form strings.

## Global constraints (carried)

- All fact writes funnel through `src/factstore.ts`; consolidation adds
  `expireFact` + `mergeFacts` there — nothing touches `facts` directly.
- Exactly one `consolidation_runs` row per consolidation run + one audit row;
  one audit row per expire/merge/supersede apply. Reflection runs write one
  `reflections` row + `reflection_sources` + one audit row.
- Never send `restricted` facts/events to Gemini; never include purged
  (`object_text IS NULL` / `redacted=1` / privacy=restricted) material.
- `events` stays append-only; no new migrations; no new secrets.
- LLM budget: sweep ≤4 calls/30 min unchanged; consolidation ≤1 call per run
  (nightly + manual kicks are single-shot); reflection ≤1 call per run.
- Reversibility: expire/merge are soft (rows keep text; archival/supersession
  links + audit rows carry history). Purge remains the only hard path.

## Pinned decisions (Phase 4)

1. **Crons (4 of 5 free slots):** `*/30 * * * *` sweep (existing), `0 3 * * *`
   consolidation, `0 4 * * 1` weekly reflection, `0 4 1 * *` monthly
   reflection. `scheduled` dispatches on `controller.cron` via an exported
   `routeCron(cron)` (unit-testable); unknown strings log and no-op.
2. **Expired retirement:** active `temporary` facts with `expires_at <= now`
   → `status='archived'`, `expired_at=now`, vector deleted, edges closed,
   audit `expire`. Cap 100/run (the next run continues). Soft: text kept.
3. **Merge scope:** `inferred` facts only (the unit rule and 0.85 ceiling are
   inferred-only per spec §6), active, `object_text` not null, sensitivity
   ≠ restricted, predicate not multivalued. Candidates grouped by
   `(subject_id, predicate)` with ≥2 rows; ≤20 groups / ≤200 facts / 8k chars
   per run. Tombstoned rows (deleted) have NULL text and never qualify.
4. **Evidence units:** `unit = (session_id ?? "none") + UTC calendar day of
   event ts`. A merge is applied only when the victim adds ≥1 unit the
   survivor lacks ("cross-unit duplicates only"); survivor confidence =
   noisy-OR over distinct units (per-unit max confidence), capped 0.85;
   `first_seen_at=min`, `last_confirmed_at=max`, sources unioned.
5. **One consolidation LLM call** (model: `gemini-3.5-flash-lite`, same as
   extraction) with the spec §6 [CONSOLIDATION] prompt + a JSON interface
   appendix (Phase-2 pattern). Output `{merges[], supersedes[], conflicts[]}`.
   Deterministic post-filters: ids ⊆ sent ids, same (subject, predicate), both
   active inferred, victim adds ≥1 new unit; anything else is skipped and
   logged in the run report (`skipped[]`). Chains/cycles resolve first-wins.
   LLM failure → `degraded:true`, expiry still applied, run still recorded
   (no throws out of the cron).
6. **Conflicts are reported, never auto-resolved** (count + report JSON);
   "promote confirmed proposals to user_stated" stays out of scope (no
   confirm proposal kind exists — ledgered deferral, same as entity merge).
7. **Manual kicks (ops + acceptance):** `POST /v1/consolidate`, `POST
   /v1/reflect {period}` (admin). Same caps as cron; ADMIN-exempt from budget
   like other admin routes. Ledgered as ops additions beyond §5 (mirrors the
   existing `POST /v1/extract`).
8. **Reflection run:** window = last 7 / 30 days; facts = active,
   non-restricted, text present, touched in window (≤300, newest first);
   events = normal privacy, not redacted, in window (≤80, excerpt ≤200
   chars). Zero facts → `{skipped:true}` and **no LLM call**. Insights
   validated (1–8 accepted, trimmed to 5; fact_ids filtered to sent set;
   insight dropped when no valid id; ≥1 must survive else degraded). Stored
   as JSON in `reflections.text`; `reflection_sources` = one row per
   (reflection, fact_id). `GET /v1/reflections/latest` (read) returns the
   newest with its fact ids, 404 when none.
9. **Health report additions (additive):** `consolidation: { last_run: {id,
   finished_at, merged, superseded, conflicts, pruned} | null }` and
   `reflections: <count>`.

## Review Focus (attack these)

- Stale/racy merge: two runs interleaving — victim already superseded →
  guard throws → skipped, run continues (never a failed cron).
- Tombstone honesty: deleted facts never re-enter via merges/supersedes;
  purged text never appears in prompts (assert on captured request bodies).
- Restricted leakage: restricted facts must never be serialized into either
  prompt; reflection output ids must be intersected with the sent set.
- Budget: exactly one Gemini call per consolidation run and per reflection
  run; zero calls when there is nothing to do.
- Idempotence: a second consolidation run right after the first merges
  nothing further; reflection re-run for the same period just adds a row.

### Task 1 — factstore lifecycle: `expireFact` + `mergeFacts`

**Files:**
- Modify: `src/factstore.ts`
- Test: `test/expire-merge.test.ts`

**Interfaces:**
- `expireFact(env, factId, opts { now?, actor? = "system" }): Promise<void>` —
  guard active (else `Error`); `status='archived'`, `expired_at=now`;
  `closeFactEdges`; `deleteFactVector`; audit `expire` before/after.
- `mergeFacts(env, survivorId, victimId, opts { now, confidence }):
  Promise<void>` — guard both exist, both active, same `subject_id` +
  `predicate` (else `Error`); union `fact_sources`
  (`INSERT OR IGNORE … SELECT`); `first_seen_at=min`, `last_confirmed_at=max`
  (JS-computed from both rows); survivor `confidence` = passed value
  (clamped ≤0.85 here as a last defense); then `supersedeFact(victim,
  survivor)`; audit `merge` on the survivor (before/after confidence +
  `reason: "merged <victimId>"`). The noisy-OR math lives in
  `consolidate.ts` (it owns unit knowledge); this function is bookkeeping.

- [x] **Step 1: Tests** — expire happy path (archived, expired_at, vec gone,
  edges closed, audit row) + guard on non-active; merge happy path (sources
  unioned, min/max timestamps, confidence set, victim superseded_by survivor,
  victim vector gone, both audit rows) + guards (inactive victim, predicate
  mismatch).
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** both functions.
- [x] **Step 4: Gate + commit** — `feat(factstore): expire + merge lifecycle`.

### Task 2 — consolidation engine + `POST /v1/consolidate`

**Files:**
- Modify: `src/prompts.ts` (append `CONSOLIDATION_PROMPT`, verbatim §6 + JSON
  interface appendix)
- Create: `src/consolidate.ts`
- Modify: `src/index.ts` (route)
- Test: `test/consolidate.test.ts`

**Interfaces:**
- `runConsolidation(env, opts { now?; maxGroups? = 20; maxFacts? = 200 }):
  Promise<ConsolidationRun>` with
  `{ id, started_at, finished_at, new_facts: 0, merged, superseded,
  conflicts, pruned, degraded, report }`; inserts the `consolidation_runs`
  row (report = JSON string) + audit `consolidate` (`target_type:
  "consolidation_run"`). Stages: (1) retire expired (≤100), (2) candidates,
  (3) one `geminiJson` call, (4) apply merges (≤20) via `mergeFacts` with
  noisy-OR (unit map: per-unit max confidence across survivor+victim; cap
  0.85), (5) apply supersedes, (6) count conflicts. `LlmError` → degraded
  report, no throw.
- `handleConsolidate(env): Promise<Response>` → 200 run JSON (admin route).

- [x] **Step 1: Tests** — expiry retired with counters; cross-unit merge
  applied (confidence = noisy-OR, capped; sources unioned; victim
  superseded); same-unit pair NOT merged (victim adds no unit → skipped);
  deleted + restricted objects never appear in the captured request body;
  conflicts counted only; LLM failure → degraded + expiry still applied + run
  row present; second run merges nothing (idempotent); route: admin 200,
  read scope 403.
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** prompt + engine + route.
- [x] **Step 4: Gate + commit** — `feat(consolidate): nightly merge/retire engine + manual kick`.

### Task 3 — reflections + routes

**Files:**
- Modify: `src/prompts.ts` (append `REFLECTION_PROMPT`)
- Create: `src/reflect.ts`
- Modify: `src/index.ts` (2 routes)
- Test: `test/reflect.test.ts`

**Interfaces:**
- `runReflection(env, opts { period: "week" | "month"; now? }):
  Promise<ReflectionRun>` with `{ id, period, period_start, period_end,
  insights: Array<{text, fact_ids}>, degraded, skipped }`; window 7/30 days;
  facts ≤300 / events ≤80 (caps above); zero facts → `skipped:true`, no LLM
  call; one `geminiJson` call; validation: 1–8 insights accepted, trimmed to
  5, fact_ids intersected with sent set, insights without valid ids dropped,
  ≥1 survives else degraded; writes `reflections` row (text = insights JSON),
  `reflection_sources` per fact, audit `reflect`.
- `handleReflectionsLatest(env): Promise<Response>` → `{ reflection: {id,
  period, period_start, period_end, created_at, insights}, fact_ids }`; 404
  `not_found` when empty.
- `handleReflect(request, env): Promise<Response>` — body `{period}`; 400 on
  invalid; 200 run JSON.

- [x] **Step 1: Tests** — week run stores row + sources + audit; restricted
  fact text never in the captured body; invalid fact ids dropped; empty
  window skips **without any gateway call** (handler hit-counter = 0);
  superseded/purged rows excluded; latest 404 then 200 after a run; POST
  admin-only + 400 bad period + month window works.
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** prompt + runner + routes.
- [x] **Step 4: Gate + commit** — `feat(reflect): weekly/monthly reflections + latest route`.

### Task 4 — cron dispatch

**Files:**
- Modify: `wrangler.jsonc` (4 crons)
- Modify: `src/index.ts` (`routeCron` export + `scheduled` switch)
- Test: `test/cron.test.ts`

**Interfaces:**
- `routeCron(cron: string): "sweep" | "consolidation" | "reflection_week" |
  "reflection_month" | null` — exact string map.
- `scheduled` calls the mapped runner, each wrapped so a throw only logs
  (a cron must never die silently); unknown cron logs `[cron] unknown`.

- [x] **Step 1: Tests** — mapping for all four strings + unknown → null;
  `scheduled` with a fake controller for `0 3 * * *` runs consolidation
  (empty DB → run row inserted, degraded false); `*/30` still runs the sweep
  (existing sweep tests keep passing).
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** dispatch + config.
- [x] **Step 4: Gate + commit** — `feat(cron): nightly consolidation + reflection triggers`.

### Task 5 — health report additions

**Files:**
- Modify: `src/health.ts`
- Test: `test/health.test.ts` (extend) — check existing file location first;
  if health assertions live in another suite, extend there.

**Interfaces:**
- `consolidation: { last_run: { id, finished_at, merged, superseded,
  conflicts, pruned } | null }` (newest by `finished_at`), `reflections:
  number`. Additive: existing fields untouched; MCP `health_report` tool
  passes the object through unchanged.

- [x] **Step 1: Tests** — empty DB → `last_run:null`, `reflections:0`; after
  seeded run/reflection rows → values surface; existing assertions still pass.
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement.**
- [x] **Step 4: Gate + commit** — `feat(health): consolidation + reflection status`.

### Task 6 — consolidation eval

**Files:**
- Create: `test/eval-consolidation.test.ts`

**Interfaces:**
- Scripted mini-eval (mirrors `test/eval-forget.test.ts` patterns; MSW stub
  returns a fixed merge disposition): seeds 2 cross-unit inferred duplicates
  (distinct sessions/days), 1 same-unit pair (must stay untouched), 1 expired
  temporary, 1 deleted fact whose old text must not resurrect, 1 restricted
  fact. Asserts: merged=1 + survivor confidence via noisy-OR, same-unit pair
  intact, pruned=1, deleted row stays `object_text IS NULL` + FTS empty,
  restricted text absent from the captured prompt, vector store size strictly
  decreases (pruning), run report JSON fields present.

- [x] **Step 1: Write the eval; run and watch fail.**
- [x] **Step 2: Implement** only what the eval exposes (should be nothing —
  it pins Tasks 1–2 behavior; if it fails, fix honestly).
- [x] **Step 3: Gate + commit** — `test(eval): consolidation mini-eval (tombstones, pruning)`.

### Task 7 — docs + close-out

**Files:**
- Modify: `README.md` (Phase 4 section: flows, crons, ops)
- Modify: `.superpowers/sdd/2026-10-15-brain-phase-4/progress.md` (ledger
  close-out)
- Mirror this plan to `/home/taxin/Work/docs/superpowers/plans/`.

- [x] **Step 1: Full gate** — unprefixed `npx vitest run` + `npx tsc --noEmit`.
- [x] **Step 2: README** Phase 4 section (4 crons, merge rules, retirement,
  reflections, health) + status line.
- [x] **Step 3: Tick every box in this plan; ledger close-out; mirror.**
- [x] **Step 4: Commit** — `docs: close phase 4 (crons + consolidation + reflections)`.

## Merge + acceptance (closing — one push)

- [x] Merge `phase-4` → `master`, push; watch the CI build once (status +
  outcome only). No migration to apply.
- [x] Live acceptance, single-shot each:
      1. `GET /v1/health-report` = 200 (reads `consolidation.last_run`).
      2. `POST /v1/consolidate` (admin) → run JSON; expect 200 and a
         `consolidation_runs` row (verify via D1 read).
      3. `POST /v1/reflect {"period":"week"}` → run JSON; then
         `GET /v1/reflections/latest` returns the reflection with fact ids.
      4. Spot-check `GET /v1/health-report` again → `last_run` present.
- [ ] Owner actions at merge (reminder only): Google Cloud budget alert; key
      rotation from the Phase-2 ledger.

### Acceptance evidence (2026-10-16, single-shot, post-merge — master @ `a43ddee`)

- **Merge:** `phase-4` fast-forwarded to master; CI builds for `a43ddee`
  succeeded (`8cf36422…` + a duplicate webhook delivery `c9764ae0…`, both
  `stopped/success`; identical commit — the duplicate is a delivery artifact,
  not a config error).
- **1. Health (pre-run):** `HTTP 200` — `reflections: 0`,
  `consolidation.last_run: null`, `events: 1323`, `purges: 16`,
  `extractions.pending: 20`, budget used 3683 (no warn/breaker).
- **2. Consolidation kick:** `POST /v1/consolidate` → `HTTP 200`, run
  `01M50BYJXKD7TRQTY8R9V3NQ1V` (`groups_sent: 0`, all counters 0,
  `degraded:false`). Prod D1 row confirmed with the same id and counters.
  No candidate groups on live data yet: 5 active `inferred` facts with text,
  zero `(subject, predicate)` groups ≥2, zero lapsed `temporary` facts — the
  20 pending extractions will feed the next nightly run. No model call spent.
- **3. Reflection:** `POST /v1/reflect {"period":"week"}` → `HTTP 200`, run
  `01M50BZA17HZ0T0XB54XGVECBV`, `skipped:false`, `degraded:false`, 2 insights
  with live fact evidence (`01M509W5XX…`, `01M509W81M…`). The model returned
  2 insights; the ledgered 1–8 tolerance accepted them (spec asks 3–5).
  `GET /v1/reflections/latest` → same id, same insights, `fact_ids` = both.
- **4. Health (post-run):** `reflections: 1`,
  `consolidation.last_run.id = 01M50BYJXKD7TRQTY8R9V3NQ1V`.

