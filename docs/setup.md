# Setup — from zero to a running brain

Audience: the owner rebuilding this system, or an operator/agent reproducing it
on a fresh Cloudflare account. Every step here was exercised for the live
deployment (2026-10-15/16 — evidence in `.superpowers/sdd/*` ledgers and
`docs/dr-drill.md`). **No secret values appear in this file — generate your own.**

Placeholders used below: `<worker>` = your deployed host,
`brain-api.<your-subdomain>.workers.dev` (printed by `wrangler deploy`, or visible
in the dashboard). `<account_id>` = Cloudflare account id (dashboard right
sidebar, or `npx wrangler whoami`). The table shows this deployment's values as
a reference — yours will differ where marked.

| Piece | Value (this deployment) |
| --- | --- |
| Worker | `brain-api` → `https://brain-api.taxin-404.workers.dev` (subdomain marked yours) |
| D1 | `brain-db` (binding `BRAIN_DB`) |
| R2 | `brain-raw` (binding `BRAIN_RAW`) |
| Vectorize | `brain-memory` — 768 dims, cosine, metadata indexes on `type`/`status`/`sensitivity` |
| AI Gateway | id `brain`, provider path `google-ai-studio` |
| Schema | migrations `0001`–`0006` |
| Secrets | `PAYLOAD_KEK`, `CONTENT_HMAC_KEY`, `MCP_READ_TOKEN`, `MCP_PROPOSE_TOKEN`, `ADMIN_TOKEN`, `GEMINI_API_KEY` |
| Crons | `*/30` sweep · `0 3 * * *` consolidation · `0 4 * * 1` weekly · `0 4 1 * *` monthly |
| CI | Cloudflare Workers Builds on push to `master` |

## 0. Get the code + prerequisites

```bash
git clone https://github.com/taxin-404/brain.git && cd brain
npm ci                 # installs the pinned wrangler 4.x — run `npx wrangler ...` only after this
npx vitest run         # optional warm-up: the suite is fully offline (real workerd, zero network)
```

- Node 20+ and npm; a Cloudflare account (free tier is sufficient)
- A bash-compatible shell (macOS/Linux) with `openssl` — all snippets below are bash
- `npx wrangler login`
- A Google AI Studio API key ([aistudio.google.com](https://aistudio.google.com) → API keys; free tier works)
- Client side (optional): [opencode](https://opencode.ai) with this repo checked out at a stable path

Read `docs/engineering.md` §"Free-tier rules" before touching a deployed worker — **never
run request loops against it**; all tests run locally. Everything below assumes
you are in the repo root.

## 1. Provision Cloudflare resources

```bash
# 1. D1 — then paste the printed database_id into wrangler.jsonc (d1_databases[0].database_id)
npx wrangler d1 create brain-db

# 2. R2
npx wrangler r2 bucket create brain-raw

# 3. Vectorize + the three filter metadata indexes
npx wrangler vectorize create brain-memory --dimensions=768 --metric=cosine
for p in type status sensitivity; do
  npx wrangler vectorize create-metadata-index brain-memory --property-name="$p" --type=string
done
# index mutations are async — re-run this until all three appear in the listing:
npx wrangler vectorize list-metadata-index brain-memory
# (older wrangler spellings may use --propertyName)

# 4. AI Gateway — dashboard: AI → AI Gateway → Create gateway, id `brain`
#    (or with a management token: POST https://api.cloudflare.com/client/v4/accounts/<account_id>/ai-gateway/gateways  body: {"id":"brain","name":"brain"})
```

`wrangler.jsonc` edits for your account:

| Field | What to put |
| --- | --- |
| `d1_databases[0].database_id` | the id from step 1 |
| `vars.AI_GATEWAY_BASE` | `https://gateway.ai.cloudflare.com/v1/<account_id>/brain/google-ai-studio` |
| `name` (optional) | keep `brain-api` — worker names are account-scoped; only change for clarity |

Leave the rest alone: binding names, crons, and the `env` stubs (inert — see §4).

## 2. Apply the schema

```bash
npx wrangler d1 migrations apply brain-db --remote    # expect 0001–0006
# local dev only: drop --remote (or use --local together with `wrangler dev`)
```

## 3. Secrets — generate, escrow, set

| Secret | Purpose | Generate with |
| --- | --- | --- |
| `PAYLOAD_KEK` | wraps per-event data keys (payload encryption at rest) | `openssl rand -base64 32` |
| `CONTENT_HMAC_KEY` | signs export links / confirm tokens | `openssl rand -hex 32` |
| `MCP_READ_TOKEN` | read scope — REST reads + the `brain` MCP connection | `openssl rand -hex 32` |
| `MCP_PROPOSE_TOKEN` | propose scope — capture-plugin ingest + `brain-propose` MCP writes | `openssl rand -hex 32` |
| `ADMIN_TOKEN` | owner key — apply/discard, exports, purge, manual kicks | `openssl rand -hex 32` |
| `GEMINI_API_KEY` | Google AI Studio key (sent through the gateway) | AI Studio console |

```bash
# 1. Generate every value into .secrets/prod.env (gitignored via .secrets/).
#    One-time step: skipped if the file already exists — re-running would
#    regenerate PAYLOAD_KEK and orphan existing payloads (rotation: docs/key-rotation.md).
if [ -e .secrets/prod.env ]; then
  echo "NOTE: .secrets/prod.env already exists — generation skipped"
else
  umask 077; mkdir -p .secrets
  echo "PAYLOAD_KEK=$(openssl rand -base64 32)"   >> .secrets/prod.env
  echo "CONTENT_HMAC_KEY=$(openssl rand -hex 32)" >> .secrets/prod.env
  for s in MCP_READ_TOKEN MCP_PROPOSE_TOKEN ADMIN_TOKEN; do
    echo "$s=$(openssl rand -hex 32)" >> .secrets/prod.env
  done
  echo "GEMINI_API_KEY=" >> .secrets/prod.env   # edit the file: paste the AI Studio key after the =
fi

# 2. Escrow the file in your password manager FIRST (see below), then push all six
#    to the worker (piping works non-interactively; --env="" targets the top-level config):
set -a; source .secrets/prod.env; set +a
for s in PAYLOAD_KEK CONTENT_HMAC_KEY MCP_READ_TOKEN MCP_PROPOSE_TOKEN ADMIN_TOKEN GEMINI_API_KEY; do
  [ -n "${!s}" ] || { echo "ABORT: $s is empty — edit .secrets/prod.env, re-source, re-run"; break; }
  printf '%s' "${!s}" | npx wrangler secret put "$s" --env=""
done
```

- **Escrow before step 2.** `PAYLOAD_KEK` is irreplaceable: lose it (without
  escrow) and every stored payload is unreadable forever — that is what
  encryption at rest means. The other five are recoverable by regenerating,
  re-setting on the worker, and updating the client config, but escrow them too
  to avoid churn. Rotation procedure: `docs/key-rotation.md`.
- Later shells (for the curl examples below):
  `set -a; source .secrets/prod.env; set +a` re-exports `$ADMIN_TOKEN` etc.
- Keep local copies only in `.secrets/` — gitignored, and this repo is public.

## 4. Deploy

```bash
npm ci && npm test && npx tsc --noEmit    # local gate — green before any deploy
npm run deploy                            # = wrangler deploy --env=""
```

**Never `wrangler deploy --env prod`.** `wrangler.jsonc` carries inert
`env` stubs for future staging/prod isolation, but env blocks do **not** inherit
bindings (`d1_databases`, `r2_buckets`, Vectorize, secrets) — so an `--env prod`
deploy ships a worker with zero bindings whose endpoints all fail. Plain
`wrangler deploy` also targets the top-level config, but `npm run deploy` pins
`--env=""` so the intent cannot drift; every `secret put` in §3 passes it for
the same reason.

- Crons and observability activate from `wrangler.jsonc` automatically (4 of the 5 free cron slots).
- `secrets.required` makes a deploy **fail loudly** if any of the six secrets is
  missing. If one goes missing later (deleted by hand), the symptom is every
  authenticated route 401ing.
- CI (§6), when connected, runs the test suite on push; the local gate above
  additionally type-checks — keep both green.

## 5. Verify the worker (single-shot requests only)

```bash
set -a; source .secrets/prod.env; set +a   # defines $ADMIN_TOKEN
curl -s https://<worker>/v1/health-report -H "Authorization: Bearer $ADMIN_TOKEN"
```

A fresh install answers with zeros (`events: 0`, `budget.used: 0`, no
consolidation run yet). `wrangler tail` is the live log path. The Workers
Observability telemetry API is optional and needs a token with `Workers
Observability Write` (it 403s without one) — nothing in setup requires it;
`wrangler tail` + the health report cover normal ops.

## 6. CI — Workers Builds (dashboard)

Connect the repo so every push to `master` builds, tests, and deploys the
worker automatically. Two dashboard paths, same result — use whichever you
reach first. (Requires the repo under your own GitHub account — fork or push
the clone there.)

**A. Fresh import** — dashboard → *Workers & Pages* → *Create* →
**Continue with GitHub** (authorize the *Cloudflare Workers and Pages* GitHub
App for the repo) → **Select a repository** → **Set up your application** with
exactly these values:

| Field | Value |
| --- | --- |
| Project name | **must equal the worker `name` in `wrangler.jsonc`** — `brain-api` for a stock checkout. The dashboard pre-fills the repo name (`brain`); change it to match before clicking Deploy. |
| Build command | `npm ci && npm test` — shown as optional, but this is the gate: a red suite blocks the deploy. |
| Deploy command | replace the default `npx wrangler deploy` with `npx wrangler deploy --env=""` (same rule as §4 — an env flag would deploy a worker with zero bindings). |
| Preview command | leave the default (`npx wrangler preview`) — unused below. |
| Enable Preview builds | **turn OFF** — previews would run against the same prod D1/R2; there is no preview isolation yet. |
| Protect with Cloudflare Access | leave OFF — the worker authenticates with its own tokens. |

Click **Deploy**. Complete §2–§4 first: `secrets.required` makes the deploy
step fail loudly if the six secrets are not on the worker yet — set them, then
re-run the build. Every later push to `master` runs the same pipeline.

**B. Existing worker** — dashboard → *Workers & Pages* → `brain-api` →
*Settings* → *Builds* → connect the GitHub repo, production branch `master`,
same build/deploy commands as above. Do not configure preview builds.

Whichever path you used, confirm afterwards that **no preview builds are
listed** in the project settings.

If push-triggered builds go silent, first check the *Cloudflare Workers and
Pages* GitHub App still has repo access (docs/engineering.md §"Deploy & CI" has the exact
link, plus the builds API and a manual-trigger curl for agents).

## 7. Client — capture + MCP (opencode)

One-time, install plugin deps:

```bash
cd plugin && npm i
```

Edit `~/.config/opencode/opencode.json` (merge with existing keys; `/abs/path/to/brain/plugin` = where you cloned this repo):

```jsonc
{
  "plugins": [
    {
      "package": "/abs/path/to/brain/plugin",
      "options": {
        "endpoint": "https://<worker>",
        "token": "<MCP_PROPOSE_TOKEN>"
      }
    }
  ],
  "mcp": {
    "brain": {
      "type": "remote",
      "url": "https://<worker>/mcp",
      "headers": { "Authorization": "Bearer <MCP_READ_TOKEN>" },
      "enabled": true
    },
    "brain-propose": {
      "type": "remote",
      "url": "https://<worker>/mcp",
      "headers": { "Authorization": "Bearer <MCP_PROPOSE_TOKEN>" },
      "enabled": true
    }
  }
}
```

Why two entries: the tokens hold disjoint scopes and each MCP connection carries
exactly one. `brain` (read token) is the standing, always-safe surface — write
tools list but refuse with `MCP_PROPOSE scope required`. `brain-propose`
(propose token) is what the assistant uses when you ask it to write (`remember`,
`propose_*`). A single propose-authed entry would also serve reads — but then
every session would carry write scope by default. The plugin additionally uses
its propose token for `/v1/events/batch` capture ingest.

After saving, MCP servers hot-reload; the plugin loads on the next session
start. Diagnostics land in `/tmp/opencode/brain-capture-diag.log` (`ingest_ok`
lines; plugin console output is invisible in server logs).

## 8. Verify the client

1. Use opencode for a minute → the diag log shows `ingest_start` / `ingest_ok`.
2. Through the assistant, run MCP `health_report` — `events` should be climbing.
3. Propose a working-memory block via MCP `propose_block_edit` (the six blocks:
   `identity`, `preferences`, `active_projects`, `infrastructure`, `constraints`,
   `objective` — block edits are always manual review), then approve it as the
   owner:

```bash
# list pending proposals
curl -s https://<worker>/v1/proposals -H "Authorization: Bearer $ADMIN_TOKEN"
# apply one (also: /discard and /undo)
curl -s -X POST https://<worker>/v1/proposals/<id>/apply \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"initial setup approval"}'
```

4. Within ~30 min (next `:00`/`:30` sweep): health shows extractions draining
   (`pending`/`done` moving, `failed` staying 0) and facts becoming recallable
   (ask the assistant to `recall` something you discussed).

## 9. Operations

- **Automatic:** capture (plugin, near real-time) · extraction sweep (≤40 events,
  ≤4 Gemini calls per run) · nightly consolidation `03:00Z` · weekly/monthly
  reflections · the sweep also prunes expired export artifacts, confirm tokens,
  and lapsed proposals · budget breaker at 80k rows/day (70k warns).
- **Gated:** working-memory blocks (6 fixed keys) change only via owner
  apply/direct PUT; forget/procedure proposals are always manual; the only auto
  tier is user-evidenced, non-sensitive fact corrections/disputes.
- **Free-tier behaviour:** Gemini 429s retry ×3, then fall back to
  `gemini-3.1-flash-lite`; extraction failures requeue as `pending` until the
  3rd attempt, then surface as `failed` in health — requeue manually with:

  ```bash
  curl -s -X POST https://<worker>/v1/extract \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
    -d '{}'      # optional clamps: {"max_events":100,"max_calls":10}
  ```

  Nothing is silently lost.
- **Backups / DR:** export + clean-account restore are drill-verified
  (`docs/dr-drill.md`); exports are on-demand, 15-min signed links, artifacts
  pruned after expiry.
- **Rotations:** `docs/key-rotation.md` (KEK; needs the old KEK still in escrow).

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Every authenticated route 401s | a secret is missing/different on the worker | `npx wrangler secret list`; re-put; deploys should have failed via `secrets.required` |
| Worker runs but D1/R2 calls fail, bindings undefined | deployed with `--env prod` | redeploy with `npm run deploy` |
| Push builds stop triggering | GitHub App lost repo access | re-connect the Workers and Pages app (docs/engineering.md §"Deploy & CI") |
| `403` with "blocked access based on your browser's signature" | scripted User-Agent (e.g. python-urllib) hits the edge bot filter | probe with `curl` or a normal UA |
| `wrangler r2 object list` prints help | subcommand doesn't exist in wrangler 4.x | verify prefix state with `r2 object get` absence probes |
| Gemini 429s in logs | free-tier rate limits | absorbed by retry + fallback; check health `failed`; requeue with the §9 curl |
| Dashboard shows error counts | historical windows (build-out era, fixed overnight) | compare a fresh window; counts roll off as the window ages out |
| Export link 403s | signed TTL expired (15 min, renewed per slice while driven) | start a new export job |

Development loop, tests, and agent rules are in `CONTRIBUTING.md` and
`docs/engineering.md` §"For AI agents"; the capture-plugin gotcha (sessions come from the global event
stream, `ctx.session` has no `list`) is in the Phase 1 ledger.
