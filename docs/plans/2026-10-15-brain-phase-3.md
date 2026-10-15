# Personal Neural Memory — Phase 3 (Graph + Truth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 3 — temporal graph (entity aliases + edges), contradiction
handling at extraction, correction/dispute/forget proposal flows with the
v1.2 review tiers, `GET /v1/why/:fact_id`, and fact-level purge — so that
*changing a fact supersedes it*, *an auto-tier applies a user-evidenced
correction*, and *`why` shows both versions* (design §8, Phase 3 row).

**Architecture:** all fact writes funnel through one module (`src/factstore.ts`)
so extraction, review, and purge share identical persistence (row + FTS +
sources + audit + vector lifecycle). Proposals already land in `proposals`
(Phase 2); Phase 3 adds the engine that *applies* them: corrections create a
replacement fact and **supersede** the old one (soft — object text retained),
forget purges (soft-null for facts, crypto-shred for events), dispute marks,
block edits write blocks — every apply audited so `undo` can reverse
correction/dispute/block_edit (forget is irreversible by construction). Tier
rules apply at creation: an `actor=user` correction of a non-sensitive fact
**auto-applies** (audited `actor=system`), everything destructive stays manual
with out-of-band confirm tokens. Contradictions detected during extraction use
a pinned deterministic rule table (no LLM call); supersession removes the old
vector from the index (re-embed path already exists for undo).

**Tech Stack:** unchanged from Phase 2 (Workers + D1 + R2 + Vectorize +
AI Gateway → Gemini). **No new migration** — every table needed
(`entities`, `entity_aliases`, `edges`, `proposals`, `audit_log`) shipped in
0001–0005. If a task appears to need a migration, stop and re-plan.

**Spec:** `docs/design-v1.2.md` — §8 (Phase 3 row), §4 (facts supersession vs
purge, edges, proposals), §5 (REST surface, proposal review tiers, confirm
tokens), §6 (CONTRADICTION DETECTION context), §9 (contradiction mini-ForgetEval;
"purged material must not resurrect").

**Where this runs:** branch `phase-3`, created from `master` @ `c5a11e9`.
Push the branch as you go (non-master pushes trigger nothing). **Merge to
master only at the end**; the merge runs CI (tests) + `wrangler deploy --env=""`.
Owner approval for this phase was given explicitly ("finish all the phases …
you can also push") before execution; the ledger records it.

## Non-negotiables (every executor session)

- **Free-tier rules:** zero network in tests (MSW guarded, `test/server.ts`);
  live calls only via capped sweep / manual kick / owner-run scripts, single-shot.
  Phase 3 adds **no new outbound calls** to any request path — embedding of new
  facts rides the existing sweep embed pass (`embedPendingFacts`), vector
  deletes are metadata mutations.
- Never print secret values; never deploy with `--env prod`.
- Gates before each commit: unpiped `npx vitest run` green **and**
  `npx tsc --noEmit` clean. Task closes only when its plan boxes are ticked
  in the same commit. Hub mirror re-`cp` after every plan edit.

## Global constraints (pin these; do not re-invent)

- **Supersession (soft):** old fact → `status='superseded'`, `invalid_at=now`,
  `superseded_by=<new id>`; object text and FTS row retained; old vector
  **deleted** from Vectorize and `vec_id` set NULL.
- **Hard purge (fact):** FTS `'delete'` with the old object text (skip when
  NULL), `object_text=NULL`, `status='deleted'`, vector deleted, `vec_id`
  NULL, audit before/after. `fact_sources` rows are kept (they hold no text).
- **Hard purge (event):** the existing 6-step crypto-shred (`purgeEvent`),
  refactored into `consumeConfirmToken` + `purgeEventCore` so the review engine
  can reuse it.
- **Corrections:** new fact is `fact_kind='user_stated'`, `confidence=0.9`,
  `sensitivity` inherited from the old fact, `object_text =
  normalizeObjectText(correction)`, `valid_at=now`; `source_event_id =
  evidence_event_id ?? old.source_event_id`; the old fact's `fact_sources`
  rows are copied to the new fact.
- **Review tiers (amendment 2 + one ruling):** `auto` iff correction ∧
  sensitivity `normal` ∧ evidence `actor=user`; `dispute` is auto only for
  `sensitivity='normal'` (sensitive disputes stay manual — safety carve-out,
  ledgered); forget/purge, block edit, procedure, entity merge are always
  manual. Auto proposals **apply at creation**, audited `actor=system`.
- **Confirm tokens:** apply of `kind='forget'` requires a token minted for
  `fact:{target_id}` (fact target) or `event:{target_id}` (event target);
  target must match, single-use, 5-minute TTL (`CONFIRM_TTL_MS`).
- **Audit convention for review:** apply writes `audit_log` row
  `{actor, action:'approve', target_type:'proposal', target_id:<proposal id>,
  before, after}`; undo reads the latest such row to restore the before-state
  and writes its own `action:'undo'` row. (For corrections `before` carries
  `{old_fact_id, old_status}` and `after` `{new_fact_id}`.)
- **Contradiction rules (extraction, deterministic — no LLM):** for a new fact
  whose (subject_id, predicate) already has an active fact with a different
  object:
  - predicate ∈ `MULTIVALUED_PREDICATES` → no conflict; insert normally.
  - new `user_stated` (any old) → supersede every conflicting active old, insert new.
  - else if any old `user_stated` → insert new with `status='disputed'`.
  - else if predicate ∈ `EXCLUSIVE_PREDICATES` → insert new `status='disputed'`.
  - else → both stay active (unknown predicate: keep both, no guess).
  - exact same object still = confirmation (`last_confirmed_at`, source link).
  Lists (tunable, in code): multivalued = `uses, depends_on, has_commit,
  has_endpoint, defines_table, supports_tools, uses_code_path, uses_database,
  has_vulnerability, contains`; exclusive = `name, is_called, lives_in,
  works_at, is_based_in, has_status, decided`.
- **Disputed facts** are never embedded (`embedPendingFacts` only picks
  `status='active'`) and never returned by search (existing status filters).
- Route additions (all existing auth): `GET /v1/why/:id` (read),
  `GET /v1/entities/:id` (read), `POST /v1/facts/:id/{correct,dispute,purge}`
  (admin), `POST /v1/proposals/:id/{apply,discard,undo}` (admin).
- Test helper: `installFakeVectorize` gains
  `deleteByIds(ids: string[]): Promise<{mutationId:string}>` (idempotent).

## Review Focus

- **Stale proposal:** correction against a fact that is no longer `active`
  (superseded/purged by an earlier flow) → clean `409 not_active`, proposal
  stays pending, *nothing* written.
- **Auto-apply race:** auto-apply when the target vanished between propose and
  apply → caught `ReviewError`, proposal stays pending, response says
  `applied:false`, no 500.
- **Purge idempotence:** purging an already-purged fact (object NULL) → no FTS
  `'delete'` on a NULL row, still exits `ok`.
- **Restricted confidentiality:** restricted facts/purls never leak through
  `why`, entity views, or proposal listings to non-admin scopes (404 / hidden).
- **Injection-adjacent correctness:** a non-user fact must never supersede a
  `user_stated` fact — it becomes disputed instead.

---

### Task 1 — `src/factstore.ts`: the single fact write path (+ extract.ts refactor)

**Files:**
- Create: `src/factstore.ts`
- Modify: `src/extract.ts` (step 4 insert/confirm block → helpers)
- Modify: `test/helpers.ts` (`deleteByIds` in `installFakeVectorize`)
- Test: `test/factstore.test.ts`

**Interfaces:**
- Consumes: `writeAudit`, `normalizeObjectText` (`src/facts.ts`), `newFactId`
- Produces (later tasks rely on exactly these):
  - `createFact(env: Env, input: CreateFactInput): Promise<string>` where
    `CreateFactInput = { subjectId: string; subjectName: string; predicate: string;
    objectText: string; factKind: FactKind; confidence: number; status?: "active"|"disputed";
    validAt?: number; expiresAt?: number; sensitivity: string; sourceEventId: string;
    now?: number }` — inserts fact row (`embedding_model='gemini-embedding-001'`,
    `vec_id` NULL), inserts `facts_fts` row, inserts `fact_sources`, writes
    `create` audit; returns the new id.
  - `confirmFact(env, factId: string, eventId: string, now: number): Promise<void>`
    — `last_confirmed_at=now` + `INSERT OR IGNORE` source link.
  - `deleteFactVector(env, factId: string): Promise<void>` — best-effort
    `VECTORIZE.deleteByIds([id])`; on success `UPDATE facts SET vec_id=NULL`;
    on failure logs, leaves row as-is (a stale vector is harmless — search
    filters by D1 status).

- [x] **Step 1: Write failing tests** — `createFact` inserts row+FTS (`SELECT
  count(*) FROM facts_fts WHERE object_text MATCH ...` via the fact's rowid),
  source link, `create` audit row; `confirmFact` bumps `last_confirmed_at` and
  dedupes source links; `deleteFactVector` removes the fake-index entry and
  NULLs `vec_id`.
- [x] **Step 2: Run and watch them fail** (`npx vitest run test/factstore.test.ts`).
- [x] **Step 3: Implement** `src/factstore.ts`; extend `test/helpers.ts` with
  the idempotent `deleteByIds`.
- [x] **Step 4: Refactor `src/extract.ts` step 4** to call `createFact` /
  `confirmFact` (no behavior change; existing `extract.test.ts` must stay green).
- [x] **Step 5: Gate + commit** — `npx vitest run` + `npx tsc --noEmit`;
  commit `feat(store): single fact write path (factstore) + extract refactor`.

### Task 2 — Graph: alias learning, object→entity links, edges, `GET /v1/entities/:id`

**Files:**
- Modify: `src/entities.ts` (alias learning in `resolveSubject`; new `resolveObjectEntity`)
- Create: `src/graph.ts`
- Modify: `src/factstore.ts` (createFact links edges)
- Modify: `src/index.ts` (route)
- Test: `test/graph.test.ts`

**Interfaces:**
- `resolveObjectEntity(db: D1Database, objectText: string): Promise<{ id: string } | null>`
  — norm match against `entities.norm_name` (any type, most-recent first);
  never creates entities.
- `linkFactEdges(env, fact: { id: string; subjectId: string; predicate: string;
  objectEntityId: string | null; confidence: number; validAt?: number;
  sourceEventId: string; now: number }): Promise<void>` — when
  `objectEntityId` set: UPDATE fact `object_entity_id` + INSERT edge
  (`rel = predicate`, `valid_at = validAt ?? now`, `learned_at = now`).
- `closeFactEdges(env, fact: { subjectId: string; predicate: string;
  objectEntityId: string | null }, now: number): Promise<void>` — set
  `invalid_at=now` on the matching open edge.
- `handleGetEntity(env, scope, id): Promise<Response>` — entity + aliases +
  active facts (as subject; restricted hidden for non-admin) + out/in edges
  with entity names; 404 unknown.
- Alias learning: in `resolveSubject`, whenever the match's `norm !== raw
  norm` (including SELF aliases, e.g. `taxin` → user), `INSERT OR IGNORE`
  into `entity_aliases` (`alias` = trimmed raw text, `norm_alias` = norm).

- [x] **Step 1: Tests** — alias rows appear for `taxin 404`/`Taxin404` and a
  case-variant project mention; object link only when entity exists; edge row
  fields pinned; `GET /v1/entities/:id` payload shape; restricted fact hidden
  from non-admin view.
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** `entities.ts` additions, `src/graph.ts`, call
  `linkFactEdges` from `createFact`, add the route (`need: "read"`).
- [x] **Step 4: Gate + commit** — commit
  `feat(graph): aliases, object-entity links, fact edges, entity view`.

### Task 3 — Review engine: `applyProposal` / `discardProposal` / `undoProposal`

**Files:**
- Modify: `src/purge.ts` (extract `consumeConfirmToken(env, target, token)`; export `purgeEventCore(env, eventId, reason)`; `purgeEvent` = both)
- Modify: `src/factstore.ts` (`supersedeFact`, `disputeFact`, `purgeFact`)
- Create: `src/review.ts`
- Test: `test/review.test.ts`

**Interfaces:**
- `class ReviewError extends Error { code: "not_found" | "not_pending" |
  "not_applied" | "irreversible" | "invalid_token" | "conflict" | "unsupported" }`
- `createFactFromCorrection(env, proposalId, opts: { actor: "user" | "system";
  now?: number }): Promise<{ newFactId: string; oldFactId: string }>` — loads
  proposal + old fact (must exist & `status='active'` else `conflict`); builds
  the new fact per Global constraints; `supersedeFact`; copies
  `fact_sources`; returns ids.
- `applyProposal(env, proposalId, opts: { actor: "user" | "system";
  confirmToken?: string; reason?: string; now?: number }): Promise<{ applied: true;
  kind: string }>` — pending-only (`not_pending` otherwise); dispatch:
  - `correction` → `createFactFromCorrection`; audit `approve` (before =
    old fact/status, after = new fact id); sets `applied_at`, `applied_by`,
    `status='applied'`.
  - `dispute` → target fact must be `active`; `disputeFact`; audit; applied.
  - `forget` → `consumeConfirmToken(env, \`${target_type}:${target_id}\`,
    confirmToken)` (`invalid_token` when missing); fact → `purgeFact`, event →
    `purgeEventCore`; audit; applied.
  - `block_edit` → key must be in `BLOCK_KEYS` (`conflict` otherwise); upsert
    block; audit before/after; applied.
  - `procedure` → `throw new ReviewError("unsupported", …)` (Phase 5 fills).
- `discardProposal(env, proposalId, opts): Promise<void>` — pending-only;
  `status='discarded'`; audit.
- `undoProposal(env, proposalId, opts): Promise<void>` — applied-only ∧
  `undone_at IS NULL`; `forget` → `irreversible`;
  - correction → old fact back to `active` (`superseded_by`/`invalid_at` NULL,
    `vec_id` stays NULL for the sweep), new fact `status='archived'` + vector
    deleted; dispute → `active`; block_edit → restore `before` value from the
    latest `approve` audit row. Writes `action:'undo'` audit + `undone_at`.
- `supersedeFact(env, oldId, newFactId, now)` — old row update +
  `closeFactEdges` + `deleteFactVector`.
- `purgeFact(env, factId, opts: { now? }): Promise<void>` — per Global
  constraints (idempotent when object already NULL).
- `disputeFact(env, factId, now)` — `status='disputed'` (allowed only from
  `active`) + audit.

- [x] **Step 1: Tests** — correction: old superseded (all three columns),
  new active `user_stated` 0.9, sources copied, old vector deleted; audit
  before/after present; apply on non-pending → `not_pending`; correction of a
  superseded fact → `conflict`; forget fact without token → `invalid_token`;
  with valid `fact:{id}` token → object NULL + FTS gone + vector gone +
  `deleted`; a second purge run on the same fact exits cleanly (idempotent,
  no FTS 'delete' on NULL); forget event → tombstone + crypto-shred (reuse
  purge test pattern); dispute on non-active → `conflict`; block apply → block updated;
  undo correction restores old `active` + new `archived`; undo forget →
  `irreversible`; undo twice → `not_applied`; procedure apply → `unsupported`.
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** purge refactor, factstore additions, `src/review.ts`.
- [x] **Step 4: Gate + commit** —
  `feat(review): apply/discard/undo engine with supersession + purge`.

### Task 4 — REST review surface + auto-apply at creation

**Files:**
- Modify: `src/proposals.ts` (`ProposalKind` += `"dispute"`; `computeReviewMode`
  dispute rule; auto-apply hook in `createProposal`; return
  `{ id, review_mode, applied }`)
- Modify: `src/review.ts` (handlers `handleFactReview`, `handleProposalReview`)
- Modify: `src/index.ts` (6 routes)
- Test: `test/review-http.test.ts`; update `test/proposals.test.ts`,
  `test/mcp.test.ts` expectations for the additive return shape

**Interfaces:**
- `createProposal(...)` same signature; afterwards, when
  `reviewMode === "auto"`: `try applyProposal(env, id, { actor: "system" })`
  → return `{ id, review_mode, applied: true }`; on `ReviewError` return
  `{ id, review_mode, applied: false, error: code }` (row stays pending).
- `handleFactReview(request, env, scope, factId, verb)`:
  - `correct` body `{ correction: string; evidence_event_id?: string;
    reason? }` → 404 unknown fact; proposal kind `correction`, payload
    `{ fact_id, correction, reason? }`, `sensitivity` from fact;
  - `dispute` body `{ reason? }` → kind `dispute`;
  - `purge` body `{ reason? }` → kind `forget`, `target_type:'fact'`.
  All → `{ proposal_id, review_mode, applied }` (201).
- `handleProposalReview(request, env, scope, proposalId, verb)`:
  `apply` body `{ confirm_token?, reason? }` → `{ applied: true, kind }`;
  `discard` → `{ discarded: true }`; `undo` → `{ undone: true }`;
  `ReviewError` → 400 (`invalid_token`/`conflict`/`not_pending`/…), `not_found`
  → 404, `irreversible` → 409, `unsupported` → 501.
- `handleListProposals` gains `scope`; rows with
  `sensitivity='restricted'` are hidden from non-admin callers.
- Routes added to `ROUTES`: the six paths from Global constraints
  (`need: "admin"`).

- [x] **Step 1: Tests** — REST correction with user evidence →
  `applied:true` and old fact superseded in the same response cycle; same
  without evidence → pending, `applied:false`; auto-apply where the target
  vanished → `applied:false`, proposal stays pending, no 500;
  agent-correction via MCP (`propose_correction` handler or direct
  `createProposal`) auto-applies when evidence is a user event; dispute of a
  sensitive fact stays pending; `GET /v1/proposals` hides
  `sensitivity='restricted'` rows from non-admin callers;
  purge→apply requires `fact:{id}` token; discard; undo round-trip over REST;
  `computeReviewMode` unit cases for `dispute`.
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** proposals changes, review handlers, routes.
- [x] **Step 4: Gate + commit** —
  `feat(review-http): fact review + proposal apply/discard/undo REST; auto-apply`.

### Task 5 — `GET /v1/why/:fact_id`

**Files:**
- Modify: `src/facts.ts` (`handleWhy`)
- Modify: `src/index.ts` (route, `need: "read"`)
- Test: `test/why.test.ts`

**Interfaces:**
- `handleWhy(env, scope, id): Promise<Response>` → 404 unknown/restricted
  (non-admin). Payload:
  `{ fact: <FactDetail>, versions: FactVersion[], sources: SourceRow[] }`.
  - `versions`: both directions of the supersession chain (walk
    `superseded_by` forward; walk back via `SELECT id … WHERE superseded_by =
    <current>`), sorted by `learned_at`; each version =
    `{ id, object, status, fact_kind, confidence, valid_at, invalid_at,
    learned_at, superseded_by, current: boolean }`. Purged versions keep
    `object: null` + `deleted: true`.
  - `sources`: the requested fact's `fact_sources` → events
    `{ event_id, ts, kind, actor, purged, excerpt|null }`; excerpt included
    (already redacted ≤500 chars) unless `privacy='restricted'` and caller is
    non-admin (row still listed with `excerpt:null, restricted:true`);
    `purged = redacted === 1`.

- [x] **Step 1: Tests** — after a correction, `why(old)` and `why(new)` both
  return a 2-version chain flagged `current` correctly ("shows both versions");
  purged source event shows `purged:true`; restricted fact 404 for read scope,
  present for admin; unknown id 404.
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** `handleWhy` + route.
- [x] **Step 4: Gate + commit** — `feat(why): provenance + version chain endpoint`.

### Task 6 — Contradiction handling in the extraction pipeline

**Files:**
- Modify: `src/facts.ts` (`MULTIVALUED_PREDICATES`, `EXCLUSIVE_PREDICATES`)
- Modify: `src/extract.ts` (pre-insert conflict check; counters)
- Modify: `src/sweep.ts` (`EMPTY_RUN` additive counters)
- Test: `test/contradictions.test.ts`

**Interfaces:**
- Extraction step 4, after the exact-duplicate check misses: load
  conflicting actives (`same subject_id + predicate`, different
  `object_text`, `status='active'`) and apply the Global-constraints rules.
  Supersessions go through `supersedeFact`; disputed inserts via
  `createFact({ status: "disputed" })`.
- `ExtractionRun` gains `superseded: number` and `disputed: number`
  (additive; `EMPTY_RUN`, `handleExtract` response, and health untouched).

- [x] **Step 1: Tests** — user-stated new supersedes inferred old (and both
  user-stated: newest wins, old keeps text for `why`); non-user new vs
  user-stated old → inserted `disputed`, old untouched; non-user vs non-user
  on an exclusive predicate → `disputed`; multivalued predicate → no conflict;
  unknown predicate, both non-user → both active; counters reflect each case.
- [x] **Step 2: Run and watch fail.**
- [x] **Step 3: Implement** lists + conflict block + counters.
- [x] **Step 4: Gate + commit** —
  `feat(extract): deterministic contradiction handling (supersede/dispute)`.

### Task 7 — ForgetEval + docs + close-out

**Files:**
- Create: `eval/forget.json`, `test/eval-forget.test.ts`
- Modify: `README.md` (Phase 3 section: flows, ops, acceptance evidence)
- Modify: `.superpowers/sdd/2026-10-15-brain-phase-3/progress.md` (ledger)
- Modify: this plan (all boxes ticked in the closing commit)

**Interfaces:**
- `eval/forget.json` cases (each `{ name, setup, action, expect }`): 
  `supersession` (old absent from active search, new present, `why` has both),
  `drift` (multivalued pair both active), `dispute` (disputed fact absent from
  search), `purge` (fact purged → object NULL, FTS empty, vector gone — the
  "purged material must not resurrect" assertion), `restricted` (restricted
  fact hidden from read scope). Runner mirrors `test/eval-semantic.test.ts`
  patterns (seeded D1 + fake Vectorize, zero network).
- Ledger entry: tier ruling (sensitive dispute = manual), supersession vector
  lifecycle, deterministic-contradiction ruling (LLM prompt deferred),
  entity-merge deferral rationale.

- [ ] **Step 1: Tests** — runner executes all cases green.
- [ ] **Step 2: Run full gate** — `npx vitest run` (unpiped) + `npx tsc --noEmit`.
- [ ] **Step 3: Docs + ledger; tick every box in this plan; mirror the plan to
  `/home/taxin/Work/docs/superpowers/plans/`.**
- [ ] **Step 4: Commit** — `docs: close phase 3 (forget eval + ledger)`.

## Merge + acceptance (closing commit — one push)

- [ ] Merge `phase-3` → `master`, push; watch the CI build once (`GET
      /builds/workers/{tag}/builds`, status + outcome only). No migration to
      apply (none added).
- [ ] Live acceptance, single-shot each (admin token from
      `.secrets/prod.env`; no loops):
      1. `GET /v1/health-report` = 200.
      2. `POST /v1/facts/01M506C0MP8G4J6GS80BR7EPVA/correct` with
         `{"correction":"the internal metrics dashboard","evidence_event_id":
         "01M5069P2DGDEDCAJAYNGPXBSJ","reason":"phase-3 acceptance"}` →
         `applied:true` (auto tier — evidence is the owner's `actor=user` note).
      3. `GET /v1/why/<new fact id>` → 2 versions, both objects visible.
      4. `GET /v1/search?q=what did the user name their analytics dashboard`
         → the corrected object ranked (vector may lag until the next sweep
         embeds it; keyword/DB checks are the primary evidence).
      5. `POST /v1/proposals/<id>/undo` → `undone:true`; spot-check the old
         fact is `active` again via `why`.
- [ ] Owner actions at merge (reminder only, already tracked): Google Cloud
      budget alert; key rotation from the Phase-2 ledger.
