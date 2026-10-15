# Phase 4 (consolidation) — ledger

Branch `phase-4` from `master` @ 52f925a (Phase 3 closed + accepted 2026-10-15).
Discipline: tests-first per task; unpiped `npx vitest run` + `npx tsc --noEmit`
before every commit; one commit per task (plan boxes ticked in the same commit);
rulings appended here as they happen; hub mirror `docs/superpowers/plans/` after
plan edits.

## Pinned at plan time (see docs/plans/2026-10-15-brain-phase-4.md)

- 4 crons: */30 sweep (existing), 0 3 * * * consolidation, 0 4 * * 1 weekly
  reflection, 0 4 1 * * monthly reflection; dispatch via exported `routeCron`.
- Merge scope: active `inferred`, non-restricted, non-multivalued predicates;
  victim must add ≥1 new evidence unit (session_id + UTC day); noisy-OR over
  units capped 0.85; one Gemini call per run; conflicts reported never applied.
- Expired `temporary` facts → archived + expired_at (+ vector pruned), cap 100.
- Reflections: window 7/30d, ≤300 facts / ≤80 events, one call, JSON insights,
  restricted never serialized, zero facts → skip without a call.
- Manual kicks POST /v1/consolidate + POST /v1/reflect (admin, single-shot).
- "Promote confirmed proposals" & entity merge stay deferred (no confirm-kind;
  no merge flow) — ruled out of scope for Phase 4.
