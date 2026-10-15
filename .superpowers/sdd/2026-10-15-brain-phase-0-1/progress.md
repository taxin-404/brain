# SDD ledger — plan: /home/taxin/Work/docs/superpowers/plans/2026-10-15-brain-phase-0-1.md

Pre-flight: shared-interface scan (producer → consumer, from plan Interfaces blocks):
- T3 router contract (Handler(request, env, scope, ctx, match), json()) → T7/T8/T10/T11 route additions — match param available, wrappers may ignore trailing args — OK.
- T6 charge(db, scope, rows, now?) → T7 charge(env.BRAIN_DB, scope, newRows.length) — OK (plan corrected during self-review).
- T4 redactPayload → T7 pipeline, shape {redacted, sensitive} — OK.
- T5 encryptPayload/decryptPayload/contentHmac/newEventId → T7 (encrypt), T8 audit (newEventId), T7/T8 tests (decrypt) — OK.
- T7 ingestEvents(env, scope, entries) → T8 tombstone via ADMIN, T11 remember — OK.
- T8 writeAudit(db, entry) → T10 blocks PUT audit — OK.
- T1 ProvidedEnv augmentation → T2 adds TEST_MIGRATIONS in same declaration file — two-step, no conflict — OK.
- T12 scheduled export on default worker → test imports worker from src/index — OK.
- One cross-task overlap reviewed: T7 route /v1/events/batch vs T8 route /v1/events/:id/purge — no pattern collision (different suffixes) — OK.

Setup rulings:
- Ruling: no git worktree — the plan's Task 1 creates the repo; there is no existing workspace or branch to protect. Execution happens on branch `phase-0-1` inside /home/taxin/Work/brain; finish step merges to master. Cost if wrong: one merge-back step at the end.
- Ruling: repo created early (init + empty commit add3f50) so task-start/task-done have a BASE; this is the plan's own Task 1 `git init` moved before the failing-test run, which needs an installed vitest to observe. Cost if wrong: none.
- Ruling: wrangler.jsonc database_id placeholder "PENDING" changed to a UUID-format placeholder 00000000-... because wrangler's schema validates database_id; real id pasted in Task 3 after `wrangler d1 create`. Cost if wrong: one string replacement.
- Task 1: Ruling: ProvidedEnv augmentation → Cloudflare.Env + Cloudflare.GlobalProps.mainModule (workers-types v5 has no ProvidedEnv; tsc proved it: TS2339 exports.default). Cost if wrong: types only, no runtime effect.
- Task 1: Ruling: resolved deps are vitest 4.1.11, wrangler 4.151.0, typescript 7.0.2, workerd 1.20261012.1, @cloudflare/vitest-plugin 1.4.2 — all satisfy plan floors.
- Task 1: Ruling: plan + spec copied into brain/docs/ (plans/2026-10-15-brain-phase-0-1.md, design-v1.2.md) so the repo carries its own authority. Cost: two doc files.
Task 1: complete (commits add3f50..12bbdcf, tests: npx vitest run →    Duration  1.27s (transform 19ms, setup 0ms, import 27ms, tests 10ms, environment 0ms))
- Task 2: Ruling: TEST_MIGRATIONS binding typed by extending Cloudflare.Env (not ProvidedEnv) — same v5 rationale as Task 1. Cost if wrong: types only.
Task 2: complete (commits 12bbdcf..e38b27a, tests: npx vitest run →    Duration  877ms (transform 58ms, setup 109ms, import 33ms, tests 32ms, environment 0ms))
- Task 3: Phase 0 gate DONE — D1 brain-db (4d7130e8-65aa-4558-985e-96d38db38b30, APAC), R2 brain-raw, 5/5 remote migrations, deployed https://brain-api.taxin-404.workers.dev, 5 secrets set, curl: 401 no-token / 200 read-shape / 403 propose.
- Task 3: Ruling: prod secret values escrowed to gitignored .secrets/prod.env (chmod 600) instead of the human's password manager — mechanical best available; user must move them + delete the file. Cost if wrong: secret values sit on local disk until moved.
Task 3: complete (commits e38b27a..7ef2ee2, tests: npx vitest run →    Duration  1.04s (transform 184ms, setup 305ms, import 59ms, tests 62ms, environment 0ms))
- Task 4: Ruling: redactPayload treats sensitive KEY names (substring password|passwd|secret|api_key|token) as labels and replaces their values wholesale — the plan's regex only saw inline labels, so { password: "x" } leaked; caught by the plan's own test. Cost if wrong: none (more conservative).
Task 4: complete (commits 7ef2ee2..77d7d71, tests: npx vitest run →    Duration  1.56s (transform 127ms, setup 286ms, import 81ms, tests 91ms, environment 0ms))
- Task 5: Ruling: KeyUsage (DOM lib type) absent from workers-types v5 — local union type AesUsage used for the importKey helper. Cost if wrong: none (type-only; workerd accepts the same strings).
Task 5: complete (commits 77d7d71..c4e7cac, tests: npx vitest run →    Duration  1.69s (transform 139ms, setup 328ms, import 102ms, tests 112ms, environment 0ms))
- Task 6: Ruling (IMPORTANT, affects downstream briefs): @cloudflare/vitest-plugin 1.4.2 has NO per-test storage isolation — README claim disproved by two-test probe (write in test 1 visible in test 2; isolatedStorage option silently ignored). Model: fresh storage per test FILE, shared within a file. Budget tests re-pinned with per-test day keys (T1..T5 = 2031 days). Adaptation protocol for T7+: any brief test that asserts absolute counts or reuses keys must be made self-contained (unique ids/days per test). Cost if wrong: none once adapted; tests would flake/fail otherwise.
- Task 6: Ruling: plan's expected row order [__global__, MCP_PROPOSE] was wrong — SQLite binary collation sorts 'MCP_PROPOSE' before '__global__' ('M'=0x4D < '_'=0x5F). Test expectation corrected.
- Task 6: Ruling (process): one earlier command masked vitest's exit code via a pipe; task-done correctly refused to record. Going forward vitest runs capture $? directly before any commit.
Task 6: complete (commits c4e7cac..896f0f7, tests: npx vitest run →    Duration  1.82s (transform 142ms, setup 389ms, import 136ms, tests 118ms, environment 1ms))
- Task 7: Ruling (DESIGN): events.redacted stays 0 at ingest — it is purge-state only. The spec's update trigger permits exactly the 0->1 transition; setting it for ingest-time secret redaction would permanently block that event's later purge (data-deletion compliance). Ingest sensitivity is tracked via privacy='sensitive' + the redacted payload/excerpt themselves. Cost if wrong: an ingest-redacted row is indistinguishable from a clean row by that flag alone.
- Task 7: Adaptive changes for shared-state tests: idempotency test uses own sessions (sess-idem/sess-idem2); budget assertions use deltas. Everything else used unique ids/sessions already.
Task 7: complete (commits 896f0f7..ffceda3, tests: npx vitest run →    Duration  2.34s (transform 172ms, setup 561ms, import 110ms, tests 245ms, environment 1ms))
- Task 8: Ruling: purge implemented exactly per pinned sequence (verify+consume before load; FTS 'delete' handed old rowid+excerpt via external-content protocol; R2 delete; event_keys delete; whitelisted UPDATE; tombstone via ingestEvents ADMIN; audit last). Mid-sequence crash documented as resumable (steps individually idempotent). Test adaptations: per-test sessions; happy-path FTS assert uses its own unique term.
Task 8: complete (commits ffceda3..c8f0eb7, tests: npx vitest run →    Duration  4.71s (transform 500ms, setup 1.73s, import 350ms, tests 813ms, environment 2ms))
Task 9: complete (commits c8f0eb7..eee484a, tests: npx vitest run →    Duration  3.67s (transform 242ms, setup 1.08s, import 207ms, tests 696ms, environment 0ms))
Task 10: complete (commits eee484a..95a53e4, tests: npx vitest run →    Duration  4.03s (transform 284ms, setup 1.25s, import 240ms, tests 822ms, environment 0ms))
- Task 11: Ruling (API): `createMcpHandler(...)` 2.3.1 returns `{ fetch, close, notify, bus }` (McpHttpHandler) — call `handler.fetch(request)`; the brief's `handler(request, env, ctx)` sketch is not the shape. Cost if wrong: none.
- Task 11: Ruling (CONTRADICTION resolved): brief pinned /mcp `need: "read"`, but Task 3 pins strict propose-is-not-read (verified live in prod) and spec §11 requires the MCP_PROPOSE token to reach `remember` on the same /mcp endpoint as MCP_READ's read tools. Resolved by adding Need "any" (any valid token; per-tool gating) used ONLY by /mcp. No other route changes. Cost if wrong: MCP_PROPOSE callers get 403 on /mcp and `remember` is unreachable by design intent.
- Task 11: Test adaptation: budget assertion is a delta (shared-state file: test 3's seeds also charge MCP_PROPOSE).
Task 11: complete (commits 95a53e4..2822253, tests: npx vitest run →    Duration  7.82s (transform 2.04s, setup 13.11s, import 242ms, tests 959ms, environment 4ms))
- Task 12: Ruling (gotcha): a doc comment containing the literal cron expression `*/30 * * * *` self-terminates at `*/` — wrote the comment without the literal. Cost if wrong: none.
Task 12: complete (commits 2822253..f9b6964, tests: npx vitest run →    Duration  10.21s (transform 2.16s, setup 15.32s, import 296ms, tests 1.22s, environment 3ms))
Task 13: complete (commits f9b6964..642d0af, tests: bash -c 'npx tsc --noEmit && npx vitest run && cd plugin && npx tsc --noEmit && npx vitest run' →    Duration  180ms (transform 28ms, setup 0ms, import 40ms, tests 6ms, environment 0ms))
- Task 13: Ruling (adaptation): the brief assumed `status === "idle"`; the live API types `SessionStatus` as a tagged union — implemented `status.type === "idle"` against @opencode/plugin 2.0.29 (Plugin.define; ctx.event.subscribe({ signal }); ctx.session.context({ sessionID }); ctx.storage.{get,set,scan} with `next` pagination). Wired behavior (idle-triggered ingest, 500-per-chunk batching, ids marked only after ALL chunks 2xx, reconcile on load + every 30m) typechecks but is not runtime-tested — belongs to Task 14 acceptance. Cost if wrong: caught in acceptance.
- Task 13: Ruling: ledger/briefs were untracked (`.superpowers/sdd/.gitignore` = `*`); force-added to git so the repo carries its own execution history for future agents. Future task-n briefs need the same `git add -f` until tracked.
- Task 14: Ruling: root vitest was auto-collecting plugin/test/capture.test.ts (50 tests) after Task 13; added `include: ["test/**/*.test.ts"]` to root vitest.config.ts so the worker suite (47) and the standalone plugin suite (3) stay independent. Cost if wrong: a future test outside test/ silently uncollected — the README documents both commands.
- Task 14: Step 2 done — deployed brain-api version 48831e2c-e4b9-4a7a-8ff0-1e17fcb34a47 with schedule */30 * * * * registered; remote migrations up to date.
