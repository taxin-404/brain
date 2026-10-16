# Any-AI-provider support — design

Date: 2026-10-16 · Status: draft — waiting for owner approval · Author: assistant, at the owner's direction
(Revised after an independent builder-check review; the five gaps it found are resolved below.)

## Intent

Fork users of brain may not have — or want — a Google account. Today both AI
touchpoints (fact extraction and embeddings) are hard-wired to Gemini: the
model names are constants, the requests are in Google's format, and the key is
`GEMINI_API_KEY`. Goal: whoever deploys brain plugs in whichever AI API they
already have — OpenAI, Anthropic, OpenRouter, Workers AI, a local server —
through configuration alone.

## Settled with the owner (conversation 2026-10-16)

- "Any AI API" = the **OpenAI-compatible format** as the universal adapter.
  Google, Anthropic and OpenRouter all offer OpenAI-compatible endpoints, and
  local servers (Ollama, LM Studio) speak it — so we generalize once instead
  of hand-coding a client per provider.
- **Google stays the default.** Existing deployments and the free-tier
  promise keep working unchanged — same wire calls, same envs.
- **Embeddings are configurable separately** from extraction, because some
  providers do one but not the other (Anthropic has no embeddings).
- Provider choice is **configuration only** — no source edits.

## Goals / non-goals

Goals:

- A non-Google deployment is possible with config values alone.
- The default deployment is behavior-identical to today.
- Setup stays dashboard-first (no terminal required).
- Clear, actionable errors for missing config and embedding-size mismatches.
- Switching a model or size is never silent (a standing project principle —
  see Current state).

Non-goals (this iteration):

- Native protocols per provider beyond the existing Gemini path.
- Per-task model overrides (different models for extract vs consolidate vs
  reflect — one extraction model remains).
- Auto-recreating the Vectorize index (a documented dashboard/CLI step) or a
  separate bulk re-embed tool — re-embedding rides the existing sweep
  backfill, which this design makes signature-aware.
- Provider auto-detection or cross-vendor failover routing.
- A configuration UI.

Anti-goals:

- Changing the default deployment's wire format (risk with no benefit).
- Requiring source edits to switch providers.
- Silently accepting model or dimension mismatches.
- Weakening the deploy-time secrets check for the default install.

## Current state (verified from source)

- `src/llm.ts` is the only AI client:
  - Constants: `EXTRACTION_MODEL` `gemini-3.5-flash-lite`, fallback
    `gemini-3.1-flash-lite`, `EMBEDDING_MODEL` `gemini-embedding-001`,
    `EMBEDDING_DIMS` 768, `EMBED_CHUNK` 10.
  - `postJson(env, path, body)` → POST `${env.AI_GATEWAY_BASE}${path}` with
    header `x-goog-api-key: env.GEMINI_API_KEY`; retries 429/5xx/network up to
    3 attempts (500ms × attempt); other 4xx fail fast.
  - Chat: `/v1beta/models/{model}:generateContent` in Gemini's body shape;
    response text from `candidates[0].content.parts[].text`; usage from
    `usageMetadata`. The reply is JSON-parsed and validated by each caller.
  - `geminiJson`: primary model; on availability-class failures (network /
    404 / 429 / 5xx) one more attempt on the fallback model.
  - Embeddings: `/v1beta/models/{model}:batchEmbedContents` in chunks of 10
    with `outputDimensionality: 768`; validates count and dims.
- Callers: `extract.ts`, `consolidate.ts`, `reflect.ts` (chat, via
  `geminiJson`); `search.ts` (query vector) and `embed.ts` (fact backfill)
  via `embedTexts`.
- `embed.ts` upserts vectors with metadata `embedding_model`, sets `vec_id`
  on success, and re-tries facts **whose `vec_id IS NULL`** on later sweeps
  (`DEFAULT_MAX` 100 per run). It does *not* look at `facts.embedding_model`.
- `factstore.ts` writes the `facts.embedding_model` column at fact creation
  (the Gemini constant today). The column is **never read or updated
  afterwards** — nothing else touches it.
- Project principle (master design `docs/design-v1.2.md`, Vectorize section):
  "changing embedding model = new index + full re-embed (documented
  migration, **never silent**)". The master design already anticipated
  alternatives (Workers AI `bge-base-en-v1.5`, 768 dims).
- `src/env.ts`: `AI_GATEWAY_BASE` (var) + `GEMINI_API_KEY` (secret) on the
  `Env` type; `wrangler.jsonc` `secrets.required` lists six secrets
  including `GEMINI_API_KEY`.
- The Vectorize binding exposes `describe()` (`VectorizeIndexInfo` with
  `dimensions`) — usable for a real index-size guard.
- Tests: `test/llm.test.ts` and friends mock HTTP with msw
  (`network.use(http.post(...))`) against a fake base URL; everything runs
  offline. 39 files / 236 tests.

## New configuration surface (all optional — unset means today's behavior)

| Env | Kind | Meaning |
| --- | --- | --- |
| `AI_BASE_URL` | var | OpenAI-compatible base URL for **extraction** (e.g. `https://api.openai.com/v1`) |
| `AI_API_KEY` | secret | Key for compat calls; falls back to `GEMINI_API_KEY` if unset |
| `AI_MODEL` | var | Extraction model name; required when `AI_BASE_URL` is set |
| `AI_FALLBACK_MODEL` | var | Second model for availability-class failures; optional |
| `AI_EMBED_BASE_URL` | var | Embeddings base if different from the chat provider's; the literal `native` forces the Gemini-native path |
| `AI_EMBED_API_KEY` | secret | Embeddings key; default `AI_API_KEY` → `GEMINI_API_KEY` |
| `AI_EMBED_MODEL` | var | Embeddings model name; required in compat embeddings mode |
| `AI_EMBED_DIMS` | var | Expected vector size; default 768; must equal the index's (≤ 1536) |

Resolution rules:

- Extraction is in **compat mode** iff `AI_BASE_URL` is set; otherwise the
  existing Gemini-native path runs, unchanged.
- Embeddings are in compat mode iff `AI_EMBED_BASE_URL` or `AI_BASE_URL` is
  set. Base = `AI_EMBED_BASE_URL ?? AI_BASE_URL`; the literal value `native`
  selects the Gemini-native path instead (requires `AI_GATEWAY_BASE` +
  `GEMINI_API_KEY` — documented for "another provider for chat, Gemini for
  embeddings" setups).
- Keys resolve per surface as listed, so a single-provider deployment can use
  one key via `AI_API_KEY`.
- **Keyless compat servers** (local/tunneled, no auth) are supported: when no
  key resolves, the compat client omits the `Authorization` header entirely
  (no dummy values). A provider that wants a key answers 401 and names the
  problem.
- Missing required values (`AI_MODEL`, `AI_EMBED_MODEL`) or a baseless
  `native` sentinel fail at call time with a clear `LlmError` naming the
  missing env — not at deploy time.

## Compat-mode behavior contract

Chat — `POST {base}/chat/completions`:

- Headers: `content-type: application/json`, plus `authorization: Bearer
  {key}` only when a key resolves.
- Body: `model`, `messages` (a system message only when provided),
  `temperature` (default 0.2), `max_tokens` (`maxOutputTokens`, default
  2048), and best-effort `response_format: {type: "json_object"}`.
- JSON-mode is opportunistic: if the first attempt is rejected with a 400
  whose body mentions `response_format`, retry once without it. (The prompts
  already demand JSON and every reply is parsed + validated regardless.)
- Response: `choices[0].message.content` → `JSON.parse` → the caller's
  `validate()`; failures raise the same `LlmError("parse")` as today. Usage:
  `usage.prompt_tokens` / `usage.completion_tokens` (0 when absent).
- Retry policy identical to the native path (3 attempts; 429/5xx/network
  retried; other 4xx fail fast).
- Fallback: availability-class failures + `AI_FALLBACK_MODEL` set → one more
  call with that model. Without a configured fallback there is no silent
  model substitution.

Embeddings — `POST {base}/embeddings`:

- Body: `model`, `input: string[]` (chunked at `EMBED_CHUNK`), plus
  `dimensions: {AI_EMBED_DIMS}` **only when `AI_EMBED_DIMS` is explicitly
  set** — some providers reject unknown fields.
- Response: `data[].embedding`; order by `index` when present; validate the
  count and that every vector's length equals the expected dims (default
  768). Mismatch → `LlmError("parse")` naming both numbers.
- **Index-size guard:** before embedding, `VECTORIZE.describe()` (cached per
  run) is compared with the expected dims; a mismatch raises a loud,
  actionable error naming both values and the fix (recreate the index at the
  configured size, or fix `AI_EMBED_DIMS`). This turns today's silent
  upsert-failure loop + keyword-only fallback into a named error.
- The effective identity written into Vectorize metadata and the
  `facts.embedding_model` column = **`{model}@{dims}`** (see below).

Gemini-native path: behavior, constants, messages and fallback logic stay as
they are. `postJson` and friends gain a small compat branch inside `llm.ts`;
prefer a couple of clear internal functions over an abstraction framework.

## Switching models or sizes (never silent)

`facts.embedding_model` and the Vectorize metadata record the effective
`{model}@{dims}` signature. The backfill's selection widens from
`vec_id IS NULL` to **`vec_id IS NULL OR recorded signature ≠ current`**,
with one compatibility rule: a legacy plain-model value (e.g.
`gemini-embedding-001`, what the default deployment has) counts as matching
its own model at 768 dims — so upgrading the default deployment re-embeds
nothing, while any real model or size switch re-embeds gradually through the
existing sweep pacing. After a re-embed, the row's signature is updated.

Consequences:

- **Same-dims model switch** → automatic catch-up re-embed; no mixed
  old/new vectors beyond the transition window; no terminal.
- **Size change** → recreate the index at the new size (dashboard or CLI,
  documented), set `AI_EMBED_DIMS`; the signature mismatch triggers the
  catch-up. The index-size guard catches config/index mismatches loudly.
- Master-design wording "new index + full re-embed, never silent" is
  satisfied mechanically: the recreation is the documented step, the
  re-embed rides the built-in backfill.

## Config-file and scaffolding changes

- `wrangler.jsonc`: unchanged for the default deployment. Non-Google forks
  add the `AI_*` vars (dashboard vars persist because `keep_vars: true`) and
  swap the `GEMINI_API_KEY` entry in `secrets.required` for `AI_API_KEY` —
  a one-line edit in the fork, documented in the setup guide.
- Code scope beyond `llm.ts`: `factstore.ts` and `embed.ts` write the
  signature; `embed.ts` selection widens as described.
- `package.json` `cloudflare.bindings`: describe the new envs (dashboard
  prompts, same as the existing chart).
- README + `docs/setup.md`: an optional "bring your own AI provider"
  section — example configs (OpenAI, OpenRouter, Workers AI's
  OpenAI-compatible endpoint, a tunneled local server — note Workers cannot
  reach LAN addresses directly), the `native` sentinel for mixing, the
  embedding-size note, and **no AI Gateway required in compat mode**.
- `SECURITY.md`: provider-neutral wording for the "content goes to the AI
  provider" flow.
- Health (optional, small): `/v1/health-report` may report the active AI
  mode + model names (never keys) and the re-embed backlog count (facts
  whose signature differs). Builder may trim this if it balloons.

## Testing

- Extend `test/llm.test.ts` (and embeddings tests) with the existing msw
  convention: compat chat request shape (URL, Bearer header, body fields),
  response parsing + usage, retries, fallback, the `response_format`
  400-degrade path, and the keyless no-header case; compat embeddings
  (array input, dims validation, `dimensions` param only when set, error
  messages), the `native` sentinel, and the index-size guard (mocked
  `describe()`).
- Backfill switching tests: signature mismatch re-embeds; legacy plain
  values do not; signatures update after re-embed.
- Config-resolution matrix as unit tests.
- All 236 existing tests stay green (native path untouched).
- Live check after deploy: the default deployment must behave identically —
  single-shot health call + one recall. No load, no loops (free tier).

## Constraints that bind the build

- Worker runtime only; fetch-only adapter — no new dependencies.
- Free-tier discipline: local gates before commits (`npx vitest run`,
  `npx tsc --noEmit`), one commit per task, ledger close-out, single-shot
  production checks, no secrets in the repository (it is public).
- Every push watched green (GitHub Actions + Workers Builds).

## Left to the builder

- Message wording and internal layout inside `llm.ts`.
- The exact SQL/normalization for the signature comparison and whether any
  index/storage shorthand is needed for it.
- Whether single-string embeddings input needs an adaptive retry for picky
  providers.
- Health-report field shape (if included).
- Test-file organization and exact README / setup-guide wording.
- Anything else the plan needs that this document does not promise.

## Owner calls made during design (check these while reading)

1. Compat mode as an *added* path rather than rewriting the default to the
   OpenAI format — keeps production byte-identical.
2. `secrets.required` list stays as-is; non-Google users make the one-line
   swap — keeps deploy-time fail-loud for the default install.
3. `dimensions` is sent only when `AI_EMBED_DIMS` is set — avoids providers
   that reject unknown request fields.
4. Google stays the default provider and the AI Gateway stays on the default
   path; compat mode needs no gateway.
5. **Model/size switches re-embed automatically** through the existing sweep
   backfill (signature-aware) — satisfies "never silent" without requiring a
   terminal; the gradual pace bounds provider cost.
6. **Keyless compat servers get no `Authorization` header** (no dummy
   secrets); a provider that needs a key answers 401.
7. **`AI_EMBED_BASE_URL=native`** lets a compat-chat deployment keep Gemini
   for embeddings (the reverse mixing, "non-Google chat" + native path,
   simply works by leaving the default).
