### Task 14 log — Phase 1 acceptance (2026-10-15, branch `phase-0-1`)

Worker version at close of acceptance: `22d9d848-ca58-43e9-b175-b65970d8c4d4` (includes the ingest race fix). Deployed URL: https://brain-api.taxin-404.workers.dev.

**Step 1 — suites, named gates.** `npx tsc --noEmit` clean (root + plugin); root vitest 14 files / 48 tests pass — including `test/purge.test.ts` (crypto-shred end-to-end + identical-payload independence), `test/rebuild.test.ts` (purge-survives-rebuild), `test/budget.test.ts` (breaker at 80,000, ADMIN exempt); plugin suite 3/3.

**Step 2 — deploy.** `npx wrangler deploy` green; cron `*/30 * * * *` registered; `wrangler d1 migrations apply brain-db --remote` → “No migrations to apply!”.

**Steps 3–4 — live end-to-end: a full session lands automatically.** This step rewrote the capture plugin's core, because the brief's design did not survive contact with the runtime:

- `ctx.session.list()` does not exist in @opencode/plugin 2.0.29 at runtime (`TypeError: ctx.session.list is not a function`; the client SessionApi has `list`, but the plugin `SessionDomain` is a Pick that excludes it). Runtime surface: `ctx.session = [hook, create, get, remove, switchAgent, switchModel, prompt, generate, command, compact, synthetic, interrupt, update, move, wait, context]`.
- Capture is now **event-sourced**: any received event carrying a `sessionID` discovers a session; `session.step.ended` triggers incremental ingest; `session.status`→idle and `session.idle` also trigger; a reconcile pass on load and every 30 minutes re-ingests every seen session (7-day window) so missed pushes self-heal. The server dedupes by event id, so overlapping triggers are free.
- Event delivery is **global**: one plugin instance receives events for sessions in all locations (proven live).
- `ctx.session.context()` returns a bounded tail window, not full history — capture is therefore incremental by design; only content older than the window at first sighting is unreachable (pre-install history would need an external backfill via the service API; not built).
- Diagnostics had to be invented: plugin console output is invisible in server logs. `plugin/src/diag.ts` writes bounded, always-on lines to `/tmp/opencode/brain-capture-diag.log` plus opt-in worker diag events (plugin option `diag`). The whole investigation ran on this channel.

Evidence (marker session run through a sandboxed project-local config at `/tmp/opencode/brain-e2e` — ancestor-discovered `opencode.json` carrying the prod tokens, chmod 600; deleted after acceptance):

- Session `ses_ec063fc8dffe0aqMqEP7`, prompt “Please reply with exactly: brain-e2e-accept-9c1f”.
- `GET /v1/health-report` → events ≥ 1 (58 at check time).
- `GET /v1/search?q=brain-e2e-accept-9c1f` → 2 hits (user message + assistant reply, marker present in both).
- The brief's original marker `brain-e2e-marker-7f3a` predated the fix and fell outside the context tail window; the fresh marker preserves the brief's intent (no agent cooperation used anywhere).

**Live bug found and fixed on the way (commit `7dcb07e`).** Two overlapping batch uploads during capture produced `500 error code: 1101`; reproduced deterministically with concurrent overlapping batches. Root cause: check-then-insert TOCTOU in `ingestEvents` (the pre-insert SELECT cannot see uncommitted writers), so the losing batch hits the `events.id` primary key and throws. Fix: `INSERT OR IGNORE` + per-statement `meta.changes` to report raced rows as `duplicate`. Verified live: two concurrent overlapping batches → both 201 with correct per-row statuses. Budget charges attempted writes (fail-closed).

**Step 5 — MCP spot-check (deterministic JSON-RPC, not via an agent).** initialize → `serverInfo {name: brain, version: 0.1.0}`; `tools/list` → `[recall, get_blocks, health_report, remember]`; `tools/call recall` with the marker → 5 hits, top excerpts contain it. Note: Cloudflare 403s `python-urllib` user agents on `/mcp`; use curl or a real MCP client.

**Bonus dogfood — purge in prod.** The 12 probe/junk events created during acceptance (sessions `ses_repro*`, `brain-capture` diag) were crypto-shred purged through the real API: 12/12 `{"purged":true}`; search no longer returns them; tombstones remain in their sessions by design.

**Step 3 — global registration: PENDING OWNER DECISION.** The sandbox technique covers live E2E without touching the user config; registering in `~/.config/opencode/opencode.json` was explicitly gated on owner approval (asked at task close; outcome recorded in progress.md).

**Env facts for future agents:** plugin edits hot-reload in the shared service (file watchers); `opencode reload` is the safe manual reload — never `opencode service restart` (kills agent sessions); diag file `/tmp/opencode/brain-capture-diag.log`; shared-service ground truth `opencode api get /api/session`.
