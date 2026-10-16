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
- Release: `v0.1.0` tagged and published after everything went green (first
  public release).

## Verification

- Baseline before changes: root 39 files / 236 tests green, `tsc --noEmit`
  clean, plugin 4/4 green (~07:06Z).
- Plugin `npm ci` re-run from lockfile: see log.
- Per-commit gates: see log.
- Post-push: GitHub Actions run + Workers Builds build for the restructure
  push — both green (see Log).
- Second push (ledger close-out): watched as well — see Log below.

## Log

- 2026-10-16: CI for `1e1fdb8` (license commit) confirmed green
  (`"success":true` in build logs).
- 2026-10-16 ~07:06Z: baseline gates green (root 236/236, tsc clean, plugin
  4/4).
- 2026-10-16 ~07:15Z: restructure pushed (`1e1fdb8..563371a`, 3 commits).
- 2026-10-16 ~07:17Z: GitHub Actions run
  [38865651403](https://github.com/taxin-404/brain/actions/runs/38865651403)
  — **success** (both jobs: worker suite + typecheck, plugin suite +
  typecheck; first run of the new workflow).
- 2026-10-16 ~07:20Z: Workers Builds `9f52fe5b-9e8d-495c-808c-72b6bf88dbd6`
  — build + deploy success, `"success":true`, freshness-checked.
- 2026-10-16 ~07:30Z: `v0.1.0` tagged and released (first public release).
- 2026-10-16: owner feedback — README still developer-facing; a normal user
  wants the easiest setup plus what/why/how it's different. Action taken (same
  additive ruling — no functional code touched):
  - New user-first README: what it is, why it's different, how it works
    (pipeline + 5 stages), self-host quickstart condensed from the tested
    `docs/setup.md`, slim docs table.
  - Phases, progress table, ops facts, Deploy & CI, free-tier rules, agent
    notes, and the full read-first map moved to `docs/engineering.md`.
  - Cross-references updated (setup.md, maintenance.md, CONTRIBUTING,
    SECURITY); CHANGELOG `[Unreleased]` notes the change.
  - Pushed as `d2c7597` (`e436619..d2c7597`). Verification: GitHub Actions run
    [38871860143](https://github.com/taxin-404/brain/actions/runs/38871860143)
    — success (both jobs); Workers Builds
    `27843d1d-8ae0-458a-98ce-e9f593bd435b` — build + deploy success,
    `"success":true`, freshness-checked.
- 2026-10-16: owner flagged that the setup guide was missing the Workers
  dashboard import flow (screenshots: *Workers & Pages → Create → Continue
  with GitHub → Select a repository → Set up your application*). Action taken:
  - `docs/setup.md` §6 rewritten — path A (fresh import) with exact field
    values: project name must equal the wrangler `name` (`brain-api`; the
    form pre-fills the repo name `brain`), build command `npm ci && npm test`,
    deploy command `npx wrangler deploy --env=""`, preview command default,
    **Enable Preview builds OFF**, Cloudflare Access OFF; note that
    `secrets.required` fails the first deploy loudly until §3 secrets exist
    (intended — set them and re-run); path B (existing worker → Settings →
    Builds) kept.
  - `docs/engineering.md`: stale "5 secrets" corrected to the six required
    (adds `GEMINI_API_KEY`, matching `wrangler.jsonc`).
  - CHANGELOG `[Unreleased]` → Added.
  - Account check while writing: workers list = `brain-api`, `gdrive`,
    `nodewarden`, `responsive-web-design`, `terabox` — the owner's dashboard
    walk-through created no stray `brain` worker.
  - Pushed as `0c88e16` (`6f79692..0c88e16`). Verification: GitHub Actions
    run [38872780546](https://github.com/taxin-404/brain/actions/runs/38872780546)
    — success (both jobs); Workers Builds
    `361b0a16-1b51-4b59-92d1-53c0bae47454` — 236/236 tests, build + deploy
    success, `"success":true` (version `5f423e5e-59bc-4402-8742-8a31b3d25133`).
