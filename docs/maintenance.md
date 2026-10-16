# Maintaining brain

For future maintainers (mostly: future you). How releases happen, how the CI
is wired, and what outside projects this one draws updates from.

## Releases

Versioning is [SemVer](https://semver.org/), pre-1.0: minor bumps may change
behavior, patches are fixes only. Root `package.json`,
`plugin/package.json`, and `CHANGELOG.md` move together. The deployed worker
always tracks `master` — a release is a **tag** on an already-deployed, green
commit, not a deploy trigger.

1. Green gate locally: `npx vitest run` + `npx tsc --noEmit` (plus the plugin
   suite when `plugin/` changed).
2. Update `CHANGELOG.md`: move the `[Unreleased]` entries under the new
   version heading, update the compare links.
3. Bump `version` in root `package.json` and `plugin/package.json` (keep them
   equal).
4. Commit (`chore(release): vX.Y.Z`), push, and wait for Workers Builds +
   GitHub Actions to be green on `master`.
5. Tag and publish the notes:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <changelog-entry.md>
   ```

   Keep the release body equal to the changelog section.

## CI map

| Where | Trigger | What it does |
| --- | --- | --- |
| GitHub Actions (`.github/workflows/ci.yml`) | every PR + push to `master` | `npm ci` + full suite + typecheck; a separate job for the plugin suite. No secrets, nothing live. |
| Cloudflare Workers Builds | push to `master` | `npm ci && npm test`, then `npx wrangler deploy --env=""` **only if green** — this is the production deploy. |
| Dependabot | weekly | dependency-update PRs (root npm, plugin npm, GitHub Actions). |

Before touching build settings, read the Workers Builds notes in
`docs/engineering.md` — `--env=""` and the shared account token are load-bearing.

## Dependency hygiene

- Merge Dependabot PRs only on a green gate — CI enforces it.
- Keep `@cloudflare/*` packages in step with `wrangler`; a wrangler or
  workerd bump can change local test behavior. After deploying a dependency
  bump, re-run one single-shot verification from `docs/setup.md`.
- The lockfiles (`package-lock.json`, `plugin/package-lock.json`) are the
  source of truth — CI uses `npm ci`.

## Related projects (where outside updates come from)

Nothing in this repo is vendored from elsewhere, but three outside
relationships matter when updating it.

### mem0 — `taxin-404/mem0` (fork of `mem0ai/mem0`)

The capture plugin in [`plugin/`](../plugin/) fills the same role as mem0's
`mcp/opencode-autosave/` plugin: memory capture for OpenCode sessions. It is
an independent implementation — no code is shared. When the mem0 side gains
something worth having (new event kinds, batching or backoff ideas), port the
idea by hand into `plugin/src/` and pin it with a plugin test. The design doc
records why mem0 itself was rejected as this project's runtime — see the
alternatives table in [`docs/design-v1.2.md`](design-v1.2.md).

### terabox — the account's other Workers project

Shared: the account-level **Workers Builds deploy token** (docs/engineering.md,
"Deploy & CI"). Deleting or rotating it breaks **both** projects' builds. Nothing else
is shared — no code, config, or data stores.

### superpowers — the agent workflow itself

The `.superpowers/sdd/` ledgers and the skills/process used to build this
repo come from the *superpowers* OpenCode plugin installed in the
maintainer's config, not from this repo. Update superpowers where it lives;
the ledgers here are append-only history — new work appends, old entries are
never rewritten.

## Free-tier safety

Single-shot verification only; never loop against the deployed worker. The
in-app budget breaker protects D1 row-writes, not the Workers request quota
or the Gemini quota — only discipline covers those. Full rules:
`docs/engineering.md` § "Free-tier rules".
