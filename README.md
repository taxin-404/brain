<p align="center">
  <img src="./brain.svg" alt="brain" />
</p>

<p align="center">
  Personal memory for OpenCode sessions, running on Cloudflare Workers
</p>

<p align="center">
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Powered%20by-Cloudflare-F38020?logo=cloudflare&logoColor=white" alt="Powered by Cloudflare" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-2ea44f" alt="License: MIT" /></a>
  <a href="https://github.com/taxin-404/brain/releases/latest"><img src="https://img.shields.io/github/v/release/taxin-404/brain?display_name=tag" alt="Latest release" /></a>
  <a href="https://github.com/taxin-404/brain/actions/workflows/ci.yml"><img src="https://github.com/taxin-404/brain/actions/workflows/ci.yml/badge.svg?branch=master" alt="CI" /></a>
</p>

<p align="center">
  <a href="./docs/setup.md">Setup guide</a> |
  <a href="./docs/engineering.md">Engineering notes</a> |
  <a href="./CONTRIBUTING.md">Contributing</a> |
  <a href="./SECURITY.md">Security</a>
</p>

> **Note**
> brain stores sensitive personal memory — run your own deployment, and never point your assistant at someone else's worker.
> Free-tier AI providers may use non-`restricted` content to improve their products; see [SECURITY.md](./SECURITY.md).

Your OpenCode session flows through a capture plugin (redacts + encrypts),
a 30-minute sweep distills durable facts with Gemini (or any OpenAI-compatible
provider), and future sessions recall them via MCP — while the assistant can only *propose* memory
changes that **you** review.

---

## Feature comparison with typical AI memory

| Feature | Typical AI memory | brain | Notes |
| --- | --- | --- | --- |
| Where your data lives | ❌ Vendor cloud | ✅ **Your Cloudflare account** | D1 + R2 + Vectorize, in your account |
| Session capture | ❌ Manual "remember this" | ✅ **Automatic** | OpenCode plugin captures every session |
| Memory model | ❌ Raw text chunks | ✅ **Distilled facts** | Entities, dedupe, provenance — not a chunk pile |
| Secret redaction | ❌ | ✅ **Before storage** | Stripped on ingest, before any model sees it |
| Encryption at rest | ⚠️ Vendor-managed | ✅ **Your keys** | Per-event AES-GCM; the KEK stays yours |
| Hard delete | ⚠️ Varies | ✅ **Crypto-shred** | Single-use confirm tokens; payload key destroyed |
| Assistant writes | ❌ Direct edits | ✅ **Propose-only** | You apply / discard / undo; every change audited |
| Contradictions | ⚠️ Silent overwrite | ✅ **Deterministic** | Supersede or dispute — never silent |
| Provenance | ⚠️ Partial | ✅ **`why` view** | Fact → full version chain → source events |
| Duplicate facts | ❌ Append-only growth | ✅ **Nightly consolidation** | Merges only with independent evidence |
| Reflections | ❌ | ✅ **Weekly + monthly** | Evidence-backed summaries you can review |
| AI processing | ❌ Their model, their key | ✅ **Your provider, your key** | Only non-`restricted` excerpts |
| Cost | ❌ Subscription | ✅ **Cloudflare free tier** | + capped Gemini free tier; budget breaker included |
| License | ❌ Proprietary | ✅ **MIT** | Fork, extend, self-host |

---

## Tested with

- ✅ OpenCode — capture plugin + MCP recall/propose, live-verified end to end
- ✅ HTTP clients — Bearer/JSON routes verified with single-shot `curl` against the live worker
- ✅ Browser — bundled read-only inspector page
- ⚠️ Other agent platforms not verified yet — the HTTP API is plain Bearer/JSON

---

## Visual quick deploy

No terminal, no file editing — a few minutes in your browser.

1. **Fork** this repository, then grab a free [Google AI Studio](https://aistudio.google.com) API key.

2. In **Workers & Pages → Create → Continue with GitHub**, select your fork and set: name `brain-api` (the dashboard pre-fills the repo name `brain` — change it to match `wrangler.jsonc`), build command `npm ci && npm test`, deploy command `npm run deploy`, and **turn OFF preview builds**. Click **Deploy**. The first run goes green and provisions D1 `brain-db`, R2 `brain-raw` and the Vectorize index `brain-memory` into *your* account — no secrets needed for it, and nothing ever blocks on them. The database schema applies on the first configured request.

3. Pick the missing values straight from the worker: `GET <worker-url>/v1/health-report` answers `503 {"error":"not configured","missing":[…]}` — no credentials needed — until the secrets are set. Add the three required values from [The envs](#the-envs) below under the Worker → **Settings → Variables and Secrets** (the other three there are optional hardening); the next request is live.

4. `GET <worker-url>/v1/health-report` with your `ADMIN_TOKEN` — a fresh install answers with zeros. Then wire up OpenCode (see [docs/setup.md](./docs/setup.md) §7).

- The default `*.workers.dev` hostname works as-is; add a custom domain under Worker → **Settings → Domains & Routes**.
- Optional: route Gemini through **your AI Gateway** (analytics, caching) — create one in the dashboard, then add an `AI_GATEWAY_BASE` variable (see the envs table). Unset, calls go straight to Google.
- Prefer the terminal end to end? → [CLI deploy](#cli-deploy) below.

### If the first build isn't green

- **Read the deploy line.** A typo in the deploy command is the most common
  failure: the log's last lines show `Executing user deploy command: ...` — it
  must be exactly `npm run deploy` (fix the field, rebuild/retry).
- **Zero bindings / no D1 / no R2 — and no build runs at all** means the worker
  was created through the plain *Hello World* path instead of **Continue with
  GitHub**: the placeholder deploy carries nothing, and without a repo
  connect nothing ever remains. Delete that worker and re-create it per
  step 2 — the git-import is what wires the build commands that run `npm run
  deploy` (which provisions D1 `brain-db`, R2 `brain-raw` and the Vectorize
  index).
- **Log noise ≠ failure.** `gw.test` DNS errors, *Binding VECTORIZE needs to
 be run remotely*, and ndjson `.text()` warnings are normal test-runner
  output — the suite is green; the truth is the final
  `Test Files ... passed` line and whether the deploy step ran.

### The envs

Everything the worker reads. Three secrets are required (what step 3 sets) — deploys don't block on them; the worker itself lists any that are missing. The optional rows default to something sensible:

| Name | Set where | Value |
| --- | --- | --- |
| `PAYLOAD_KEK` | dashboard secret | any 32+ char random string — **escrow it; if lost, encrypted data is unrecoverable** |
| `CONTENT_HMAC_KEY` | dashboard secret, *optional* | any 32+ char random string — unset, signing is derived from `PAYLOAD_KEK`; set to decouple the two |
| `MCP_READ_TOKEN` | dashboard secret, *optional* | any 32+ char random string — read scope; unset, reads use `ADMIN_TOKEN` |
| `MCP_PROPOSE_TOKEN` | dashboard secret, *optional* | any 32+ char random string — write scope; unset, writes use `ADMIN_TOKEN`; must differ from the read token when set |
| `ADMIN_TOKEN` | dashboard secret | any 32+ char random string — admin routes |
| `GEMINI_API_KEY` | dashboard secret | a free key from [Google AI Studio](https://aistudio.google.com) |
| `AI_GATEWAY_BASE` | dashboard variable, *optional* | `https://gateway.ai.cloudflare.com/v1/<account_id>/brain/google-ai-studio` — routes Gemini through your AI Gateway; unset = straight to Google |
| `GITHUB_TOKEN` | dashboard secret, *optional* | GitHub token for the activity connector; raises rate limits |

No format requirements on the random strings — your password manager's generator is enough (**make every value different**). Minimal setup is the three required values; every optional secret you add buys one property (derived signing vs. a dedicated key; shared admin vs. scoped client tokens). The same list, with descriptions, ships in `package.json` (`cloudflare.bindings`) — so Cloudflare setup flows know what to ask for.

**Store every value before you paste it** — the dashboard shows a secret's content exactly once, and two of them have a second life outside it: `ADMIN_TOKEN` (and, later, the optional `MCP_*` tokens) are the credentials your AI client pastes into its own config in step 4 / [docs/setup.md](./docs/setup.md) §7. The crypto keys (`PAYLOAD_KEK`, `CONTENT_HMAC_KEY`) and provider keys (`GEMINI_API_KEY`, `GITHUB_TOKEN`) stay worker-side — their escrow copy exists purely for disaster recovery: a fresh install restores from a backup with the KEK alone.

**Optional — run on any AI provider.** Chat (extraction and reasoning) and embeddings can each run on any OpenAI-compatible API — configuration only, no code:

| Name | Set where | Value |
| --- | --- | --- |
| `AI_BASE_URL` | dashboard variable | any OpenAI-compatible chat base URL, e.g. `https://api.openai.com/v1` |
| `AI_API_KEY` | dashboard secret | bearer key for that provider; falls back to `GEMINI_API_KEY`; leave both unset for keyless endpoints |
| `AI_MODEL` | dashboard variable | chat model name (e.g. `gpt-4.1-mini`); required when `AI_BASE_URL` is set |
| `AI_FALLBACK_MODEL` | dashboard variable, *optional* | second model tried when the provider is down or rate-limited |
| `AI_EMBED_BASE_URL` | dashboard variable, *optional* | embeddings base URL; the literal `native` keeps Gemini embeddings |
| `AI_EMBED_API_KEY` | dashboard secret, *optional* | bearer key for embeddings; falls back to `AI_API_KEY`, then `GEMINI_API_KEY` |
| `AI_EMBED_MODEL` | dashboard variable, *optional* | embeddings model (e.g. `text-embedding-3-small`); required when embeddings resolve to a compatible provider |
| `AI_EMBED_DIMS` | dashboard variable, *optional* | embedding size 1–1536 (default 768); must match your Vectorize index |

- **Nothing to do by default** — with no `AI_*` set, everything runs on Gemini exactly as before.
- **To switch providers**, set the `AI_*` values in the dashboard; for a fully non-Google setup just leave `GEMINI_API_KEY` unset — nothing blocks on it (AI misconfiguration shows up in the health report, not as deploy errors).
- **Changing the embedding model or size** re-embeds the stored backlog in the background over the next sweeps, and your prompts go only to the provider you configure.

> [!TIP]
> brain is designed for the Cloudflare **free plan** — an in-app budget breaker
> pauses expensive writes at ~80k row-writes/day. Never run load tests against
> a deployed worker; verify with single-shot requests.

---

## FAQ

- **The worker answers `503 not configured` — what now?**
  It names exactly what's missing (`missing: […]`). Add those values under Worker → Settings → Variables and Secrets; deployments never block on secrets — the worker reports them itself until they exist.

- **The build failed at the deploy step with error 10159 — what now?**
  Your build token could not create the `brain-memory` index. Create it in the dashboard — Vectorize → **Create index** → `brain-memory`, 768 dims, cosine, metadata indexes `type`/`status`/`sensitivity` (string) — then **Retry deployment**.

- **My assistant recalls nothing — is capture broken?**
  Facts appear after the next 30-minute sweep, and only sessions run *after* wiring the plugin are captured. Check capture health in `/tmp/opencode/brain-capture-diag.log` (`ingest_ok`); the [setup guide](./docs/setup.md) has a full verification checklist.

- **Every route answers 401 — what now?**
  Almost always a token mismatch: the worker only accepts the tokens that are actually set — with no `MCP_*` tokens, clients must send `ADMIN_TOKEN`. Re-copy the values under Worker → Settings → Variables and Secrets.

- **Is my content sent to an AI provider?**
  Yes — non-`restricted` excerpts go to Gemini with *your* key (through *your* AI Gateway when configured), for fact extraction and embeddings. Content marked `restricted`, and anything the redactor strips, never leaves the system. Details in [SECURITY.md](./SECURITY.md).

- **Where did a fact go?**
  Nothing is deleted without a single-use confirm token. Facts can be `superseded` (corrections keep the old version, visible via the `why` view) or `archived` when temporary facts expire by design.

---

## Removing / starting over

- **Delete the Worker** (Workers & Pages → `brain-api` → Settings → Delete): your memory survives — D1 `brain-db`, R2 `brain-raw` and Vectorize `brain-memory` are separate resources that deleting the worker never touches. Re-connect the repo later and the same data is waiting.
- **Full wipe:** delete the Worker, then D1 `brain-db`, R2 `brain-raw`, Vectorize `brain-memory`, your AI Gateway (if you made one), and the GitHub connection under Workers & Pages → Settings. Delete the fork on GitHub too.
- **Heads-up:** deleting the Worker deletes its secrets — including `PAYLOAD_KEK`. Encrypted rows survive but become unreadable without your escrowed copy. That is also the master delete: shred the KEK and the memory is cryptographically gone.

---

## How to update

- **Fork:** when GitHub shows the sync banner, click **Sync fork** → **Update branch** — Workers Builds redeploys automatically.
- **Clone:** `git pull` (Workers Builds deploys on push, or run `npm run deploy`).

---

## CLI deploy

```bash
git clone https://github.com/taxin-404/brain.git
cd brain
npm ci
npx wrangler login

# 1. deploy first — green on a fresh account, no secrets required for it.
#    Provisions D1 brain-db, R2 brain-raw and the Vectorize index; the worker
#    answers 503 `not configured` (with the missing names) until step 2.
npm run deploy

# 2. secrets — generate + escrow (exact snippet in docs/setup.md §3), then:
set -a; source .secrets/prod.env; set +a
for s in PAYLOAD_KEK ADMIN_TOKEN GEMINI_API_KEY; do
  printf '%s' "${!s}" | npx wrangler secret put "$s" --env=""
done
```

Full walkthrough with every gotcha: [docs/setup.md](./docs/setup.md).

---

## Documentation

[Setup](./docs/setup.md) · [Engineering notes](./docs/engineering.md) ·
[Design](./docs/design-v1.2.md) · [Maintenance](./docs/maintenance.md) ·
[Changelog](./CHANGELOG.md)

## License

MIT — see [LICENSE](./LICENSE).

## Credits

- [Cloudflare Workers](https://workers.cloudflare.com/) — platform (Workers · D1 · R2 · Vectorize · AI Gateway)
- [Google Gemini](https://ai.google.dev/) — fact extraction + embeddings, free tier
- [OpenCode](https://opencode.ai) — the agent this captures
- [mem0](https://github.com/mem0ai/mem0) — its `mem0-server` OpenCode plugin was the same-role reference for ours (ideas ported by hand, no code copied)
- [NodeWarden](https://github.com/shuaiplus/NodeWarden) — README layout inspiration
