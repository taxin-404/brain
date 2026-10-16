# Contributing

Thanks for looking. `brain` is a personal memory system (single-owner by
design) that is public so it can be self-hosted, studied, and forked. Issues
and pull requests are welcome — just remember the deployed worker belongs to
the maintainer, so **all development and testing happens locally**.

## Ground rules

1. **Never run load against deployed workers.** No loops, no parallel
   hammering — the account is on Cloudflare's free tier and quotas are shared
   with the owner's other projects. The "Free-tier rules" section of
   [`docs/engineering.md`](docs/engineering.md) is required reading before you
   touch anything that talks to a live URL.
2. **Never commit secrets or captured personal data.** `.secrets/` and
   `.dev.vars` are gitignored; keep it that way. Fixtures use the public
   `dev-*` token names from `vitest.config.ts` — never real values.
3. **The design doc is the authority.** Behavior changes start in
   [`docs/design-v1.2.md`](docs/design-v1.2.md). The phase plans in
   `docs/plans/` show how work is cut into tasks with exact interfaces and
   tests.
4. **Read the ledger before touching code.** `.superpowers/sdd/*/progress.md`
   records non-obvious rulings (miniflare storage isolation, redaction
   semantics, deploy-safety) that will otherwise cost you hours.

## Dev loop

```bash
git clone git@github.com:taxin-404/brain.git
cd brain
npm install
npx vitest run          # full Worker suite (real workerd, zero network)
npx tsc --noEmit        # typecheck
npx wrangler dev        # local worker — copy .dev.vars.example to .dev.vars

cd plugin && npm ci && npx vitest run   # capture plugin suite
```

- **Gate every commit** on `npx vitest run` *and* `npx tsc --noEmit` — run
  vitest unpiped so you keep its exit status.
- **TDD**: write the failing test first, watch it fail, then implement. The
  `test/eval-*.test.ts` files pin the design doc's "done when" sentences and
  are the model to follow.
- **Test isolation**: miniflare storage is fresh per test *file* but shared
  within a file — use unique ids/sessions/days and delta assertions.
- **One task per commit**, house style from `git log`:
  `feat(area): …`, `fix(area): …`, `docs: …`, `chore(ledger): …`.

Deploying your own copy is a different path — see
[`docs/setup.md`](docs/setup.md) (resources, secrets, client wiring,
verification).

## Repo anatomy

| Path | What lives there |
| --- | --- |
| `src/` | Worker source: routes, auth, crypto, redaction, budget, ingest, purge, FTS, search, MCP, sweep, extraction, factstore, graph, review, consolidation, reflections, procedures, connectors, exporter, inspector |
| `migrations/` | D1 schema (`wrangler d1 migrations apply`) |
| `test/` | Vitest suite; `eval-*.test.ts` are the design-doc gates |
| `plugin/` | OpenCode capture plugin — standalone npm project with its own suite and lockfile |
| `docs/` | Design spec, phase plans, setup guide, key rotation, DR drill, maintenance |
| `eval/` | JSON fixtures for the eval tests |
| `scripts/` | `eval-live.mjs` — owner-run, single-shot live harness |
| `.github/` | CI workflow, issue/PR templates, Dependabot |
| `.superpowers/sdd/` | Progress ledgers — append-only history of rulings |

## Pull requests

- Use the PR template checklist.
- CI runs the full suite and typecheck on every PR (GitHub Actions, no
  secrets, nothing live) — keep it green.
- **Merging to `master` deploys the live worker.** Cloudflare Workers Builds
  runs `npm ci && npm test` and deploys only on a green suite. Treat `master`
  as production.
- Releases are tagged `vX.Y.Z` with notes in [CHANGELOG.md](CHANGELOG.md) —
  the process and the related-project sync story live in
  [`docs/maintenance.md`](docs/maintenance.md).

## Security

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md).
