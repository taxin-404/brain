# Fork dashboard auto-setup — implementation plan

> **Spec:** `docs/superpowers/specs/2026-10-16-fork-dashboard-setup-design.md` (read it first).
> Conflict rule: the spec wins on intent; this plan wins on names, shapes, and values.

## Goal

Forks go live from the Cloudflare dashboard alone:

- `wrangler.jsonc` is id-less and account-agnostic (no owner ids anywhere).
- A fresh D1 gets its schema at first request; prod (`6/6` recorded) no-ops.
- `npm run deploy` self-provisions the Vectorize index (deploy otherwise hard-fails `10159`).
- `AI_GATEWAY_BASE` is optional (direct Google fallback).
- Auth cannot match `Bearer undefined`.
- README/setup document the dashboard flow and the removal story.

## Architecture (after this plan)

- `scripts/embed-migrations.mjs` → committed `src/migrations.generated.ts`
  (regenerate: `npm run migrations:embed`).
- `src/bootstrap.ts` — `ensureSchema(db)`: memoized per binding, atomic per
  migration, `d1_migrations`-compatible with wrangler + the vitest plugin.
- `src/index.ts` awaits it in `fetch` (503 on failure) and `scheduled`.
- `test/apply-migrations.ts` boots via `ensureSchema`;
  `test/migrations.test.ts` pins sync + fresh-DB + bookkeeping.
- `scripts/ensure-vectorize.mjs` chained in `package.json` `deploy`; prod
  Builds deploy command set to `npm run deploy`.
- `src/auth.ts` guards empty tokens; `src/llm.ts` falls back to direct Google.

## Global constraints

- Gate every commit on full `npx vitest run` + `npx tsc --noEmit` (vitest
  unpiped). Never commit on a red suite.
- Prod stays frozen: no resource deletes/recreates; only the planned
  single-shot ops (secret put, Builds command PATCH) before the push; live
  checks single-shot only, never loops.
- Never print secret values. Ledgers are gitignored → `git add -f`.
- Work directly on `master`, inline execution (sole-owner workflow, same as
  every prior cycle; ruling recorded in the ledger).
- House commits: `feat|fix|docs|chore(ledger|config): …`.
- Ledger: `.superpowers/sdd/2026-10-16-fork-dashboard-setup/progress.md` —
  every task gets a completion line with its test evidence; every deviation a
  `Ruling:` line.

## Tasks

### Task 1 — Embed-migrations pipeline

Files: `scripts/embed-migrations.mjs` (new), `src/migrations.generated.ts`
(generated, committed), `package.json` (+`"migrations:embed"`),
`test/migrations.test.ts` (new).

Interface:

```ts
export interface EmbeddedMigration {
  readonly name: string;          // "0001_events.sql"
  readonly queries: readonly string[];
}
export const MIGRATIONS: readonly EmbeddedMigration[];
```

Steps:

1. RED — `test/migrations.test.ts`: sync test comparing `MIGRATIONS`
   name+queries against `TEST_MIGRATIONS` (cast `env` — the binding is
   plugin-provided), failure message must name
   `npm run migrations:embed`. Run `npx vitest run test/migrations.test.ts` →
   fails (module missing).
2. `scripts/embed-migrations.mjs`: `readD1Migrations("migrations")`, map to
   `{name, queries}`, write header + `export const MIGRATIONS: readonly
   EmbeddedMigration[] = <JSON.stringify(…, null, 2)>;`, print
   `N migrations / M queries`.
3. `package.json` script; run `npm run migrations:embed`; inspect the diff
   (6 migrations, 29 queries, deterministic).
4. GREEN — rerun the test file → passes.
5. Gate + commit `feat(schema): embed migrations for the runtime bootstrap`.

### Task 2 — Runtime bootstrap

Files: `src/bootstrap.ts` (new), `src/index.ts`, `test/apply-migrations.ts`,
`test/migrations.test.ts`, `vitest.config.ts` (vitest-only `MIGRATION_DB`
binding).

Steps:

1. RED — add to `test/migrations.test.ts`: (a) fresh-DB direct test — call
   `ensureSchema(MIGRATION_DB)` on a migration-free binding, assert all tables
   exist (`events`, `event_keys`, `facts`, `entities`, `proposals`,
   `confirm_tokens`, `rate_budgets`, `audit_log`, `events_fts`,
   `extractions`), `d1_migrations` rows equal the embedded names in order,
   second call resolves (memoized), and the vitest plugin's own
   `applyD1Migrations` replay resolves (interop). Run → fails (no module /
   binding).
   (b) bookkeeping on `BRAIN_DB`: rows equal embedded names in order.
2. `vitest.config.ts`: add `MIGRATION_DB` to miniflare bindings (try
   `d1Databases: ["MIGRATION_DB"]`; if the plugin rejects the shape, use
   `{ MIGRATION_DB: "<uuid>" }`).
3. Implement `src/bootstrap.ts`:

```ts
export function ensureSchema(db: D1Database): Promise<void>; // memoized WeakMap; failure clears the memo
// internal: batch([CREATE TABLE IF NOT EXISTS d1_migrations …, SELECT name …])
// then per pending migration: batch([...queries, INSERT INTO d1_migrations(name) VALUES (?1)])
// catch → SELECT the row; present ⇒ race loser, continue; absent ⇒ rethrow
```

4. Wire `src/index.ts`: `await ensureSchema(env.BRAIN_DB)` at the top of
   `fetch` (catch → log + 503) and first thing in the `scheduled` try block.
5. Swap `test/apply-migrations.ts` to `await ensureSchema(env.BRAIN_DB)`.
6. GREEN — run the migrations test file, then the full suite.
7. Gate + commit `feat(schema): bootstrap D1 schema at first request for fresh forks`.

### Task 3 — Auth guard

Files: `src/auth.ts`, `test/auth.test.ts`.

Steps:

1. RED — test: capture the three token originals; with them deleted (and an
   empty-string variant), `Bearer undefined` / `Bearer ` must get 401 on
   `/v1/health-report` (today `Bearer undefined` matches ADMIN → 200). Restore
   in `finally` via `setEnvVars`.
2. Implement: compare only when the env token is truthy
   (`if (env.ADMIN_TOKEN && header === \`Bearer ${env.ADMIN_TOKEN}\`) …`).
3. GREEN + gate + commit `fix(auth): never match Bearer tokens against unset secrets`.

### Task 4 — Direct-Google fallback for `AI_GATEWAY_BASE`

Files: `src/llm.ts`, `src/env.ts`, `test/llm.test.ts`.

Steps:

1. RED — replace "requires AI_GATEWAY_BASE for the native chat path" with a
   fallback expectation: `chatConfig({ GEMINI_API_KEY: "g" })` →
   `{ mode: "native", base: "https://generativelanguage.googleapis.com", … }`;
   add the embed twin. Run → fails (throws today).
2. Implement: `export const GEMINI_DIRECT_BASE = "https://generativelanguage.googleapis.com";`
   + `nativeBase(env) = env.AI_GATEWAY_BASE || GEMINI_DIRECT_BASE` used by
   `chatConfig`, `embedConfig`, and the native `postJson` fetch (check the
   embed call site around line 360+; update it too if it fetches directly).
   `env.ts`: `AI_GATEWAY_BASE?: string`.
3. GREEN + gate + commit `feat(llm): call Google directly when AI_GATEWAY_BASE is unset`.

### Task 5 — ensure-vectorize + config + prod prep

Files: `scripts/ensure-vectorize.mjs` (new), `package.json`,
`wrangler.jsonc`.

Steps:

1. Script: `VECTORIZE_INDEX` override (default `brain-memory`); DIMENSIONS
   768, METRIC cosine, METADATA `["type","status","sensitivity"]` (string);
   `npx wrangler vectorize list --json` → create if missing (tolerate
   already-exists) → `list-metadata-index … --json` (fallback: blind create
   with already-exists tolerance) → `create-metadata-index <name>
   --propertyName <p> --type string`; permission/unknown failures → warn +
   exit 0 with dashboard instructions; known-missing metadata index + denied
   create → instructions + exit 1.
2. Local verification (single-shot, prod account, nothing printed): run the
   script as-is → no-op vs live `brain-memory`; `VECTORIZE_INDEX=scratch-vec-check`
   → creates index + metadata; rerun → reuses; delete scratch index; `vectorize
   list` clean.
   Ruling (TDD exemption): this is build glue driving the world (wrangler
   CLI → Cloudflare API); its verification is the live matrix above, not a
   unit test.
3. `package.json`: `"deploy": "node scripts/ensure-vectorize.mjs && wrangler
   deploy --env=\"\""`; chain check: `node scripts/ensure-vectorize.mjs &&
   npx wrangler deploy --dry-run --env=""` (no deploy).
4. `wrangler.jsonc`: drop `database_id`; remove the `vars` block; refresh the
   deploy comments. Validate: `npx wrangler deploy --dry-run --env=""` parses
   and bundles.
5. Prod prep (single-shot, ledgered — not repo changes): extract the current
   gateway URL from `wrangler.jsonc` (never echoed) →
   `wrangler secret put AI_GATEWAY_BASE`; Builds API: GET the trigger, PATCH
   `deploy_command` → `npm run deploy`, GET to confirm. Rollback if the push
   build fails: PATCH back to `npx wrangler deploy --env=""`, re-trigger.
6. Gate + commits: `feat(deploy): provision the Vectorize index before deploy`
   (script + package.json), `chore(config): bind D1 by name and drop the
   owner-specific gateway var` (wrangler.jsonc).

### Task 6 — Docs

Files: `README.md`, `docs/setup.md`, `docs/engineering.md`,
`CONTRIBUTING.md`, `package.json` (`cloudflare.bindings` text).

Content (spec decision 6): README quick deploy → 5 dashboard-only steps + red
first build + six secrets + Retry + health zeros; "Removing / starting over"
section; FAQ updates; env tables (gateway optional, direct fallback;
`GEMINI_API_KEY` still required for the native path unless a compat provider
is set); `migrations:embed` workflow in CONTRIBUTING + engineering;
engineering's deploy-command/CI section updated (`npm run deploy`, runtime
bootstrap, `10159` fallback).

Gate + commit `docs: dashboard-only fork setup and removal`.

### Task 7 — Ledger, push, verify

1. Fold `256a054` verification (CI `38909478720` ✓, build `dbea7304` ✓) into
   `.superpowers/sdd/2026-10-16-any-ai-provider/progress.md`.
2. Update the fork-dashboard ledger: task lines, rulings, prod-prep evidence,
   verification plan status.
3. Commit `chore(ledger): …` (`git add -f` both ledgers).
4. Push `master`. Watch: GitHub Actions run; Workers Builds (this build runs
   `npm run deploy` — pins the build token's Vectorize permissions).
5. Single-shot prod smoke: `GET /v1/health-report` (200, `ai.chat` native,
   gateway base), `GET /v1/search` (200, no `degraded`).
6. Append verification to the ledger; hand the owner the fresh-account
   checklist (below).

## Review focus

Input classes and failure modes the tests do not exercise directly:

- `ensureSchema` race semantics (two isolates, loser path) and the
  batch-atomicity assumption vs real D1.
- ensure-vectorize permission matrix: {list ok/denied} × {index exists/missing}
  × {metadata create ok/denied} — exit codes and messages for each.
- The prod config switch: id-less D1 re-link must show `(inherited)`; the
  gateway var → secret move must not change the resolved base.
- Docs accuracy: every dashboard step must match wrangler 4.151 strings
  ("Missing required secrets", Settings → Variables and Secrets, Retry
  deployment).

## Fresh-account checklist (owner, after this ships)

1. Create a free Cloudflare account (new email or existing login — any
   account without brain resources).
2. Fork `taxin-404/brain` on GitHub.
3. Dashboard → Workers & Pages → Create → Continue with GitHub → pick the
   fork; name `brain-api`; build `npm ci && npm test`; deploy `npm run
   deploy`; previews OFF.
4. First build goes red with `Missing required secrets: …` — expected.
   Settings → Variables and Secrets → add the six (`PAYLOAD_KEK`,
   `CONTENT_HMAC_KEY`, `MCP_READ_TOKEN`, `MCP_PROPOSE_TOKEN`, `ADMIN_TOKEN`,
   `GEMINI_API_KEY`) → Retry deployment.
5. `GET https://brain-api.<your-subdomain>.workers.dev/v1/health-report`
   with the admin token → zeros.
6. (With the owner) pin the dashboard delete-flow wording; then delete the
   worker, confirm D1/R2 survive (or document what the dialog says), and
   re-connect.
