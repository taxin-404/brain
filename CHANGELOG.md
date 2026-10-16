# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0: minor versions may change behavior; patch versions are fixes only.

## [Unreleased]

### Added

- The setup guide now walks the Workers Builds dashboard import flow —
  project name, build / deploy / preview field values, preview builds off —
  in [`docs/setup.md`](docs/setup.md) §6.
- The quick deploy now ships an **env chart** (README → *Visual quick deploy*
  → *The envs*): every value the worker reads, where to set it, and what to
  put — and `package.json` declares `cloudflare.bindings` descriptions so
  Cloudflare setup flows know what to prompt for. `GITHUB_TOKEN` (optional)
  is documented in [`docs/setup.md`](docs/setup.md) §3.

### Changed

- README is now user-facing (what it is / why it's different / quickstart);
  the engineer and operator notes moved to
  [`docs/engineering.md`](docs/engineering.md).
- README rebuilt in a NodeWarden-style product layout: centered logo banner
  ([`brain.svg`](brain.svg)), feature-comparison table, visual (dashboard)
  quick deploy, FAQ, credits.

## [0.1.0] — 2026-10-16

First public release: the full system, built and live-verified 2026-10-15/16
(phases 0–6 of the [design doc](docs/design-v1.2.md)). 39 test files /
236 worker tests plus 4 plugin tests, all offline.

### Added

- **Capture** — OpenCode plugin (`plugin/`): event-sourced session capture
  with idle-triggered ingest and a 30-minute reconcile backstop; secrets are
  redacted before anything is stored.
- **Worker core** — D1 schema with append-only triggers and FTS5
  (`migrations/0001–0006`); encrypted, idempotent ingest
  (`POST /v1/events/batch`); per-event payload encryption (AES-GCM envelope),
  keyed HMAC, ULID ids; write budget with warn/breaker thresholds; scoped
  token auth (read / propose / admin) with strict scope separation; health
  endpoint.
- **Privacy** — secret redaction for payloads and excerpts; `restricted`
  events never reach the model; crypto-shred purge gated by single-use
  confirm tokens.
- **Recall** — FTS keyword search and audited working-memory blocks;
  stateless MCP server exposing read + propose tools only (an agent cannot
  apply its own proposals).
- **Semantic layer** — fact extraction through the AI Gateway (pinned
  Gemini flash-lite with availability fallback), 768-dim embeddings in
  Vectorize, blended RRF search (semantic + keyword, with recency and
  confidence modifiers), reviewable proposals with expiry.
- **Review engine** — apply / discard / undo REST; correction supersession
  with full provenance; deterministic contradiction handling
  (supersede / dispute / coexist); `why` version chains; entity views.
- **Self-maintenance** — crons: `*/30` extraction sweep, nightly
  consolidation, weekly/monthly reflections; the health route reports all
  three.
- **Procedures** — versioned, human-approved procedures: agents can propose,
  only an admin token can approve, and every new version needs its own
  approval.
- **Reach** — GitHub activity connector (external trust, deterministic ids);
  backup and portable export profiles with HMAC-signed download links;
  clean-account restore proof; read-only inspector page.
- **Docs** — approved design spec, phase plans, key-rotation and DR-drill
  procedures, from-zero setup guide, and this release's project scaffolding
  (CONTRIBUTING, SECURITY, CI, issue/PR templates, maintenance guide).
- **Eval gates** — offline keyword / semantic / forget / consolidation /
  procedure / restore evals pinning the design doc's "done when" sentences;
  a single-shot `npm run eval:live` harness.

### Security

- No secrets in the repository: production values live in Worker secrets and
  `.secrets/` (gitignored); `secrets.required` fails deploys loudly when a
  key is missing.
- MIT licensed (© 2026 taxin-404).

[Unreleased]: https://github.com/taxin-404/brain/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/taxin-404/brain/releases/tag/v0.1.0
