# brain

Personal neural memory for OpenCode sessions — capture, redact, encrypt at rest,
search, and recall into future sessions. Runs on Cloudflare Workers (D1 + R2).

**Status: Phase 0 delivered & live · Phase 1 complete** — all 15 planned tasks done
(48 Worker + 3 plugin tests green, deployed live, acceptance + eval gate passed).
Capture and MCP recall are registered globally in the owner's OpenCode config and
proven live end-to-end (owner-approved 2026-10-15; see
`.superpowers/sdd/2026-10-15-brain-phase-0-1/task-14-log.md`).

## ⚠️ Free-tier rules — every agent must read this

This account runs on Cloudflare's free tier (plus a small, capped Gemini budget in
Phase 2). An agent once "tested" a deployed worker with a request loop and burned
the account's daily free request limit in seconds. No exceptions, ever:

- **Never run load, stress, soak, or benchmark tests against deployed workers**
  (`*.workers.dev`). No request loops, no parallel hammering. All tests run
  locally: `npx vitest run` uses real `workerd` with zero network.
- **Prod verification = single-shot requests only.** A few one-off curls are
  fine; a `for` loop against the live URL is not. (Cloudflare's management API
  and Workers Builds endpoints don't consume the worker request quota, but keep
  polling there minimal too.)
- **Quotas to respect:** Workers 100k requests/day · D1 100k row-writes/day (the
  in-app `rate_budgets` breaker at 80k protects this) · Vectorize 5M stored dims ·
  Queues 10k ops/day · Gemini calls under the Google Cloud budget alert (~$5/mo).

## Read-first map

| Doc | What it is |
| --- | --- |
| [`docs/design-v1.2.md`](docs/design-v1.2.md) | Approved design spec — authority for behavior, SQL, budgets |
| [`docs/plans/2026-10-15-brain-phase-0-1.md`](docs/plans/2026-10-15-brain-phase-0-1.md) | Execution plan — 15 tasks with exact interfaces and tests |
| [`.superpowers/sdd/2026-10-15-brain-phase-0-1/progress.md`](.superpowers/sdd/2026-10-15-brain-phase-0-1/progress.md) | Running ledger — rulings, gotchas, environment facts. **Read before changing anything.** |
| `.superpowers/sdd/2026-10-15-brain-phase-0-1/task-N-brief.md` | Per-task briefs (interfaces, verbatim tests) |
| [`docs/key-rotation.md`](docs/key-rotation.md) | PAYLOAD_KEK rotation procedure |

## Layout

```
src/            Worker source — routes, auth, crypto, redact, budget, ingest,
                purge, audit, rebuild (FTS5), search, blocks, mcp, sweep, health
migrations/     D1 schema 0001–0005 (wrangler d1 migrations apply)
test/           vitest suite (@cloudflare/vitest-plugin, D1 via miniflare)
plugin/         OpenCode capture plugin — event-sourced capture + diagnostics (Tasks 13–14)
docs/           spec + plan + key rotation
wrangler.jsonc  Worker config: D1 brain-db, R2 brain-raw, cron "*/30 * * * *",
                keep_vars + secrets.required (see Deploy & CI)
```

## Develop

```bash
npm install
npx vitest run        # full Worker suite
npx tsc --noEmit      # typecheck
npx wrangler dev      # local worker (create .dev.vars from vitest.config.ts bindings)

cd plugin && npm i && npx vitest run   # capture plugin tests
```

Dev-only tokens (`dev-kek`, `dev-hmac`, `dev-read`, `dev-propose`, `dev-admin`)
live in `vitest.config.ts` miniflare bindings — the suite runs from a fresh clone.

## Ops facts

- Worker `brain-api` → `https://brain-api.taxin-404.workers.dev` (deployed)
- D1 `brain-db` + R2 `brain-raw` live (APAC region), 5/5 remote migrations applied
- Prod secrets set via `wrangler secret put`; values escrowed out-of-band, **never in the repo**
- Cron `*/30 * * * *`: prune expired confirm tokens + budget warn/breaker logging

## Deploy & CI (Cloudflare Workers Builds)

Pushing to `master` makes Cloudflare build and deploy `brain-api` automatically
(GitHub repo `taxin-404/brain`, production branch `master`).

- **Build command:** `npm ci && npm test` — a red test suite blocks the deploy.
- **Deploy command:** `npx wrangler deploy --env=""` — the trailing `--env=""`
  targets the top-level config on purpose: `env` blocks do **not** inherit
  bindings, so `--env prod` would deploy a worker with zero D1/R2 bindings.
- **Secrets survive deploys** (worker-level, never touched by a deploy):
  `PAYLOAD_KEK`, `CONTENT_HMAC_KEY`, `MCP_READ_TOKEN`, `MCP_PROPOSE_TOKEN`,
  `ADMIN_TOKEN`. `keep_vars: true` additionally protects dashboard-set plain-text
  vars, and `secrets.required` in `wrangler.jsonc` makes a deploy *fail loudly*
  if any of the 5 secrets is missing. Symptom of a missing secret: every
  authenticated route 401s.
- **Preview builds are intentionally NOT configured** — previews would run
  against the same prod D1/R2; there is no preview isolation yet.
- **Push-triggered builds go silent if the GitHub App loses repo access.** The
  repo is public, so manual API-triggered builds keep working even when webhooks
  are dead — before debugging anything else, verify the *Cloudflare Workers and
  Pages* app still lists `brain` (https://github.com/settings/installations).

Builds API (for agents; management token in `.secrets/cf-builds.env` —
user-scoped, `Workers Builds Configuration:Edit` + `Workers Scripts:Read`):

```bash
T=$(source .secrets/cf-builds.env && echo -n "$CF_BUILDS_TOKEN"); A=1ce49401e2d9c63449f7621e4f5e10e9
TAG=000d2f15931e461dad9bb9b423ab461a          # brain-api worker tag (external_script_id)
TRIGGER=a69e5d96-f3e4-4505-8cb9-99ad22fcde70  # "Deploy production" trigger

# list builds / trigger one manually / read logs
curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/accounts/$A/builds/workers/$TAG/builds"
curl -s -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/accounts/$A/builds/triggers/$TRIGGER/builds" -d '{"branch":"master"}'
curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/accounts/$A/builds/builds/<build_uuid>/logs"
```

The deploy step authenticates with the account's **"terabox build token"**
(`7d897a7d-0b7f-4ba7-a13a-a2237258c485`), reused because build tokens cannot be
created via API without token-creation permissions. It is account-scoped and
nothing about it is terabox-specific; deleting it would break both projects'
builds.

## Progress

| Tasks | What | State |
| --- | --- | --- |
| 1 | scaffold: repo, tsconfig, vitest, health route | ✅ |
| 2 | D1 migrations 0001–0005 (events, FTS, budgets, confirm_tokens, audit) | ✅ |
| 3 | auth (read/propose/admin, strict propose≠read), budget read, Phase 0 gate | ✅ |
| 4 | redaction (payload + excerpt, sensitive KEY-name rule) | ✅ |
| 5 | crypto: AES-GCM envelope, HMAC, ULID, key-rotation doc | ✅ |
| 6 | budget charge: 10k cap, 70k warn, 80k breaker, admin exempt | ✅ |
| 7 | encrypted idempotent ingest `/v1/events/batch` + routes | ✅ |
| 8 | crypto-shred purge (exact 6-step sequence) + audit | ✅ |
| 9 | FTS rebuild honoring tombstones | ✅ |
| 10 | search + working-memory blocks | ✅ |
| 11 | MCP server: recall, get_blocks, health_report, remember | ✅ |
| 12 | `*/30` sweep cron | ✅ |
| 13 | OpenCode capture plugin (`plugin/`) | ✅ |
| 14 | Phase 1 acceptance — live capture + MCP recall proven, race fix | ✅ |
| 15 | keyword eval harness: recall@5 ≥ 0.9 regression gate (12 real pairs) | ✅ |

## For AI agents

- Read the design doc and the progress ledger before touching code — the ledger
  records non-obvious rulings (vitest-plugin storage isolation, `redacted` flag
  semantics, MCP need-token gating) that will otherwise cost you hours.
- TDD: write the failing test first, watch it fail, then implement.
- Gate every commit on `npx vitest run` and `npx tsc --noEmit`. Do not pipe
  vitest when you need its exit code.
- Test isolation gotcha: miniflare storage is fresh per test **file**, shared
  across tests **within** a file — use unique ids/sessions/days per test and
  budget assertions as deltas.
- Secrets policy: `.secrets/` and `.dev.vars` are gitignored; the `dev-*` tokens
  in `vitest.config.ts` are intentionally public and local-only.
- Capture plugin: sessions are discovered from the global event stream
  (`ctx.session` has no `list` at runtime); diagnostics land in
  `/tmp/opencode/brain-capture-diag.log` — plugin console output is invisible in
  server logs. Live E2E without touching global config: a project-local
  `opencode.json` with the plugin entry in a scratch dir (see `task-14-log.md`).
- Registered globally (owner-approved 2026-10-15): the capture plugin and the
  `brain` MCP server (recall / get_blocks / health_report / remember) live in
  `~/.config/opencode/opencode.json` — every session captures automatically.
