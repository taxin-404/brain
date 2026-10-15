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
