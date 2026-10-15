# SDD ledger — plan: docs/plans/2026-10-15-brain-phase-3.md

Hub mirror: docs/superpowers/plans/. Branch: phase-3 (from master c5a11e9).

## 2026-10-15 (owner asleep; blanket approval recorded)
Owner: "finish all the phases, not only phase 2 ... you can also push, im giving you the permission".
Ruling: phases 3→6 per design v1.2 §8 are in scope for this autonomous run; each phase
gets its own plan, executes task-by-task with the standard gates, merges to master via ff,
and closes its ledger here or in a phase-4/5/6 ledger file.

## Pre-flight scan (shared interfaces)
- T1→T2: createFact gains edge linking in T2 — additive param already in T1 shape (objectEntityId) — clean.
- T1→T3: deleteFactVector + confirmFact consumed by the review engine — names/signatures match.
- T2→T3: closeFactEdges called by supersedeFact — signature matches T2 Produces.
- T3→T4: applyProposal + ReviewError codes consumed by REST handlers and the auto-apply hook — matching.
- T4→existing tests: createProposal return becomes {id, review_mode, applied} — mcp.test.ts + proposals.test.ts expectations updated inside T4.
- T3→T6: createFact(status), supersedeFact reused by the contradiction block — matching.
- T5 reads facts/fact_sources directly — no write-path dependency.
Result: no interface conflicts; no pre-flight rulings needed.
Task 1: complete (commits 0b0b678..7635e8e, tests: npx vitest run →    Duration  18.10s (transform 2.82s, setup 20.70s, import 3.00s, tests 16.05s, environment 6ms))

Task 2: Ruling: alias rows written when the mention's norm differs from the entity's norm_name (SELF/cross-norm like `taxin 404` → user) or the raw mention differs from the stored display name (case/spacing variants); exact repeats skipped — satisfies the plan's alias tests and design §6 "match against entities AND entity_aliases" — cost if wrong: a few redundant alias rows (bounded by the (entity, norm) PK).
Task 2: Ruling: object→entity matching normalizes with normalizeSubjectText (the same normalization entities were created with), not normalizeObjectText — cost if wrong: missed edges for punctuation-bearing objects.
Task 2: Ruling: disputed facts create no edge/object link (relation unverified) — cost if wrong: disputed relation invisible in the entity view until resolved.
Task 2: Ruling: entity-view edges are direction-relative (`dst` in `out`, `src` in `in`) per the test written first — cost if wrong: cosmetic API shape.
Task 2: complete (commits 5955126..58b3931, tests: npx vitest run →    Duration  20.28s (transform 2.81s, setup 24.37s, import 3.02s, tests 16.49s, environment 5ms))

Task 3: Ruling: factstore lifecycle fns (supersede/dispute/purge) throw plain Error on invariant violations (missing/non-active fact); user-facing refusals are ReviewError in review.ts — avoids the factstore←review circular import — cost if wrong: internal errors less typed (callers pre-check anyway).
Task 3: Ruling: confirm-token targets are `fact:{id}` and `event:{id}` — one mint route serves both; forget apply consumes before target lookup (single-use semantics) — cost if wrong: a 404 after token consumption requires re-minting.
Task 3: Ruling: undo of a correction closes the replacement's edge and reopens the old triple (`src+dst+rel`, invalid_at reset); edges carry no fact id — known limitation when two facts share subject+predicate+object-entity — cost if wrong: an unrelated closed edge may reopen (rare).
Task 3: Ruling: purgeFact is idempotent (skips the FTS 'delete' when object_text is already NULL, status flip guarded) — a second forget apply on a deleted fact succeeds as a no-op.
Task 3: purgeEventCore gained an actor param (default "user"); the apply path passes the proposal actor.
Task 3: complete (commits 22de655..b526e21, tests: npx vitest run →    Duration  20.78s (transform 3.05s, setup 24.80s, import 3.30s, tests 16.71s, environment 2ms))

Task 4: Ruling: accepted a function-level import cycle proposals.ts↔review.ts (proposals imports applyProposal for the auto-apply hook; review imports createProposal for the REST handlers). Both usages are call-time only, so ESM/esbuild resolve them; the alternative (a third module for handlers) contradicted the plan's file pin — cost if wrong: bundler edge cases on some toolchain (none observed: full gate green).
Task 4: Ruling: dispute tier is auto iff the fact's sensitivity is 'normal' (same safety carve-out as corrections); evidence actor is not required for disputes. Design says "dispute is always auto", the carve-out is the ledgered deviation — cost if wrong: sensitive disputes need manual approval, which is the safe direction.
Task 4: Ruling: ReviewError→HTTP mapping: not_found→404, irreversible→409, unsupported→501, all other codes→400. ProposalError (budget) → 429 over_limit / 503 breaker_open, mirroring ingest.
Task 4: handleFactReview looks up the fact first (404 unknown) and derives proposal sensitivity from the fact row (never from the body).
Task 4: mcp.ts proposalReply return widened to {created, id, review_mode, applied, error?}; auto-tier applies happen inside createProposal so MCP and REST share one path (audit actor=system, undoable).
Task 4: test note: proposals.test.ts's status=applied listing assertion relaxed from exact-equality to all-applied + membership — the shared test DB now legitimately holds auto-applied rows created by the new tests.
Task 4: complete (commits 566663e..40cf4ad, tests: npx vitest run →    Duration  24.15s (transform 2.89s, setup 29.94s, import 3.56s, tests 17.79s, environment 6ms))

Task 5: Ruling: `current` flags the version in effect (status='active'), not the requested fact — why(old) and why(new) return identical flags ("shows both versions"); a chain ending in disputed/deleted has no current flag — cost if wrong: UI relies on status instead.
Task 5: Ruling: versions sorted by learned_at ASC, tiebreak id (ULIDs are time-sortable); backward walk takes the latest superseding row per level — chains are linear in practice.
Task 5: versions carry an extra `deleted` flag (status='deleted' ⇔ object:null) beyond the brief's field list; sources rows keep the brief's shape exactly, `restricted:true` only when masked.
Task 5: tsc quirk: annotated loop vars as `VersionRow | null` — TS7022 fired on the cursor↔row inference cycle (`bind(cursor)` feeds the query whose result feeds cursor).
Task 5: complete (commits 3959118..42fc751, tests: npx vitest run →    Duration  25.45s (transform 3.08s, setup 31.54s, import 4.14s, tests 17.84s, environment 5ms))

Task 6: Ruling: counter semantics — `superseded` counts OLD facts actually superseded (one per successful supersedeFact call); `disputed` counts NEW facts inserted with status='disputed'. Both are additive fields on ExtractionRun (sweep EMPTY_RUN updated; handleExtract response picks them up automatically; health untouched).
Task 6: Ruling: rule precedence follows the plan table exactly — multivalued beats everything (even a user_stated new does not supersede on a multivalued predicate); then new user_stated supersedes; then old user_stated or exclusive predicate → disputed; else coexist.
Task 6: Ruling: a supersedeFact failure during extraction (lost race: old no longer active) is logged and skipped; the new fact stays active — worst case a benign double-active, never a failed chunk.
Task 6: Rule query only considers old facts with status='active' AND object_text IS NOT NULL AND object_text != new object (exact duplicates took the confirm path; purged rows are status='deleted' anyway).
Task 6: test change: sweep.test.ts's extraction test seeded two conflicting user_stated facts (same subject/predicate "noted", different objects) which now supersede → switched its predicate to multivalued "uses" so the sweep-wiring test stays focused (2 facts, 2 embedded).
Task 6: complete (commits 4a5f9ad..0745553, tests: npx vitest run →    Duration  21.60s (transform 2.84s, setup 25.62s, import 3.52s, tests 17.22s, environment 1ms))

Task 7: Close-out decisions (consolidated):
- Tier ruling: sensitive/restricted disputes stay manual (safety carve-out, see T4); auto-tier rows apply at creation as actor=system and stay undoable.
- Supersession vector lifecycle: superseded/purged facts lose their vector (deleteByIds) and vec_id goes NULL; undo of a correction re-embeds through the ordinary embedPendingFacts sweep — no bespoke re-embed path.
- Deterministic contradictions chosen over an LLM contradiction prompt for Phase 3 (rule table in code, zero extra LLM calls); an LLM contradiction prompt is deferred beyond phase 3 — cost if wrong: nuanced contradictions are missed until a later phase (visible via review/why, not lost).
- Entity merge deferred: Phase 3 learns aliases passively only; there is no merge/absorb flow (procedure proposals stay parked for Phase 5) — cost if wrong: duplicate entities persist until a merge flow exists.
- ForgetEval scope: the eval exercises stored-vector staleness (metadata claims active/normal; only the D1 re-check can hide forgotten facts) — that is the "cannot resurrect" guarantee.
- test/eval-forget.test.ts additionally pinned that admin search omits restricted facts unless `include_restricted=true` is passed (existing route contract), alongside the READ scope 404s.
Task 7: complete (commits 4c29bc3..3589295, tests: npx vitest run →    Duration  22.45s (transform 2.89s, setup 27.04s, import 3.85s, tests 17.52s, environment 4ms))
