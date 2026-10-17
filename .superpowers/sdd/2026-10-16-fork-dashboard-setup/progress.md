# Fork dashboard auto-setup — thread ledger

Goal: brain forks deploy + configure entirely from the Cloudflare dashboard (NodeWarden-style, no terminal).
Reference: `taxin-404/nodewarden` (fork of shuaiplus/NodeWarden) — clone for study at `/tmp/opencode/nodewarden`.

## Verified 2026-10-16 — live probes, account 1ce49401…, throwaway names, all cleaned up

### Resource provisioning (wrangler 4.151.0, `wrangler deploy`, prod resources untouched)
- **D1 fresh**: id-less binding `{binding, database_name}` with missing DB → auto-created at deploy with the exact configured name (`scratch-probe-a-db`).
- **D1 existing-name**: pre-created `scratch-probe-b-db` (id `43b00efb-…`), id-less deploy → binds it, no duplicate, no error. ⇒ dropping `database_id` from brain's `wrangler.jsonc` is safe: next prod deploy re-links `brain-db` by name.
- **D1 redeploy**: id-less config again → binding shows `(inherited)`, no duplication, no re-provision.
- **R2**: id-less `{binding, bucket_name}` with missing bucket → auto-created at deploy, exact name.
- **Vectorize**: NOT auto-provisioned. Deploy with missing index fails hard, code `10159` (`Vectorize binding references index ... not found`). ⇒ forks need an ensure-script (NodeWarden `scripts/ensure-kv.cjs` pattern) creating `brain-memory` (768/cosine) + metadata indexes (`type`, `status`, `sensitivity`) before deploy. OPEN: Workers Builds deploy-runner permissions for Vectorize ops → fresh-account test.
- **No write-back** of resource IDs into wrangler config (changelog claims it; not observed in 4.151). Repo config stays id-less; linkage persists server-side.

### Deletion semantics (user reported: deleting nodewarden also deleted its r2/d1/kv)
- Classic `wrangler delete` on probe workers → D1 + R2 **survived**.
- New beta endpoint `DELETE /accounts/{id}/workers/workers/{name}` (docs: "delete all associated resources (versions, deployments, etc.)") → succeeded (worker + versions/deployments gone, 404 after), D1 + R2 **survived**.
- NodeWarden FAQ agrees: deleting the Worker / redeploying does not delete persistent data; manual D1/KV deletion required for a clean slate.
- What IS deleted with the worker: versions, deployments, Durable Object namespaces (per API docs).
- Account state at time of check: nodewarden still deployed, HTTP 200; `nodewarden-db` + `nodewarden-attachments` (both Oct 7) intact.
- OPEN: exact dashboard delete UI (any opt-in cleanup step?) and Workers-Builds-project delete flow → pin on fresh-account test.

### Misc
- brain uses no KV. Account has one unrelated KV namespace titled `KV` (id `2226aca4…`) — leave alone.
- Scratch dirs `/tmp/opencode/probe-{a..e}`; all scratch workers/D1/R2 deleted after tests; prod verified intact (`brain-db`, `brain-raw`, `brain-memory`).

## Design + plan — written 2026-10-16

- Spec: `docs/superpowers/specs/2026-10-16-fork-dashboard-setup-design.md`
- Plan: `docs/superpowers/plans/2026-10-16-fork-dashboard-setup.md`
- Execution: inline (executing-plans), working directly on **master** — ruling: same sole-owner workflow as every prior cycle (pushes are the owner's verification path; cost if wrong: revertible unpushed commits on a single-developer repo). TDD per task; gate = full `npx vitest run` + `npx tsc --noEmit` before every commit.
- New evidence this session (single-shot prod read): `d1_migrations` schema is `(id INTEGER PK AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`, rows exactly `0001_events.sql`…`0006_extractions.sql` (same names/table `readD1Migrations` + `wrangler d1 migrations apply` use) ⇒ runtime bootstrap is provably a no-op on prod. `secrets.required` deploy-blocking confirmed in wrangler 4.151 dist ("Missing required secrets: …"). `auth.ts` hazard confirmed: with a token unset, literal `Bearer undefined` matches ADMIN (fix in T3).

### Pre-flight scan (shared interfaces)

- T1 → T2: `migrations.generated.ts` `{name, queries[]}` is consumed by `bootstrap.ts` + tests; both sides derive from the same `readD1Migrations` — clean.
- T2 → vitest setup: `ensureSchema(env.BRAIN_DB)` mirrors the plugin's `applyD1Migrations(env.BRAIN_DB, TEST_MIGRATIONS)` call shape — clean.
- T2 → prod: `d1_migrations` table/names verified equal to prod's — no conflict.
- T4 → docs: fallback constant `https://generativelanguage.googleapis.com` must appear verbatim in README — pinned.
- T5 → T7: deploy command string `npm run deploy` used identically in package.json, Builds API PATCH, README — single source, clean.
- T5 → prod: `AI_GATEWAY_BASE` var→secret needs an explicit var-removal step: `keep_vars: true` keeps the stale config var through ordinary deploys, and `secret put` is rejected with `10053` while a plain-text binding lives (executed live in T7; the direct-Google fallback covers the window).

## Tasks

- [x] T1 — embed-migrations pipeline (+ sync test) — `c7ccee7` (276 green + tsc)
- [x] T2 — runtime bootstrap (+ fresh-DB test, setup swap, wiring) — `96cf466` (279 green + tsc)
- [x] T3 — auth guard (`Bearer undefined`) — `1e657ef` (280 green + tsc)
- [x] T4 — direct-Google fallback (`AI_GATEWAY_BASE` optional) — `a9b1519` (281 green + tsc)
- [x] T5 — ensure-vectorize + wrangler config + prod prep — `8cc4cc5` + `7afa737` (281 green + tsc)
- [x] T6 — docs (README/setup/engineering/CONTRIBUTING) — `8fc4e20` (281 green + tsc)
- [x] T7 — ledger, push, verify (owner-only items remain: fresh-account e2e + KEK escrow deletion)

## Log

- T1 `c7ccee7`: `scripts/embed-migrations.mjs` → `src/migrations.generated.ts` (6 migrations, 29 queries) + sync test (regenerates and diffs); `npm run migrations:embed`. Baseline pre-T1: 275.
- T2 `96cf466`: `src/bootstrap.ts` `ensureSchema` — WeakMap-memoized per D1 binding, failure cleared for next-request retry; boot batch `[CREATE TABLE IF NOT EXISTS d1_migrations, SELECT name]`, per-migration `db.batch([...queries, INSERT name])` (atomic: crash ⇒ rolled back ⇒ retried), race loser re-checks `SELECT name WHERE name=?1` and continues. Wired into `src/index.ts` fetch (log + 503 `server not ready: schema bootstrap failed`) and scheduled. `test/apply-migrations.ts` boots through `ensureSchema`; `vitest.config.ts` gained `MIGRATION_DB` for the virgin-DB test. All 40 files now boot the fork's real path; setup time ~62s → ~2s.
- T3 `1e657ef`: RED pinned the hazard — with tokens unset, literal `Bearer undefined` authenticated as ADMIN (200). Fix: `env.X && header === ...` guard in `resolveScope`.
- T4 `a9b1519`: `GEMINI_DIRECT_BASE = https://generativelanguage.googleapis.com` + `nativeBase(env) = env.AI_GATEWAY_BASE || GEMINI_DIRECT_BASE` at all three native sites (`chatConfig`, `embedConfig`, `postJson`); `env.ts` `AI_GATEWAY_BASE?: string`. RED: chat + embed fallback tests.
- T5 `8cc4cc5` + `7afa737`: live evidence (single-shot each): no-op vs live `brain-memory`; scratch `scratch-vec-check` create → `vectorize get` 768/cosine → re-run reuses (metadata eventual-consistency exercised the already-exists tolerance) → deleted, account clean; bogus-token run → "could not verify" warn + exit 0 (never blocks a deploy). `firstLine` now surfaces wrangler's stderr, not execFileSync's generic message. Dry-run (`--env=""`): id-less D1 resolves by name, bundle OK, all three bindings listed.
- T5 prod prep: Builds trigger `deploy_command` → `npm run deploy` (verified via `GET /builds/workers/$TAG/triggers`; the update path is `PATCH /builds/triggers/$TRIGGER` — **no** `/workers/$TAG` segment). **10053 discovery**: `secret put AI_GATEWAY_BASE` is rejected while the plain-text var is live ⇒ secret put moved to post-push; spec/plan amended.
- T6 `8fc4e20`: README quick deploy is now dashboard-only (fork → connect with `npm run deploy` → red build → six secrets → Retry); removal section (incl. deleting the Worker deletes `PAYLOAD_KEK` — escrow matters); CLI flow rewritten; setup.md §1/§2/§6/§10; engineering.md deploy command + fork-safe config + 10053 + Builds PATCH recipe; CONTRIBUTING repo anatomy; maintenance.md CI map; package.json bindings. Stale-reference sweep clean (historical plans/specs left as-is; `design-v1.2.md` untouched by design).
- T7 push `a2fe536`: CI [38925972678](https://github.com/taxin-404/brain/actions/runs/38925972678) ✓; Workers Builds `a377127f` ✓ — first prod build via `npm run deploy` (ensure-vectorize no-op in the runner; version `5d9f7958`; bindings BRAIN_DB `(inherited)` + VECTORIZE + BRAIN_RAW; 4 crons re-registered; log tail: "Success: Deploy command completed").
- T7 gateway var→secret (live, single-shot each): settings read showed `AI_GATEWAY_BASE: plain_text` still on the worker — `keep_vars: true` kept the stale config var, so prod stayed gateway-routed the whole time. Executed the move anyway (secrets are deployment-proof by design): one local `keep_vars:false` deploy (version `1ecac4e5`; worktree flip reverted in the same shell) → binding gone from settings → `secret put AI_GATEWAY_BASE` ✓ (settings: `secret_text`). Smoke after: 4019 events, `ai.chat` native, `ai.embed.matches_index` true, budget fine.
- T7 fresh-context review (`256a054..dae8a1c`, verdict "With fixes", **no code defects**): I1 — docs quoted a wrangler dev-only string; the deploy path says `The following required secrets have not been set: …` (verified in installed `cli.js:176351/176375`) → fixed in README/setup/spec/plan. M1 — first-deploy provisioning order (a fresh deploy dies on secrets before upload; only the Vectorize index is created by the failing run; D1/R2 come with the retry) → README fixed. M2 — `.dev.vars.example` still forced a gateway URL → now the optional commented form. M3 — bootstrap failures name the failing migration in the 503 log (`cause` preserved) + §10 recovery hint. M4 — two new tests: plugin-apply→ensureSchema replay no-op (`REPLAY_DB`) and failure→fix→retry memo-clear (`BROKEN_DB`); vitest.config gained both bindings. M5 — `nativeBase` strips trailing slashes (+llm test). Reviewer strengths: byte-equivalent `d1_migrations` DDL, batch atomicity + race re-check verified against installed plugin/wrangler sources, ensure-vectorize posture.
- T7 review fixes committed: `2540c70` (replay/memo tests) → `1e62b80` (llm slash) → `078bcd9` (bootstrap error context) → `97d00bb` (docs quotes/order) → `5cab52f` (ledger). Gate: 284 green + tsc. Push `a2fe536..5cab52f` (7 commits).
- T7 final push verified: CI [38998209501](https://github.com/taxin-404/brain/actions/runs/38998209501) ✓ on `5cab52f`; Workers Builds `569fc917` ✓ (2nd prod build via `npm run deploy`). Smoke (single-shot): `/v1/health-report` 200 — chat native `gemini-3.5-flash-lite`, embed `matches_index: true`, backlog 0, events 4207 (budget window fresh day: 315 used); `/v1/search` 200 with live results.
- T7 owner fresh-account e2e, first build (user-run 2026-10-17 03:27Z): build command green (284 tests / 40 files on the runner); `npm run deploy` created the Vectorize index + `type`/`status`/`sensitivity` metadata indexes, provisioned D1 `brain-db` + R2 `brain-raw` (id-less D1 + R2 auto-provision verified live on a fresh account), then failed red with exactly `The following required secrets have not been set: ADMIN_TOKEN, CONTENT_HMAC_KEY, GEMINI_API_KEY, MCP_PROPOSE_TOKEN, MCP_READ_TOKEN, PAYLOAD_KEK` + `wrangler secret put` guidance — `secrets.required` verified live end-to-end. Docs corrected from observation: README step 2 provisioning order (the failing run provisions everything — reviewer M1 held for the CLI flow only) and the CLI flow (fresh account: `secret put` impossible before the worker exists; first deploy via `--secrets-file`; wrangler `workerExists=false` branch, cli.js:176346); setup.md §3/§4/§6A, engineering.md, spec updated.
- T7 remaining: complete the e2e (six secrets → Retry → health zeros; then pin the dashboard delete-flow wording); KEK escrow deletion still held. Reviewer declined-to-judge list (dashboard wording pins, live Vectorize token matrix, prod var→secret state) is ledger-covered or owner-pending.

Open item carried: fresh-account end-to-end test (owner creates account; connects fork; red build → six secrets → retry → health; delete-flow wording pin).

## 2026-10-17 — default-minimal secrets (owner directive: "lets make defaults")

- Directive: owner wants fewer envs after the fresh-account burden ("why is all
  the envs i have to remember?"). Ruling: the minimal setup is the three values
  that cannot be defaulted (KEK, ADMIN_TOKEN, GEMINI_API_KEY); the other three
  become optional with working defaults. Direct execution, no design-Q&A
  (standing owner preference).
- `79b620c` feat(secrets): `contentSigningSecret` — HMAC-SHA256(KEK,
  `brain/content-hmac/v1`), derived only when `CONTENT_HMAC_KEY` is unset
  (deterministic per KEK; explicit value always wins). Call sites:
  `ingest.ts:113`, `exporter.ts:128/549` (mint + verify). `env.ts`: the three
  become optional with contract comments. `wrangler.jsonc`: `secrets.required`
  → `PAYLOAD_KEK, ADMIN_TOKEN, GEMINI_API_KEY`. Migration 0001 `content_hmac`
  comment refreshed (comment-only) + `migrations:embed` regen. Tests (RED
  first): crypto derivation (deterministic / KEK-sensitive / never the raw KEK
  / explicit wins), auth minimal-env pin (admin is the only credential; literal
  `Bearer undefined` stays 401), ingest dedupe under the derived secret; the
  export expired-token fixture re-derives through the helper. Gate: **287
  green (40 files) + tsc clean**.
- `f6deeff` docs: README (step 3, envs table defaults, FAQ, CLI comment),
  setup.md §3 (required three generated, hardening trio commented; warning
  that an empty `GEMINI_API_KEY` still counts as set for `--secrets-file`;
  required/optional loops split so the optional three are set only when
  present), §4/§6A/§10 wording, §7 minimal client config (`ADMIN_TOKEN` in all
  three places), engineering.md (the `resolveScope` non-empty guard is now
  load-bearing, not defense in depth), key-rotation.md (with derived signing,
  KEK rotation also changes content keys + invalidates export links),
  package.json binding descriptions, .dev.vars.example note, spec amendment 7
  (incl. "setting CONTENT_HMAC_KEY later changes content keys" ordering note).
- Prod impact: none by construction — all six are set there, so the explicit
  HMAC path and token matching are byte-identical; the required-list change is
  deploy-time only. Next prod build ships the new bundle (watch CI + build +
  one health smoke). Fresh-account e2e: on a synced fork the retry now expects
  three names, not six; the six-name error already seen belongs to the old
  config.
- 2026-10-17b, owner directive "set empty envs on deployment, for more easy way":
  second ease-up of the day. Literal empty secret values rejected (empty KEK =
  guessable encryption key; empty plain-text vars = 10053 trap later); instead
  the deploy-time gate is gone and the worker self-reports. `ea4a62d`
  feat(config): wrangler.jsonc drops `secrets.required`; `missingRequiredSecrets`
  (env.ts) gates every route with 503 `{"error":"not configured","missing":[…]}`,
  readable without credentials, until PAYLOAD_KEK + ADMIN_TOKEN are non-empty;
  crons skip with a log line; AI key is a hint, never a gate; ensureSchema runs
  only once configured. New `test/config.test.ts` (4 tests) + auth unset-token
  test reworked (503 at HTTP level, direct `resolveScope` unit pins). Gate:
  291 green (41 files) + tsc. CLI gain: `--secrets-file` retired — deploy first
  (green, provisions everything), then `secret put`. Docs `3549979` sweep:
  README/setup/engineering/SECURITY/spec amendment 8. Next: push, watch
  CI + build, prod smoke (prod configured ⇒ gate passes, behavior unchanged).
- 2026-10-17b verified: push `3efac5c..232771f`; CI [39001718757] ✓ (1m17s);
  build `55f5add0` ✓ — prod shipped the runtime gate and passes it (all secrets
  configured): health 200, no-auth 401 as before. Fresh-account e2e simplifies:
  fork sync → Retry → **green with zero secrets** → 503 checklist → set three →
  200. Owner pending: run that on the fresh account; KEK escrow deletion still
  held.
- 2026-10-17c fresh-account e2e COMPLETE (owner-driven, tes1ing account
  d5d15d42e8e4fd5a159feb81ae38f036, renamed from testing-404 mid-run):
  - First two attempts exposed a real-world failure mode the docs didn't
    cover: dashboard plain-create (source `dash`, 04:24:51, then 04:49-04:50
    recreate) ships a placeholder worker with zero bindings and no build
    config (Builds API 12040) — audit-logs diagnosed via `cf` CLI. Fix pushed
    to the owner: delete placeholder; create via **Continue with GitHub**
    import path.
  - Import attempt: build command green **291/291 (41 files)** but deploy
    failed — `npm ruun deploy` typo in the dashboard deploy-command field.
    Owner fixed the field; retry deployed green.
  - Provisioning confirmed via cf: D1 `brain-db`, R2 `brain-raw`, Vectorize
    `brain-memory` created by the deploy; secrets `[]` (amendment 8 working
    as designed); `/health` (no auth) 503 `{"error":"not configured",
    "missing":["PAYLOAD_KEK","ADMIN_TOKEN"],…}` — the self-checklist is the
    envs instruction.
  - Owner generated the pair themselves (openssl), escrowed locally at
    /home/taxin/Work/.secrets/tes1ing.env (owner decision: NOT committed to
    the repo — local-only per repo-wide escrow discipline; chat-paste of
    test values accepted, prod values remain file→dashboard only). Set in
    dashboard by owner.
  - Verified: `/v1/health-report` no-auth = `unauthorized`; Bearer new
    token = **200**. OpenCode client rewired to the test server
    (mcp.brain, mcp.brain-propose, capture plugin → tes1ing URL +
    ADMIN_TOKEN; backup opencode.json.bak-testing-20261017-113419;
    restart needed to load). Prod untouched.
  - Docs gap fixed from this run: `56c5838` — README + setup.md §3 now state
    which values get reused by the AI client (store-before-paste narrative).
  - Net status: the full fork story is now verified end to end on a fresh
    account with **two** secrets and a worst-case first-run (wrong create
    path + typo'd deploy command). No config changes required at any point.
- 2026-10-17d token hygiene: owner revoked stray API/build tokens in the
  dashboard (2× orphan `brain build token` with no namesake worker anywhere;
  one-shot `brain-builds-setup`; dupe within the tes1ing `brain-api build
  token` pair [API showed exactly 2 on d5d15d42 via new cloudflare MCP
  (single-account-scoped tes1ing); logic: newest = live]; dormant
  nodewarden/responsive-web-design build tokens). Kept: prod brain-api build
  token (live — prod builds on every push), Cloudflare Agent / Agent Token
  (session access). Verification push: this commit — expect prod build green
  AND tes1ing deploy in audit-logs within minutes.
- 2026-10-17d verified: push `04befd3` (05:54:55Z). Prod build `6651e013`
  → success in 1m53s (build_outcome success 05:56:49Z) — prod credential
  survives the cleanup. NOTE: the prod build trigger's
  `build_token_name` is "terabox build token" (Cloudflare naming quirk from
  the 10-15 setup) — that token must be kept. Tes1ing: build-runner deploy +
  schedules + subdomain at 05:58:10-11Z — its live token survived too. Both
  accounts green end to end after cleanup. Cycle closed.
- 2026-10-17e agent skills for all runtimes (owner plan #1 "skills for brain
  MCP; make it for all AI agents"): two Agent Skills shipped at
  skills/<name>/SKILL.md — `brain-memory` (judgment: instant vs auto layers,
  evidence-gated corrections [auto-apply tier], forget/purge handling,
  block-edit reservation, procedures owner-approval-by-design, never-store
  rules, dedupe-before-write) and `brain-connect` (wire any MCP client:
  /mcp streamable HTTP + Bearer, token scoping, per-agent snippets,
  /v1/events/batch auto-capture for any runtime, health/unauthenticated
  semantics, common-mistakes list). Content grounded in src/mcp.ts (8 tools,
  scopes, tier copy) + plugin/src/capture.ts (CaptureEvent). Written
  test-first per writing-skills protocol: RED baselines via fresh subagents —
  memory baseline kept good instincts but MISSed evidence tiers and told a
  wrong auto-capture story; connect baseline snippets were solid but
  repo-blind. GREEN with skill injected: tiers, procedure path (c scenario
  intentionally swapped to exercise propose_procedure), dedupe-first flows
  and secret handling all held. REFACTOR: capture-schema guessing observed →
  pinned to plugin/src/capture.ts; micro re-test showed the agent sourcing
  the real schema. Word counts within reference-skill budget. Scope note:
  OpenCode-only auto-capture plugin remains; universal capture is the HTTP
  endpoint (documented). README "Agent skills" section + install command
  added next commit.
- 2026-10-17f "not only limited to opencode" (owner plan #2): capture clients
  for every runtime. shipped: clients/claude-code/ (zero-dep Node ≥18
  SessionEnd hook shim: stdin hook JSON → JSONL transcript → maps user /
  assistant text + tool_use to the plugin's payload shapes with source
  "file", bare-array POST /v1/events/batch, stable cc_<uuid>[_t<i>] ids,
  65_536 truncation, fail-open contract, flags --transcript/--dry-run/
  --session-id/--endpoint/--token) + capture.d.mts + install/verify README;
  clients/README.md (shared event contract pulled from src/ingest.ts:
  4 sources, 4 actors, batch ≤500, 1 MiB, id regex, id + (session_id, hmac)
  dedupe); docs/rest-recipes.md (EVERY route from src/index.ts ROUTES with
  scope labels — read loop, bare-array batch write contract, admin verbs
  incl. the two-step /v1/confirm/token → purge handshake [fixed after
  source-reading: first draft wrongly described a scope-mint; the endpoint
  mints one-time confirm tokens], manual pipeline runs, non-MCP agent loop);
  test/claude-code-capture.test.ts (7 tests: mapping incl. tool_use id
  suffix, skip summary/malformed, stable ids, uuid fallback, limit cap,
  ts normalization, truncateStrings parity). brain-connect skill auto-
  capture section now lists all three clients; README matrix ⚠️ "other
  platforms" line replaced by three ✅ lines (MCP clients / claude-code hook /
  REST recipes). GATE green 298/42 (baseline was 291/41). LIVE VERIFIED on
  tes1ing with owner-managed escrow creds (values never printed): shim
  dry-run maps 3 events / skips summary+malformed; real POST → 201 stored 3;
  replay POST → 0 stored 3 duplicate (id dedupe confirmed); GET recipes →
  search returns stored data, health-report 200, blocks []. tes1ing now has
  3 new cc_* events (session cc-verify-1).
- 2026-10-17g "make our skills more perfect": brain-memory upgraded from
  living evidence of today's failures (user wanted faster/perfecter skills).
  Four gaps closed, each observed live this session: (1) valid block keys
  now listed (identity/preferences/active_projects/infrastructure/
  constraints/objective — invalid key is 400; agents used to guess);
  (2) personal/family data defaults to the event layer, block only on
  explicit owner ask; (3) "it's not there needs proof" — newest events may
  outpace semantic indexing (recall("brother") missed a minute-old capture),
  verify via health-report rising events + flat warn/breaker before
  declaring loss; (4) urgency protocol — owners who say "without delay" get
  proposal id + exact value + the one-line admin apply, and agents may run
  apply ONLY on explicit owner instruction with a legitimately held admin
  credential, verified by GET /v1/blocks re-read (the path that unblocked
  today's identity apply). Verbatim-quote-in-reason provenance rule added.
  No design change — tiering intact (blocks/procedures still owner-only).
  RED was real (this session's misses); GREEN subagent re-run handled all
  three scenarios correctly (dedupe-first, no double-store of "i have a
  brother", health-checked non-loss). Gate + push follow.
- 2026-10-17h "keep going" housekeeping cycle: (1) verified the globally
  installed brain-memory skill on this machine carries the 665405b upgrade
  (marker grep = 2 hits); (2) dependabot sweep of 3 open PRs judged on CI
  evidence — merged #2 (actions/checkout 5→7, suites pass) and #3 (plugin
  vitest 4.1.11→5.0.4, both suites pass) [1b9e163, 40aefaa]; kept #4 root
  vitest →5.0.4 OPEN: Worker suite fails 40/40 files with zero tests —
  @cloudflare/vitest-plugin not vitest-5-compatible yet; not our bug, leave
  for dependabot rebases + upstream compat; (3) brain-connect skill gained
  the proposal-created-equals-not-applied mistake entry pointing at rest-
  recipes admin verbs (the exact gap the urgency protocol solved on the
  memory side). Root deps intentionally left on vitest 4 until #4 is green.
- 2026-10-17i agent-run setup prompt (owner plan #3 "prompt to set up the
  local one — mcp, skills, etc, not the server"): prompts/setup-local.md —
  paste-ready, runtime-agnostic (OpenCode/Claude Code/Cursor/Codex/generic),
  8 stages: intake → escrow-first (600 perms, out-of-repo, store-before-
  paste) → worker proof (200/401/503 fork map) → MCP two-entry disjoint-
  scope wiring with backup+idempotency → skills install via npx skills add
  → capture clients (plugin/claude-code shim/REST) → evidence suite
  (health counters, MCP read probe, WRITE-PROBE + dedupe re-send with
  permission ask, skills check, capture installed/declined) → close report
  with re-run-instructions. Secret hygiene baked in (mask to prefix, never
  print). TESTED end-to-end by a fresh subagent executing the prompt in a
  sandboxed HOME=/tmp/opencode/prompt-e2e against the live tes1ing worker
  (minimal-mode ADMIN_TOKEN routed to all three slots): all stages
  artifact-verified — brain.env 600 in fake home, opencode.json exact
  two-entry shape with correct /mcp URL, both skills installed under
  fake ~/.agents/skills, write probe stored:1 → duplicate probe stored:0/
  charged:0, budget +1 net. Subagent returned silent (no text) but its
  artifacts prove the full pass — prompt changes needed: none after two
  typo fixes pre-test (heredoc litter + garbled placeholder). README gains
  the setup-paste pointer. Gate pair before commit this time.
- 2026-10-17j main "install it" prompt (owner: the user-facing paste was
  missing): prompts/install.md — one short paste that tells the agent to
  FETCH the canonical setup-local.md from raw.githubusercontent at runtime,
  then follow it (fetched-protocol pattern: agent always executes the
  current version; fork owners swap the slug; the paste stays readable).
  README's agent-setup pointer replaced by the actual copy-paste block.
  TESTED as the real user journey: fresh subagent given ONLY the main
  prompt → fetched the protocol from the live raw URL → sandboxed HOME
  re-run showed idempotency working per stage (escrow byte-identical skip,
  MCP-shape skip, skills-verified skip) → full evidence suite: health 200
  (events 321→329, capture traffic visible live), MCP read probe over
  streamable HTTP OK, write probe smoke-fetche2e-* stored:1 → duplicate
  charged:0, skills 2/2, capture declined per directive; Stage 7 close-out
  paths-only + re-run note; token masking rule respected (4-char prefix,
  db34…). No secret values printed anywhere in the journey.
- 2026-10-17k PR sweep 2 + correction of my own diagnosis: only #4 open
  (root vitest → 5.0.4), unchanged (no rebase yet) with Worker suite
  failing 40/40. My "wait for upstream compat" verdict was WRONG in detail:
  installed plugin 1.4.2's peer range ALREADY allows vitest ^5; local repro
  showed the true failure = pool handshake readAll error inside the plugin
  (no such file .vitest-cache/<hash> from test-internal.mjs) — fixed
  upstream in @cloudflare/vitest-plugin 1.4.4. Verified locally: single
  file then FULL suite on vitest 5.0.4 + plugin 1.4.4 = 298/298 across 42
  files, tsc clean (workerd gw.test DNS chatter is pre-existing noise).
  Shipping BOTH bumps in one commit → dependabot #4 auto-resolves as
  satisfied. Lesson logged: verdicts need the actual in-suite error, not
  the failure shape; peer ranges are claims, boot behavior is evidence.
