# Repo restructure — progress ledger

**Task:** make `brain` a proper public project — contribution/community
files, PR CI, changelog + release process, and a factual sync story for
related projects ("the project we copied here").

**Context:** owner was heading out for ~2h: "yeah properly do it and push …
make it perfect". Brainstorm questions were skipped by the owner → no
remaining approval gate. The additive-only ruling below is recorded for the
record.

## Ruling: additive-only restructure (no file moves)

- `plugin/` is referenced by absolute path in the owner's live OpenCode
  config (`~/.config/opencode/opencode.json`) — moving it silently breaks
  session capture in every project.
- `src/`, `migrations/`, `wrangler.jsonc`, `vitest.config.ts` are wired into
  Workers Builds (`npm ci && npm test`, `wrangler deploy --env=""`) and the
  test harness. Moving them is a deploy risk with nobody able to review in
  time, for zero functional gain.
- So "proper project" here means: community + contribution files, PR CI
  (none existed — Workers Builds only gates master pushes; previews are
  intentionally off), changelog/release process, dev-tooling files, and a
  factual related-projects doc.

## Provenance investigation ("the project we copied here")

- Git history + cross-repo comparison (explore subagent, 2026-10-16): **no
  verbatim copy** of code from any sibling project.
- Closest functional relation: **mem0** — `taxin-404/mem0` (fork of
  `mem0ai/mem0`; local `../mem0`, `../mem0-server`). Its
  `mcp/opencode-autosave/` plugin has the same role (OpenCode capture →
  memory); brain's `plugin/` is an independent rewrite (3 files / 396 lines
  vs 1 file / 164 lines; event-sourced).
- CI-only relation: **terabox** — shared account-level Workers Builds deploy
  token (README "Deploy & CI" documents it).
- Process relation: **superpowers** — `.superpowers/sdd/` ledgers and skills
  come from the OpenCode plugin, not from this repo.
- → Documented in `docs/maintenance.md` § Related projects. Written strictly
  from repository evidence — if the owner meant a different project, that
  section is the place to correct it.

## Actions taken (2026-10-16)

- Enabled GitHub **private vulnerability reporting** (was disabled; enabled
  via API). `SECURITY.md` points at it.
- Added community/contribution files: `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `.github/` PR + issue
  templates.
- Added CI/tooling: `.github/workflows/ci.yml` (PR + master: worker suite +
  typecheck; plugin job), `.github/dependabot.yml`, `.nvmrc` (node 26 —
  matches local v26.8.2), `.editorconfig`, `.gitattributes`,
  `.dev.vars.example`.
- Added `CHANGELOG.md` (Keep a Changelog; 0.1.0 = everything through today)
  and `docs/maintenance.md` (releases, CI map, dependency hygiene, related
  projects).
- README: CI/license badges, read-first-map rows, layout rows (`eval/`,
  `.github/`), Develop block points at `.dev.vars.example` + CONTRIBUTING,
  Deploy & CI notes the PR workflow.
- Release: tag + GitHub release `v0.1.0` planned after everything is green
  (first public release).

## Verification

- Baseline before changes: root 39 files / 236 tests green, `tsc --noEmit`
  clean, plugin 4/4 green (~07:06Z).
- Plugin `npm ci` re-run from lockfile: see log.
- Per-commit gates: see log.
- Post-push: GitHub Actions run + Workers Builds build for the restructure
  push — recorded below when green.

## Log

- 2026-10-16: CI for `1e1fdb8` (license commit) confirmed green
  (`"success":true` in build logs).
- 2026-10-16 ~07:06Z: baseline gates green (root 236/236, tsc clean, plugin
  4/4).
- (append below as commits land)
