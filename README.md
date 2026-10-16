# brain

[![CI](https://github.com/taxin-404/brain/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/taxin-404/brain/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Personal memory for OpenCode sessions.** brain captures every session
automatically, distills it into durable facts, and recalls the right ones in
future sessions — privately, on your own Cloudflare account, inside the free
tier.

## What it is

- A **capture plugin** for [OpenCode](https://opencode.ai) — every session is
  ingested automatically. No "remember this" commands, no manual notes.
- A **memory worker** on Cloudflare Workers — events are redacted, encrypted,
  and stored in D1/R2; a background sweep extracts durable facts (people,
  preferences, projects, decisions…) and embeds them for search.
- **Recall for your assistant** — keyword + semantic search and an MCP server,
  so any future session can ask "what do I know about X?".
- A **review queue** — the assistant can *propose* changes to memory; only you
  apply them. Everything is audited, and reversible changes can be undone.
- **Self-maintenance** — nightly consolidation merges duplicates, temporary
  facts expire, and weekly/monthly reflections summarise recent memory.

Shipped as [v0.1.0](CHANGELOG.md) and verified end to end on a live
deployment.

## Why it's different

Most AI memory is either a hosted service that keeps your data, or a vector
store that only grows and never forgets.

- **Yours, end to end.** Runs in your own Cloudflare account — no third-party
  memory service ever sees your sessions.
- **Privacy by construction.** Secrets are redacted *before* storage; payloads
  are encrypted per event (AES-GCM with wrapped keys); anything marked
  `restricted` never reaches a model — and a leaked backup is useless without
  your key.
- **You stay in charge.** The assistant can only *propose* corrections, forgets,
  and procedures — applying and approving is human-only, every change is
  audited, and reversible ones can be undone.
- **Built to forget.** Hard deletes gated by single-use tokens, expiry for
  temporary facts, and a nightly consolidation pass — with offline evals that
  prove deleted data stays deleted.
- **Evidence over vibes.** Every fact carries provenance back to the source
  event, a `why` view shows the full version chain, and contradictions are
  handled deterministically — no silent rewrites.
- **Zero-effort capture.** Deep OpenCode integration (plugin + MCP), not a
  generic API you have to feed by hand.
- **Free-tier friendly.** Designed and live-run on Cloudflare's free tier, with
  an in-app budget breaker to keep it there.

## How it works

```text
 OpenCode session
       │   plugin: capture + redact
       ▼
 encrypted event store        D1 (metadata, FTS, facts) + R2 (payloads)
       │   */30 sweep: extract facts via AI Gateway (free-tier model)
       ▼
 facts + entities + embeddings          Vectorize (768-dim)
       │   blended keyword + semantic search
       ▼
 recall in future sessions · review queue · consolidation & reflections
```

1. **Capture** — the plugin ships session events to `POST /v1/events/batch`
   (secrets redacted on the way in, payloads encrypted per event).
2. **Distill** — every 30 minutes the sweep sends unprocessed excerpts to a
   free-tier Gemini model through Cloudflare's AI Gateway and lands facts with
   entities, embeddings, and provenance.
3. **Recall** — `GET /v1/search` blends FTS5 keyword and Vectorize semantic
   results (RRF); MCP tools (`recall`, `get_blocks`, …) expose it to the
   assistant in any session.
4. **Review** — proposals land in a queue; you apply, discard, or undo via
   REST (or the bundled read-only inspector page).
5. **Maintain** — crons consolidate duplicates nightly, expire temporary
   facts, write weekly/monthly reflections, and prune expired artifacts.

Deep dives: [`docs/design-v1.2.md`](docs/design-v1.2.md) (behavior authority) ·
[`docs/engineering.md`](docs/engineering.md) (phases, ops, CI, free-tier rules).

## Self-host quickstart

**Prerequisites:** Node 20+, a bash shell with `openssl`, a free Cloudflare
account, a free [Google AI Studio](https://aistudio.google.com) API key, and
[OpenCode](https://opencode.ai) for the client side.

```bash
git clone https://github.com/taxin-404/brain.git && cd brain
npm ci
npx wrangler login
```

**1. Provision resources**

```bash
npx wrangler d1 create brain-db        # paste the printed database_id into wrangler.jsonc
npx wrangler r2 bucket create brain-raw
npx wrangler vectorize create brain-memory --dimensions=768 --metric=cosine
for p in type status sensitivity; do
  npx wrangler vectorize create-metadata-index brain-memory --property-name="$p" --type=string
done
npx wrangler vectorize list-metadata-index brain-memory   # re-run until all three appear (async)
```

Create an AI Gateway named `brain` (dashboard → AI → AI Gateway), then edit
`wrangler.jsonc`:

- `d1_databases[0].database_id` → the id printed by `d1 create`
- `vars.AI_GATEWAY_BASE` → `https://gateway.ai.cloudflare.com/v1/<account_id>/brain/google-ai-studio`
  (`<account_id>`: dashboard sidebar, or `npx wrangler whoami`)

**2. Apply the schema**

```bash
npx wrangler d1 migrations apply brain-db --remote     # expect 0001–0006
```

**3. Generate secrets, escrow them, set them**

```bash
umask 077; mkdir -p .secrets
echo "PAYLOAD_KEK=$(openssl rand -base64 32)"   >> .secrets/prod.env
echo "CONTENT_HMAC_KEY=$(openssl rand -hex 32)" >> .secrets/prod.env
for s in MCP_READ_TOKEN MCP_PROPOSE_TOKEN ADMIN_TOKEN; do
  echo "$s=$(openssl rand -hex 32)" >> .secrets/prod.env
done
echo "GEMINI_API_KEY=" >> .secrets/prod.env     # now edit the file: paste your AI Studio key after the =
```

**Escrow `.secrets/prod.env` in your password manager before going further** —
lose `PAYLOAD_KEK` and encrypted payloads are unrecoverable forever. Then:

```bash
set -a; source .secrets/prod.env; set +a
for s in PAYLOAD_KEK CONTENT_HMAC_KEY MCP_READ_TOKEN MCP_PROPOSE_TOKEN ADMIN_TOKEN GEMINI_API_KEY; do
  printf '%s' "${!s}" | npx wrangler secret put "$s" --env=""
done
```

**4. Deploy and verify**

```bash
npm run deploy     # = wrangler deploy --env=""   (never use --env prod)
curl -s https://brain-api.<your-subdomain>.workers.dev/v1/health-report \
  -H "Authorization: Bearer $ADMIN_TOKEN"   # a fresh install answers with zeros
```

> **Free tier:** never run request loops or load tests against your deployed
> worker — verify with single-shot requests only. More rules:
> [`docs/engineering.md`](docs/engineering.md) § "Free-tier rules".

**5. Wire up OpenCode** — one-time plugin install, then add to
`~/.config/opencode/opencode.json` (paths, host, and tokens yours):

```bash
cd plugin && npm ci
```

```jsonc
{
  "plugins": [
    { "package": "/abs/path/to/brain/plugin",
      "options": { "endpoint": "https://brain-api.<your-subdomain>.workers.dev", "token": "<MCP_PROPOSE_TOKEN>" } }
  ],
  "mcp": {
    "brain":         { "type": "remote", "url": "https://brain-api.<your-subdomain>.workers.dev/mcp", "headers": { "Authorization": "Bearer <MCP_READ_TOKEN>" }, "enabled": true },
    "brain-propose": { "type": "remote", "url": "https://brain-api.<your-subdomain>.workers.dev/mcp", "headers": { "Authorization": "Bearer <MCP_PROPOSE_TOKEN>" }, "enabled": true }
  }
}
```

Two MCP entries on purpose: each connection carries exactly one token — `brain`
(read scope, always-safe recall) and `brain-propose` (write scope for
`remember` / `propose_*`, and the plugin's capture ingest). Use OpenCode for a
minute; capture is live when `/tmp/opencode/brain-capture-diag.log` shows
`ingest_ok`. Within ~30 minutes the first facts are extracted and recallable.

> The full walkthrough — escrow details, CI setup, every gotcha, and a
> troubleshooting table — is in [`docs/setup.md`](docs/setup.md).

## Documentation

| Doc | What it covers |
| --- | --- |
| [`docs/setup.md`](docs/setup.md) | Full setup: secrets flow, verification, troubleshooting |
| [`docs/engineering.md`](docs/engineering.md) | How each phase works, ops facts, deploy & CI, free-tier rules, agent notes |
| [`docs/design-v1.2.md`](docs/design-v1.2.md) | Design spec — authority for behavior, SQL, budgets |
| [`docs/maintenance.md`](docs/maintenance.md) | Releases, CI map, keeping in sync with related projects |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Dev loop, gates, repo anatomy, PR flow |
| [`SECURITY.md`](SECURITY.md) | Private vulnerability reporting |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |

## License

[MIT](LICENSE) © 2026 taxin-404 — self-host, fork, modify freely; just keep the copyright notice.
