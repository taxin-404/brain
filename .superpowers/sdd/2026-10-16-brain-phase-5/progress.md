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
