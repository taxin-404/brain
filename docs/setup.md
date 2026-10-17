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
| AI Gateway | id `brain` — optional; this deployment routes through it via the `AI_GATEWAY_BASE` secret |
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

Mostly automatic: `npm run deploy` (§4) provisions these into your account on
the first run — **and no IDs are pasted into `wrangler.jsonc`, by design, so
forks can never inherit someone else's account.**

- D1 `brain-db` — the id-less binding auto-creates it (or re-links it by name)
- R2 `brain-raw` — same
- Vectorize `brain-memory` (768 dims, cosine) + the `type`/`status`/`sensitivity`
  string metadata indexes — `scripts/ensure-vectorize.mjs` creates these before
  every deploy, because Vectorize (unlike D1/R2) is **not** auto-provisioned and
  a missing index fails the deploy with error 10159

To pre-create the Vectorize pieces by hand instead (or if your build token lacks
Vectorize permission):

```bash
npx wrangler vectorize create brain-memory --dimensions=768 --metric=cosine
for p in type status sensitivity; do
  npx wrangler vectorize create-metadata-index brain-memory --property-name="$p" --type=string
done
# index mutations are async — re-run this until all three appear in the listing:
npx wrangler vectorize list-metadata-index brain-memory
# (older wrangler spellings may use --propertyName)
```

**Optional — AI Gateway.** Dashboard: AI → AI Gateway → Create gateway, id
`brain`, then add `AI_GATEWAY_BASE` on the Worker (Settings → Variables and
Secrets) with value
`https://gateway.ai.cloudflare.com/v1/<account_id>/brain/google-ai-studio`
(agent path: `POST https://api.cloudflare.com/client/v4/accounts/<account_id>/ai-gateway/gateways`
body `{"id":"brain","name":"brain"}`). Leave it unset and Gemini calls go
straight to Google — everything else is identical.

## 2. The schema — no step needed

The migrations (`0001`–`0006`) are embedded into the worker at build time and
applied atomically on the first request (and on cron ticks), recorded in the
standard `d1_migrations` table:

```bash
# confirm after the first request (informational)
npx wrangler d1 execute brain-db --remote --command "SELECT name FROM d1_migrations"
```

`wrangler d1 migrations apply` stays interoperable — same table, same names —
so the CLI path still works if you prefer applying by hand:

```bash
npx wrangler d1 migrations apply brain-db --remote    # optional; identical result
# local dev only: drop --remote (or use --local together with `wrangler dev`)
```

## 3. Secrets — generate, escrow, set

| Secret | Purpose | Generate with |
| --- | --- | --- |
| `PAYLOAD_KEK` | wraps per-event data keys (payload encryption at rest) | `openssl rand -base64 32` |
| `ADMIN_TOKEN` | owner key — apply/discard, exports, purge, manual kicks; also the fallback credential for both scopes below | `openssl rand -hex 32` |
| `GEMINI_API_KEY` | Google AI Studio key (sent through your AI Gateway when `AI_GATEWAY_BASE` is set) | AI Studio console |
| `CONTENT_HMAC_KEY` | *optional* — signs export links / confirm tokens; unset, signing derives from `PAYLOAD_KEK` | `openssl rand -hex 32` |
| `MCP_READ_TOKEN` | *optional* — read scope (REST reads + the `brain` MCP connection); unset, `ADMIN_TOKEN` is the read credential | `openssl rand -hex 32` |
| `MCP_PROPOSE_TOKEN` | *optional* — propose scope (capture-plugin ingest + `brain-propose` MCP writes); unset, `ADMIN_TOKEN` writes | `openssl rand -hex 32` |
| `GITHUB_TOKEN` | *optional* — GitHub activity connector (raises rate limits) | GitHub → Developer settings → PAT |

The required set is three: `PAYLOAD_KEK`, `ADMIN_TOKEN`, `GEMINI_API_KEY`. The
optional rows have working defaults — add them whenever you want key separation
and scoped clients. One ordering note: setting `CONTENT_HMAC_KEY` *after* events
exist changes content keys (dedupe/integrity) and invalidates outstanding export
links, so add it (if you want it) before real capture starts; the two tokens can
be added at any time.

The `openssl` generators above are convenience: any long random string works —
there are no format requirements (the KEK is SHA-256-stretched before use).
Dashboard-first version of this list: README → *Visual quick deploy* → *The
envs*.

**Optional: non-Google AI provider.** Chat (extraction, reasoning) and
embeddings can each run on any OpenAI-compatible API — set `AI_BASE_URL` +
`AI_MODEL` (+ `AI_API_KEY`; keyless works) for chat, and `AI_EMBED_BASE_URL` /
`AI_EMBED_MODEL` / `AI_EMBED_DIMS` for embeddings (`AI_EMBED_BASE_URL=native`
keeps Gemini embeddings). With no `AI_*` set, everything runs on Gemini exactly
as before. For a fully non-Google setup just leave `GEMINI_API_KEY` unset —
nothing blocks on it (there is no deploy-time secret gate). Changing the
embedding model or size re-embeds stored facts in the background over the next
sweeps. Full table: README → *The envs*.

```bash
# 1. Generate the required values into .secrets/prod.env (gitignored via .secrets/).
#    One-time step: skipped if the file already exists — re-running would
#    regenerate PAYLOAD_KEK and orphan existing payloads (rotation: docs/key-rotation.md).
if [ -e .secrets/prod.env ]; then
  echo "NOTE: .secrets/prod.env already exists — generation skipped"
else
  umask 077; mkdir -p .secrets
  echo "PAYLOAD_KEK=$(openssl rand -base64 32)" >> .secrets/prod.env
  echo "ADMIN_TOKEN=$(openssl rand -hex 32)"    >> .secrets/prod.env
  echo "GEMINI_API_KEY=" >> .secrets/prod.env   # edit the file: paste the AI Studio key after the =
  # Optional hardening — uncomment any line before the first deploy to add it:
  #echo "CONTENT_HMAC_KEY=$(openssl rand -hex 32)"  >> .secrets/prod.env  # signing key decoupled from the KEK
  #echo "MCP_READ_TOKEN=$(openssl rand -hex 32)"    >> .secrets/prod.env  # read-only client token
  #echo "MCP_PROPOSE_TOKEN=$(openssl rand -hex 32)" >> .secrets/prod.env  # write-scoped client token
  # (Nothing to add here for a non-Google provider: the optional AI_* values
  #  are set in the dashboard — see "Optional: non-Google AI provider" above.)
fi

# 2. Escrow the file in your password manager FIRST (see below) — then deploy
#    and set the secrets; deploys never block on secrets (the worker answers
#    503 `not configured` naming them until they exist).
```

**Deploy first, set secrets second.** `wrangler secret put` needs the worker to
exist, and deploys never block on secrets — so a fresh account (or a re-set
after rotation) is one sequence:

```bash
npm run deploy   # green on a fresh account; provisions D1, R2 and the Vectorize index
set -a; source .secrets/prod.env; set +a
# Required three — abort if any is empty:
for s in PAYLOAD_KEK ADMIN_TOKEN GEMINI_API_KEY; do
  [ -n "${!s}" ] || { echo "ABORT: $s is empty — edit .secrets/prod.env, re-source, re-run"; break; }
  printf '%s' "${!s}" | npx wrangler secret put "$s" --env=""
done
# Optional three — set only when present in the file:
for s in CONTENT_HMAC_KEY MCP_READ_TOKEN MCP_PROPOSE_TOKEN; do
  [ -n "${!s}" ] && printf '%s' "${!s}" | npx wrangler secret put "$s" --env=""
done
```

Between the deploy and the `put`s, `GET <worker>/v1/health-report` answers
`503 {"error":"not configured","missing":[…]}` with no credentials — that list
is the checklist. Re-run the same loop any time to re-set or rotate values (no
redeploy needed).

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
npm run deploy                            # = ensure-vectorize + wrangler deploy --env=""
```

Deploys never block on secrets: a worker without them deploys green and reports
what is missing itself — `503 {"error":"not configured","missing":[…]}`,
readable with no credentials (§3). Every deploy also re-checks (and provisions,
when missing) the Vectorize index before uploading.

**Never `wrangler deploy --env prod`.** `wrangler.jsonc` carries inert
`env` stubs for future staging/prod isolation, but env blocks do **not** inherit
bindings (`d1_databases`, `r2_buckets`, Vectorize, secrets) — so an `--env prod`
deploy ships a worker with zero bindings whose endpoints all fail. Plain
`wrangler deploy` also targets the top-level config, but `npm run deploy` pins
`--env=""` so the intent cannot drift; every `secret put` in §3 passes it for
the same reason.

- Crons and observability activate from `wrangler.jsonc` automatically (4 of the 5 free cron slots).
- Missing secrets never fail a deploy — the worker reports them (503
  `not configured`, §3). If one is deleted later, the same 503 appears; if only
  a token value drifts from what a client sends, the symptom is 401s.
- CI (§6), when connected, runs the test suite on push; the local gate above
  additionally type-checks — keep both green.

## 5. Verify the worker (single-shot requests only)

```bash
set -a; source .secrets/prod.env; set +a   # defines $ADMIN_TOKEN
curl -s https://<worker>/v1/health-report -H "Authorization: Bearer $ADMIN_TOKEN"
```

Before the secrets are set this answers `503 {"error":"not configured",
"missing":[…]}` — no credentials needed for that one response, and it is the
checklist. Once set, a fresh install answers with zeros (`events: 0`,
`budget.used: 0`, no consolidation run yet). `wrangler tail` is the live log path. The Workers
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
| Deploy command | `npm run deploy` — the script provisions the Vectorize index, then runs `wrangler deploy --env=""` (the `--env=""` pins the top-level config — an env flag would deploy a worker with zero bindings). |
| Preview command | leave the default (`npx wrangler preview`) — unused below. |
| Enable Preview builds | **turn OFF** — previews would run against the same prod D1/R2; there is no preview isolation yet. |
| Protect with Cloudflare Access | leave OFF — the worker authenticates with its own tokens. |

Click **Deploy**. The first build goes green even before secrets exist — it
creates D1 `brain-db`, R2 `brain-raw` and the Vectorize index (observed on a
fresh account 2026-10-17), and the worker answers 503 `not configured` until
you set the secrets (§3). Every later push to `master` runs the same pipeline.

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

**Minimal setup (no `MCP_*` tokens on the worker):** put `ADMIN_TOKEN` in the
plugin `token` and in both MCP `Authorization` headers. The admin token covers
every scope — the dedicated tokens exist to scope clients *down*, and can be
added later without touching the worker or this config.

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
| Every authenticated route 401s | a token value on the worker differs from what the client sends | `npx wrangler secret list`; re-put with §3's loop |
| `503 {"error":"not configured","missing":[…]}` | `PAYLOAD_KEK` / `ADMIN_TOKEN` not set yet | set the listed names (§3); the response is the checklist |
| Deploy fails with error `10159` (Vectorize) | build token could not create/see `brain-memory` | create it in the dashboard (768, cosine + metadata indexes) and retry |
| `503 server not ready: schema bootstrap failed` | the first-request schema bootstrap hit a D1 error | check `wrangler tail` — the log names the failing migration; it retries on the next request. Persistent failure on a hand-made schema: reconcile with `npx wrangler d1 migrations apply brain-db --remote` |
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
