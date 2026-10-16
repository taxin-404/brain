# SDD ledger — plan: docs/superpowers/plans/2026-10-16-any-ai-provider.md

Spec: docs/superpowers/specs/2026-10-16-any-ai-provider-design.md (authored this session; full text in session context). Plan committed at 34be8d4. Executor: inline (executing-plans).

Branch ruling: working directly on **master** — this repo's sole-owner workflow for every prior phase/session (no branch/PR culture; pushes are the owner's verification path; the feature push happens only at Task 7). Cost if wrong: revertible unpushed commits; single-developer repo.

## Pre-flight scan (shared interfaces)

- T1 → T2/T3/T5: `chatConfig` / `embedConfig` / `embeddingSignature` names + shapes match every consumer (T2 uses `cfg.mode|base|key|model|fallback`; T3 uses `cfg.model|dims|dimsExplicit`; T5 both) — clean.
- T2 → T3/T4/T5: `setEnvVars(vars)` name/shape consistent; `postCompatJson(target, path, body)` is generic enough for `/embeddings` — clean.
- T2 rename `llmJson` consumed by T4's `extract.ts` edit (import already renamed by T2, T4 wraps the embed call) — clean.
- T4 `installFakeVectorize({ dims })` consumed only by T4 tests — clean.

Pre-flight: no blocking conflicts.

## Tasks

- [x] Task 1 — AI config resolution + env surface
- [x] Task 2 — OpenAI-compatible chat + `llmJson` rename
- [x] Task 3 — OpenAI-compatible embeddings
- [x] Task 4 — Signature-aware backfill + index guard
- [x] Task 5 — Health: report the AI wiring
- [x] Task 6 — Bindings chart + docs
- [ ] Task 7 — Push, live verification, ledger

## Log

Setup ruling: all tasks execute RED→GREEN (test written and watched failing before its implementation), per the TDD sub-skill; the plan lists implementation/test steps in narrative order — process order only, no interface change. Cost if wrong: none (same artifacts, tests-first).
Task 1: complete (commits 34be8d4..abfc57e, tests: npx vitest run →    Duration  36.97s (transform 3.23s, setup 42.47s, import 5.83s, tests 35.29s, environment 6ms))
Task 2: complete (commits abfc57e..1eb4ce2, tests: npx vitest run →    Duration  38.71s (transform 3.32s, setup 43.76s, import 6.10s, tests 38.47s, environment 11ms))
Task 3: complete (commits 1eb4ce2..73258c6, tests: npx vitest run → 263 passed, 39 files; npx tsc --noEmit clean)

Task 4 rulings: (a) dropped the planned NULL->signature stamp + its test: migrations/0002 defines embedding_model TEXT NOT NULL from the first schema (UPDATE to NULL fails SQLITE_CONSTRAINT_NOTNULL), so the planned state is unreachable; legacy pre-signature rows are exactly the bare model name, counted current by the ?1 bind and re-embedded on a model switch via ?2. If wrong: stray NULLs would still be re-embedded via the vec_id IS NULL arm. (b) Vectorize describe returns config.dimensions (union with preset per @cloudflare/workers-types, verified) - the plan wrote info.dimensions; guard now reads 'dimensions' in info.config and skips the check for preset indexes. (c) Rows from earlier tests in the same file are visible (a previous test's failed fact showed up as extra pending), so the new tests flush pending facts first and pin other vectors to the target signature; counts stay deterministic.
Task 4: complete (commits 73258c6..84d12b8, tests: npx vitest run →    Duration  37.82s (transform 3.38s, setup 46.33s, import 6.49s, tests 30.35s, environment 5ms))
Task 5: complete (commits 84d12b8..18cd992, tests: npx vitest run →    Duration  60.22s (transform 4.77s, setup 70.96s, import 12.05s, tests 42.50s, environment 9ms))
Task 6: complete (commits 18cd992..6742b8e, tests: npx vitest run →    Duration  44.19s (transform 3.80s, setup 55.90s, import 8.13s, tests 32.93s, environment 9ms))

Final review (fresh context, package review-34be8d4..6742b8e.diff): BLOCKING, 3 findings. (1) bare legacy model name was exempted at ANY dims, so a dims-only switch silently skipped pre-signature rows and health reported backlog 0 (spec says bare counts as @768 only); fixed in embed.ts + health.ts - the ?1 bare exemption now binds only when the resolved config is the pristine default (model=gemini-embedding-001 AND dims=768), else NULL (column is NOT NULL, so the predicate reduces to the signature check). (2) empty AI_EMBED_BASE_URL fell through to the native path instead of inheriting AI_BASE_URL and empty AI_EMBED_DIMS threw; fixed via firstSet and dimsSet (dimsExplicit now tracks '' as unset). (3) Vectorize describe() shape is runtime-version dependent (config.dimensions on older deployments, top-level dimensions on newer); added readIndexDims() tolerating both, preset -> null. Fix commit: 29bb344 (5 new tests, RED watched first).

## Close-out

| Task | Commit | Subject | Gate |
| --- | --- | --- | --- |
| 1 | `abfc57e` | feat(llm): resolve AI provider config from env (Gemini default, compatible option) | 249 green + tsc |
| 2 | `1eb4ce2` | feat(llm): route chat through any OpenAI-compatible provider when AI_BASE_URL is set | 258 green + tsc |
| 3 | `73258c6` | feat(llm): route embeddings through any OpenAI-compatible provider (native default) | 263 green + tsc |
| 4 | `84d12b8` | feat(embed): signature-aware backfill with an index-dims guard | 267 green + tsc |
| 5 | `18cd992` | feat(health): report the resolved AI wiring and the re-embed backlog | 270 green + tsc |
| 6 | `6742b8e` | docs: document running on any OpenAI-compatible provider | 270 green + tsc |
| fix | `29bb344` | fix(llm): legacy rows count current only at the default dims; empty AI_* means unset | RED→GREEN (5 tests) + tsc |

Review: fresh-context over `34be8d4..6742b8e` → BLOCKING (1 major + 2 minor); fix `29bb344`; focused re-review over `6742b8e..29bb344` → CLEAR, no new findings.

Rulings if wrong (cost): the dims-guard throws config errors on a mismatch instead of embedding anyway (worst case: embedding silently paused until AI_EMBED_DIMS is fixed — visible in /v1/health-report); the extract try/catch logs `[embed] skipped:` and keeps extraction green (worst case: one sweep's embeddings deferred); empty-string envs behave as unset (worst case: a dashboard var set to "" is ignored rather than rejected).

Push (plan `34be8d4` + tasks 1-6 + fix `29bb344` + this ledger commit): verification appended below after watching the push.
