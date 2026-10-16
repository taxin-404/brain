# Fork dashboard auto-setup — design

Date: 2026-10-16 · Status: direction pre-approved by the owner ("do all") · Author: assistant, at the owner's direction

## Intent

A fork of brain on a fresh Cloudflare account must go from "forked" to "healthy
worker" entirely through the dashboard's browser UI — no terminal anywhere: no
`wrangler d1 migrations apply`, no editing `wrangler.jsonc`, no CLI resource
creation. Today's "Visual quick deploy" still needs a terminal (schema step) and
a GitHub config edit (D1 id); this design removes both. Reference:
[NodeWarden](https://github.com/shuaiplus/NodeWarden)'s fork flow — id-less
bindings, in-worker schema bootstrap, build-time ensure script.

Non-goals: a one-click "Deploy to Cloudflare" button; preview isolation;
multi-user support; renaming resources per fork.

## Evidence base

Live probes 2026-10-16, prod account `1ce49401…`, throwaway names, all cleaned
up; prod resources verified untouched. Full detail:
[`.superpowers/sdd/2026-10-16-fork-dashboard-setup/progress.md`](../../../.superpowers/sdd/2026-10-16-fork-dashboard-setup/progress.md).

- **D1/R2 auto-provision at deploy** when an id-less binding names a missing
  resource — created with the exact configured name. Id-less binding + existing
  name binds it; redeploys show `(inherited)`; no id write-back into config.
- **Vectorize is NOT auto-provisioned** — deploy hard-fails, code `10159`.
- **Deleting the Worker leaves D1/R2 intact** (both `wrangler delete` and the
  beta workers endpoint); versions/deployments/DO namespaces go with the worker.
- **Prod `d1_migrations` today** (single-shot read this session): schema
  `(id INTEGER PK AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT
  CURRENT_TIMESTAMP NOT NULL)`; rows exactly `0001_events.sql` …
  `0006_extractions.sql` — the same table/names `readD1Migrations` produces.
- **`secrets.required` is deploy-blocking** in wrangler 4.151 (dist strings:
  "Missing required secrets: …" before first deploy / during upload or deploy).

## Decisions

### 1. Fork-safe `wrangler.jsonc`

- Drop `database_id` (keep `database_name: "brain-db"`). Fresh fork:
  auto-provisions. Prod: re-links by name (`(inherited)`).
- Remove `vars.AI_GATEWAY_BASE` — the value embeds the **owner's** account id
  and must not be inherited by forks. `AI_GATEWAY_BASE` becomes optional
  everywhere (decision 4). Prod keeps the gateway by moving the value to a
  worker secret *before* the config change lands (secrets survive deploys).
- Keep `secrets.required` and the `--env=""` deploy semantics. The red first
  build (`Missing required secrets: …`) is the deliberate, documented fork step:
  paste the six secrets in **Settings → Variables and Secrets**, click
  **Retry deployment**.

### 2. Runtime schema bootstrap — `src/bootstrap.ts`

- `migrations/*.sql` remain the single source of truth.
  `scripts/embed-migrations.mjs` (Node, build-time) runs `readD1Migrations`
  from `@cloudflare/vitest-plugin` — the same statement splitter the test
  harness uses — and writes the committed `src/migrations.generated.ts`
  (`npm run migrations:embed`). 6 files → 29 queries.
- `ensureSchema(db)` — memoized per D1 binding; failed attempts retry on the
  next request:
  1. `db.batch([CREATE TABLE IF NOT EXISTS d1_migrations …, SELECT name FROM
     d1_migrations])` — one round trip on a healthy boot;
  2. for each embedded migration not recorded:
     `db.batch([...queries, INSERT INTO d1_migrations(name)])` — **atomic per
     migration**;
  3. race-tolerant: two cold isolates racing the same fresh DB — the loser
     re-checks the bookkeeping row and continues.
- Same table, same names, same split as `wrangler d1 migrations apply` **and**
  the vitest plugin → fresh forks bootstrap; prod (6/6 recorded) no-ops after
  step 1; local dev and tests stay consistent with both.
- Wiring: `fetch` awaits it (503 on failure, logged); `scheduled` awaits it
  before dispatch (failure lands in the existing cron catch).
- Tests boot through the real path: `test/apply-migrations.ts` calls
  `ensureSchema` instead of the plugin's `applyD1Migrations` — every test file
  exercises a virgin-DB bootstrap. New `test/migrations.test.ts`:
  (a) **sync gate** — the generated module must equal `TEST_MIGRATIONS`, with a
  "run `npm run migrations:embed`" failure message; (b) **fresh-DB direct
  test** — a migration-free D1 binding (`MIGRATION_DB`, vitest-only) gets
  schema + bookkeeping from `ensureSchema` alone; (c) **bookkeeping** — the
  main DB's `d1_migrations` rows equal the embedded names in order.

### 3. `scripts/ensure-vectorize.mjs` — runs before `wrangler deploy`

- Ensures index `brain-memory` (768, cosine) + metadata indexes
  `type`/`status`/`sensitivity`, idempotent, via the `wrangler vectorize` CLI
  (works in Workers Builds — the deploy step has account credentials, proven
  by NodeWarden's `ensure-kv.cjs`).
- Failure posture: cannot-verify (token lacks Vectorize permissions) → warn +
  exit 0 — deploy's own `10159` check remains the guard, README carries the
  dashboard fallback. Index known-present-or-just-created but a metadata index
  is missing and creation was denied → print the dashboard steps and **exit 1**
  (blocks: metadata filters must not degrade silently).
- `package.json`: `"deploy": "node scripts/ensure-vectorize.mjs && wrangler
  deploy --env=\"\""`. Prod's Workers Builds deploy command switches to
  `npm run deploy` via the Builds API — prod and forks run the same command
  (dogfooded).
- `VECTORIZE_INDEX` env override (drills/tests); default `brain-memory`.

### 4. `AI_GATEWAY_BASE` becomes optional (direct Google fallback)

- Unset → the native Gemini path calls `https://generativelanguage.googleapis.com`
  directly (same `/v1beta/...` paths, same `x-goog-api-key` header; the
  gateway mirrors those exactly). Set → unchanged, all calls through the
  gateway.
- Prod keeps the gateway (secret, per decision 1). Forks work with zero URL
  config; the README presents the gateway as the optional enhancement it now
  is.

### 5. Auth must not match `Bearer undefined`

`resolveScope` compares against `Bearer ${env.TOKEN}` — with a token unset the
literal string `Bearer undefined` authenticates as ADMIN. Guard: compare only
when the env value is non-empty. (Defense in depth; `secrets.required` already
blocks tokenless deploys, but local dev, drills, and any future relaxation must
not create an admin.)

### 6. Docs — the fork funnel

- README "Visual quick deploy" → dashboard-only steps: fork → Workers →
  connect repo (name `brain-api`, build `npm ci && npm test`, deploy
  `npm run deploy`, previews OFF) → red first build → paste six secrets →
  Retry deployment → `GET <worker>/v1/health-report` returns zeros → wire
  OpenCode (docs/setup.md §7).
- New "Removing / starting over" section: deleting the Worker is safe (D1/R2
  survive — proven); full wipe = delete worker + D1 + R2 + Vectorize + the
  GitHub connection in the dashboard. FAQ updated (red first build, 401s,
  missing metadata indexes).
- `docs/setup.md` aligned to the same flow; `docs/engineering.md` (deploy
  command, runtime bootstrap, migrations workflow); `CONTRIBUTING.md`
  (regenerate after editing `migrations/`); `package.json`
  `cloudflare.bindings` descriptions.

## Verification

1. Per commit: full `npx vitest run` + `npx tsc --noEmit`.
2. Script: local single-shot runs against the prod account — no-op vs the live
   `brain-memory`; scratch index lifecycle (create → re-run reuses → metadata →
   delete; account left clean).
3. Pre-push prod prep (single-shot each, ledgered): `AI_GATEWAY_BASE` secret
   put; Builds deploy command → `npm run deploy`.
4. Post-push: CI green; Workers Builds green — this real build pins the build
   token's Vectorize behavior; single-shot `GET /v1/health-report` +
   `GET /v1/search` smoke; AI wiring still native via the gateway.
5. Fresh-account end-to-end (owner action): new free account → fork connect →
   red build → six secrets → Retry → zeros health; pin the dashboard
   delete-flow wording; document.

## Risks / rollback

- **Prod deploy-command change** can block prod builds if the ensure script
  misbehaves → rollback: revert the command via the Builds API, re-trigger.
- **Bootstrap on prod**: provably no-op (prod read above); worst case revert
  the commit — it only creates schema the migrations define, never alters or
  drops.
- **Direct-Google fallback**: only active when `AI_GATEWAY_BASE` is unset;
  prod and local dev unaffected; no silent route changes.
