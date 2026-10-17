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
- [ ] T7 — ledger, push, verify

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
- T7 remaining: final commits + push watch; owner checklist (fresh-account e2e; KEK escrow deletion still held). Reviewer declined-to-judge list (dashboard wording pins, live Vectorize token matrix, prod var→secret state) is ledger-covered or owner-pending.

Open item carried: fresh-account end-to-end test (owner creates account; connects fork; red build → six secrets → retry → health; delete-flow wording pin).
