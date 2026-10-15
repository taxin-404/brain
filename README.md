# brain

Personal neural memory for OpenCode sessions — capture, redact, encrypt at rest,
search, and recall into future sessions. Runs on Cloudflare Workers (D1 + R2).

**Status: Phase 0 delivered & live · Phase 1 in progress** — Tasks 1–14 of 15
complete (48 Worker + 3 plugin tests green, deployed live, acceptance passed), Task 15 (keyword eval harness) next.

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
wrangler.jsonc  Worker config: D1 brain-db, R2 brain-raw, cron "*/30 * * * *"
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
| 15 | eval harness | ⏳ |

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
