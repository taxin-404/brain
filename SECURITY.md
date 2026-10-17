# Security policy

`brain` stores personal data and holds encryption keys, so security reports
are taken seriously — thank you for looking.

## Reporting a vulnerability

Use GitHub's private reporting:

**https://github.com/taxin-404/brain/security/advisories/new**

(Repository → *Security* → *Report a vulnerability*.) Please do **not** open a
public issue for anything exploitable.

Include what you can: affected route/file, a reproduction, and impact. This
is a personal project maintained best-effort — expect an acknowledgement when
the maintainer is next online, not an SLA.

## Scope

In scope: the Worker (`src/`), the capture plugin (`plugin/`), and the docs
where they misdescribe security-relevant behavior (setup, key rotation).

Known and by design — not vulnerabilities:

- The worker is single-owner: the admin token can do everything, on purpose.
- The `dev-*` tokens and `dev-kek`/`dev-hmac` values in `vitest.config.ts`
  are intentionally public and local-only. A production worker with missing
  real secrets never serves or stores data: until `PAYLOAD_KEK` and
  `ADMIN_TOKEN` are set it answers 503 `not configured` and skips schema
  bootstrap and crons.
- The free-tier AI provider may use non-`restricted` content to improve its
  products (documented in `docs/engineering.md` and the setup guide);
  `restricted` events never leave the system.

## Supported versions

Only the latest `master` (and the latest tag cut from it) is supported.
