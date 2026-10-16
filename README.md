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
a 30-minute sweep distills durable facts through AI Gateway, and future
sessions recall them via MCP — while the assistant can only *propose* memory
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
| AI processing | ❌ Their model, their key | ✅ **Your gateway, your key** | Only non-`restricted` excerpts |
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

1. Create the pieces in the [Cloudflare dashboard](https://dash.cloudflare.com/): a **D1** database `brain-db` (copy its ID), an **R2** bucket `brain-raw`, a **Vectorize** index `brain-memory` (768 dims, cosine) with string metadata indexes `type`, `status`, `sensitivity`, and an **AI Gateway** named `brain`. Grab a free [Google AI Studio](https://aistudio.google.com) API key.

2. **Fork** this repository, then edit `wrangler.jsonc` right in GitHub: paste your D1 database ID and set `vars.AI_GATEWAY_BASE` to `https://gateway.ai.cloudflare.com/v1/<account_id>/brain/google-ai-studio` (account ID is in the dashboard sidebar).

3. Apply the schema once from a terminal:
   `npx wrangler login` then `npx wrangler d1 migrations apply brain-db --remote`

4. In **Workers & Pages → Create → Continue with GitHub**, select your fork and set: name `brain-api`, build command `npm ci && npm test`, deploy command `npx wrangler deploy --env=""`, and **turn OFF preview builds**. Click **Deploy**.

5. The first deploy stops with *Missing required secrets* — on purpose. Add the values from [The envs](#the-envs) below under the Worker → **Settings → Variables and Secrets**, then hit **Retry deployment**.

6. `GET <worker-url>/v1/health-report` with your `ADMIN_TOKEN` — a fresh install answers with zeros. Then wire up OpenCode (see [docs/setup.md](./docs/setup.md) §7).

- The default `*.workers.dev` hostname works as-is; add a custom domain under Worker → **Settings → Domains & Routes**.
- Prefer the terminal end to end? → [CLI deploy](#cli-deploy) below.

### The envs

Everything the worker reads — the dashboard rows are what step 5 sets:

| Name | Set where | Value |
| --- | --- | --- |
| `AI_GATEWAY_BASE` | `wrangler.jsonc` (step 2) | `https://gateway.ai.cloudflare.com/v1/<account_id>/brain/google-ai-studio` |
| `PAYLOAD_KEK` | dashboard secret | any 32+ char random string — **escrow it; if lost, encrypted data is unrecoverable** |
| `CONTENT_HMAC_KEY` | dashboard secret | any 32+ char random string |
| `MCP_READ_TOKEN` | dashboard secret | any 32+ char random string — read scope |
| `MCP_PROPOSE_TOKEN` | dashboard secret | any 32+ char random string — write scope; must differ from the read token |
| `ADMIN_TOKEN` | dashboard secret | any 32+ char random string — admin routes |
| `GEMINI_API_KEY` | dashboard secret | a free key from [Google AI Studio](https://aistudio.google.com) |
| `GITHUB_TOKEN` | dashboard secret, *optional* | GitHub token for the activity connector; raises rate limits |

No format requirements on the random strings — your password manager's generator is enough (**make every value different**). The same list, with descriptions, ships in `package.json` (`cloudflare.bindings`) — so Cloudflare setup flows know what to ask for.

> [!TIP]
> brain is designed for the Cloudflare **free plan** — an in-app budget breaker
> pauses expensive writes at ~80k row-writes/day. Never run load tests against
> a deployed worker; verify with single-shot requests.

---

## FAQ

- **Why did my first deploy fail with "Missing required secrets"?**
  On purpose: `secrets.required` keeps a half-configured worker from serving traffic. Add the six secrets (step 5), then **Retry deployment**.

- **My assistant recalls nothing — is capture broken?**
  Facts appear after the next 30-minute sweep, and only sessions run *after* wiring the plugin are captured. Check capture health in `/tmp/opencode/brain-capture-diag.log` (`ingest_ok`); the [setup guide](./docs/setup.md) has a full verification checklist.

- **Every route answers 401 — what now?**
  Almost always a token mismatch: `MCP_READ_TOKEN`, `MCP_PROPOSE_TOKEN` and `ADMIN_TOKEN` must match what your clients send. Re-copy them under Worker → Settings → Variables and Secrets.

- **Is my content sent to an AI provider?**
  Yes — non-`restricted` excerpts go to Gemini through *your* AI Gateway and *your* key, for fact extraction and embeddings. Content marked `restricted`, and anything the redactor strips, never leaves the system. Details in [SECURITY.md](./SECURITY.md).

- **Where did a fact go?**
  Nothing is deleted without a single-use confirm token. Facts can be `superseded` (corrections keep the old version, visible via the `why` view) or `archived` when temporary facts expire by design.

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

# 1. resources — paste database_id into wrangler.jsonc, create the AI Gateway "brain" in the dashboard
npx wrangler d1 create brain-db
npx wrangler r2 bucket create brain-raw
npx wrangler vectorize create brain-memory --dimensions=768 --metric=cosine
for p in type status sensitivity; do
  npx wrangler vectorize create-metadata-index brain-memory --property-name="$p" --type=string
done

# 2. schema
npx wrangler d1 migrations apply brain-db --remote

# 3. secrets — generate, escrow, upload (exact snippet in docs/setup.md §3)

# 4. deploy
npm run deploy
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
