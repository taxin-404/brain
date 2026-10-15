# Phase 5 (procedural) — ledger

Branch `phase-5` from `master` @ 4bdf2c3 (Phase 4 closed + accepted 2026-10-16).
Discipline: tests-first per task (watch RED); unpiped `npx vitest run` +
`npx tsc --noEmit` before every commit; one commit per task (plan boxes in the
same commit); rulings appended here; hub mirror `docs/superpowers/plans/` after
plan edits. No new model calls, cron entries, secrets, or migrations this phase.

## Pinned at plan time (see docs/plans/2026-10-16-brain-phase-5.md)

- Payload: name/steps/trigger/tools/success_criteria/failure_notes/procedure_id/
  reason/evidence_event_id; caps name 120, steps 50×500, trigger 2000, tools 50,
  criteria/notes 2000.
- Trust on origin: external evidence hard-refuses (`untrusted_origin`, 400,
  nothing written); else origin_trust = event trust; no evidence → 0.5 neutral.
- Promotion: create draft v1 or append v N+1; any new version flips approved
  back to draft (fresh approval per version); deprecated refuses; audit
  `approve`/target procedure; promoted_from_events = JSON array.
- Approval gate: POST /v1/procedures/:id/approve ADMIN-only, not an MCP tool
  (agent cannot self-approve, 403); undo for procedure proposals refused
  (manual tier; versions are append-only).
- Read routes: GET /v1/procedures + GET /v1/procedures/:id (read scope).
- Procedures not embedded/searched this phase (done-when doesn't require it).

Task 1: Ruling: validation caps pinned in code (name 120, steps 1–50 ×500, trigger 2000, tools 50, criteria/notes 2000); all validation failures are ReviewError("conflict") → 400 — consistent with block_edit. ReviewError gains code `untrusted_origin` (→ 400 via the default mapping).
Task 1: Ruling: `promoted_from_events` stores a JSON array (`[eventId]`) or NULL when no evidence — column is plural by design and future promotion flows may cite several events.
Task 1: Ruling: no-evidence procedures get `origin_trust = 0.5` (neutral/conservative); evidence-based promotion carries the event's trust; external is a hard refuse with nothing written (no audit, proposal stays pending).
Task 1: Ruling: versioning is append-only; a deprecated target refuses new versions; `last_success_at` stays reserved (no execution tracking this phase). Undo for procedure proposals is refused (`unsupported`) in undoProposal.
Task 1: The old Phase-3 placeholder test in test/review.test.ts ("unsupported until Phase 5") was replaced with the real promotion assertion — expected change, not a regression workaround.
Task 1: module cycle note: procedures.ts ↔ review.ts import each other (ReviewError / promoteProcedureProposal); safe like the existing proposals↔review cycle because usages are call-time only.
Task 1: complete (commits de88827..0bd3ffa, tests: npx vitest run →    Duration  28.17s (transform 3.05s, setup 34.85s, import 5.27s, tests 19.90s, environment 8ms))

Task 2: Ruling: approve route status mapping — not_found→404, conflict→409, else 400 (dedicated mapping in procedures.ts; the generic proposal-review mapping keeps conflict→400 for apply, which is fine because the apply refusals there are payload-level).
Task 2: Ruling: audit action for the gate is `approve_procedure` (distinct from the promotion audits action `approve`/target procedure); actor `user`.
Task 2: Ruling: apply of an external-evidence procedure proposal through the generic REST route surfaces 400 `untrusted_origin` automatically via the existing ReviewError mapping.
Task 2: gotcha: shared-DB test files accumulate state — name-matching versioning means test procedures must use unique names per test or later applies silently target earlier (possibly deprecated) rows.
Task 2: complete (commits 5db9b1d..481822e, tests: npx vitest run →    Duration  28.00s (transform 3.04s, setup 34.74s, import 5.27s, tests 20.04s, environment 7ms))
