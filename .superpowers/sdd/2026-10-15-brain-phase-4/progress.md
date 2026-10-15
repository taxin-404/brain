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

Task 1: Ruling: expireFact/mergeFacts throw plain `Error` on invariant violations (consistent with supersedeFact/disputeFact; these are system-internal, not user-facing).
Task 1: Ruling: expire is soft — text + FTS row stay (why keeps provenance); the vector is pruned (design §9 "consolidation must demonstrably prune" = stored dims).
Task 1: Ruling: mergeFacts is bookkeeping only — noisy-OR lives in consolidate.ts which owns evidence-unit knowledge; mergeFacts re-clamps at 0.85 as a belt; audit 'merge' on the survivor with reason "merged <victimId>", victim's supersede audit comes from supersedeFact.
Task 1: Ruling: first_seen_at via coalesce to last_confirmed_at (createFact always sets both; null-safe anyway).
Task 1: complete (commits 9962fdd..5ae4405, tests: npx vitest run →    Duration  22.93s (transform 2.90s, setup 28.07s, import 3.81s, tests 17.68s, environment 7ms))

Task 2: Ruling: same-unit-only groups are filtered BEFORE the call (no value in asking), and the victim-adds-≥1-new-unit guard re-checks post-model using ORIGINAL unit sets (deterministic; the survivor's post-merge source growth does not retroactively enable a skip).
Task 2: Ruling: skip/apply guards are silent-logged into `report.skipped[]` (first-wins on victims; a victim can merge once per run; chains resolve by processing order). Conflicts counted + reported, never applied.
Task 2: Ruling: only LlmError degrades the run (degraded:true, expiry kept, run row + audit always written); non-LLM errors rethrow so genuine bugs surface (cron wrapper will log them).
Task 2: Ruling: bind-param safety — evidence-unit query chunks ids in batches of 90 (D1 bound-parameter ceiling); caps stay ≤200 facts/run.
Task 2: Ruling: idempotence test asserts no re-merge of the same pair (merged 0, victim stays superseded) rather than "zero calls" — sibling tests in the shared DB can legitimately leave other candidate groups for later runs. Zero-call-when-empty is covered by the expiry-only test.
Task 2: Prompt: spec §6 [CONSOLIDATION] text verbatim + a JSON interface appendix (input shape, output shape, ids-only rule) — same pattern as the Phase-2 FACT prompt additions.
Task 2: complete (commits 4e691c3..7fe9007, tests: npx vitest run →    Duration  24.72s (transform 2.99s, setup 29.59s, import 4.19s, tests 19.45s, environment 2ms))

Task 3: Ruling: reflection window is bounded on both ends — facts with `learned_at BETWEEN start AND end`, events with `ts BETWEEN start AND end` (a period's reflection covers what was learned inside the period, not older facts re-confirmed recently). Empty facts → `{skipped:true, id:null}` with no LLM call and no row; degraded runs still store the row (empty insights JSON) because they carry audit value.
Task 3: Ruling: insight post-validation — trim text, intersect ids with the sent set, dedupe; drop insights with empty text or no valid ids; cap 5; if zero survive → degraded:true (model produced nothing usable), row still stored.
Task 3: Ruling: `reflection_sources` gets one row per unique fact id across surviving insights (event_id NULL — evidence linkage is fact-level in v1).
Task 3: Ruling: latest-route test determinism — created_at ties broken by id made "newest" random under a shared DB; test now creates a strictly-newer run instead of trusting ordering. Route itself keeps `ORDER BY created_at DESC, id DESC`.
Task 3: Prompt: spec §6 [REFLECTION] text verbatim + JSON interface appendix (input shape, output shape, ids-from-input rule) — same Phase-2 pattern.
Task 3: complete (commits 6370b0a..2732c89, tests: npx vitest run →    Duration  25.27s (transform 2.98s, setup 30.68s, import 4.56s, tests 19.78s, environment 7ms))

Task 4: Ruling: `routeCron` maps exact trigger strings; unknown triggers log `[cron] unknown trigger` and no-op (a dashboard-added cron never runs the wrong work). The scheduled body wraps every job in try/catch (log-only) so a cron never dies silently; `ctx.waitUntil` keeps the invocation alive.
Task 4: Ruling: cron mapping covered by unit tests; wrangler.jsonc trigger list verified by grep in the gate (workerd test env cannot read config files) — drift between config and mapping caught by the exact-string tests.
Task 4: Ruling: weekly = "0 4 * * 1" (Mon 04:00 UTC), monthly = "0 4 1 * *" (1st 04:00 UTC), consolidation "0 3 * * *" — 4 of the 5 free slots; one slot left spare.
Task 4: complete (commits 53cc77c..bb31732, tests: npx vitest run →    Duration  26.28s (transform 3.00s, setup 31.55s, import 4.82s, tests 19.81s, environment 5ms))

Task 5: Ruling: health additions are purely additive — `consolidation.last_run` {id, finished_at, merged, superseded, conflicts, pruned} (newest by finished_at, id tiebreak) and `reflections` count; existing keys untouched so MCP health_report and auth-shape assertions keep passing (verified: full suite green).
Task 5: complete (commits aed5737..47b8c07, tests: npx vitest run →    Duration  26.63s (transform 2.98s, setup 32.60s, import 4.97s, tests 19.85s, environment 4ms))

Task 6: Ruling: the eval is a regression pin (written after implementation), so RED does not apply — plan step noted honestly. It fixes the design §8 "done when" sentence in code: cross-unit duplicates only (same-unit pair neither sent nor merged), tombstones honored (deleted row stays NULL, FTS empty, id/object absent from the prompt), restricted never serialized (id and text absent), vectors pruned (store shrinks for the superseded victim + the retired temporary fact), run + report recorded.
Task 6: complete (commits 5675f86..08e1937, tests: npx vitest run →    Duration  27.22s (transform 3.06s, setup 33.79s, import 5.16s, tests 19.85s, environment 6ms))

Task 7: Close-out. Full gate green: 33 files / 198 tests, tsc clean. README gains the Phase 4 section (crons, retirement, consolidation rules, reflections, routes, health, eval), the read-first map gains the phase-4 plan + this ledger, layout + progress rows updated. Hub mirror refreshed. Deferred with reasons (ledgered in plan): "promote confirmed proposals to user_stated" (no confirm proposal kind exists) and entity-merge consolidation (no merge flow / alias-union semantics defined) — both noted in the plan's pinned decisions. Merge + acceptance boxes stay unticked until the post-merge single-shot acceptance pass.
Task 7: complete (commits 4598b37..3ef65ce, tests: npx vitest run →    Duration  27.25s (transform 2.98s, setup 33.83s, import 5.34s, tests 19.80s, environment 1ms))

Acceptance (2026-10-16, post-merge, single-shot): all four steps green (see plan closing section for ids). Notes: (a) consolidate legitimately found no candidates on live data (5 active inferred facts, zero ≥2-groups, zero lapsed temporaries) — no model call spent, run row recorded; the 20 pending extractions will feed later nightly runs; (b) live model returned 2 reflection insights — the ledgered 1–8/trim-5 tolerance accepted them (spec text says 3–5; we do not manufacture insights to hit a range); (c) one push produced TWO builds for the same commit (duplicate webhook delivery), both success; harmless but it doubles build minutes — if it repeats on the next push, check the GitHub App delivery log.
