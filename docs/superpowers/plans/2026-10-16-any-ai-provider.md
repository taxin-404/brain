# Any-AI-provider (OpenAI-compatible) — implementation plan

> **Spec:** `docs/superpowers/specs/2026-10-16-any-ai-provider-design.md` (read it first).
> Conflict rule: the spec wins on intent; this plan wins on names, shapes, and values.

## Goal

Make `brain`'s AI layer provider-agnostic, config-only:

- **No new envs set ⇒ today's Gemini behavior, byte-identical.**
- `AI_BASE_URL` (+ `AI_MODEL`) moves chat (extraction, consolidation, reflection) to any OpenAI-compatible API.
- `AI_EMBED_*` moves embeddings independently; `AI_EMBED_BASE_URL=native` keeps Gemini embeddings while chat runs elsewhere.
- Fork users change envs only — no code edits, no gateway required, keyless local endpoints allowed.
- A model/dims switch re-embeds the backlog in the background; dimensional mismatches fail loudly, never corrupt silently.

## Architecture (what exists after this plan)

- `src/llm.ts` stays the single AI client. Two pure resolvers — `chatConfig(env)` and `embedConfig(env)` — turn env into `{ mode: "native" | "compat", base, key, model, ... }`; every call branches on `mode`.
- **Compat chat:** `POST {base}/chat/completions` — `Authorization: Bearer <key>` omitted when no key resolves; body `messages` (`system?` + `user`), `temperature` (default 0.2), `max_tokens` (default 2048), `response_format: { type: "json_object" }`; parse `choices[0].message.content` as JSON; usage from `usage.prompt_tokens` / `usage.completion_tokens`. A 400 mentioning `response_format` retries **once** without it. Availability failures (network / 404 / 429 / 5xx) retry per attempt like today, then try `AI_FALLBACK_MODEL` once if configured, else fail.
- **Compat embeddings:** `POST {base}/embeddings` — `{ model, input[] }`; `dimensions` included **only** when `AI_EMBED_DIMS` is explicitly set; parse `data[].embedding`, ordered by `index` when present.
- **Embedding identity** = signature `` `${model}@${dims}` `` stored in `facts.embedding_model` and vector metadata. The backfill selects rows whose signature differs (bare `gemini-embedding-001` counts as the 768 default) and re-embeds them. A `VECTORIZE.describe()` guard turns an index/config dims mismatch into a named `LlmError("config")` instead of a silent upsert-failure loop.
- `/v1/health-report` gains an `ai` block (mode / model / dims / index match / re-embed backlog) so a fork user can see what their worker resolved.

## Tech stack

Cloudflare Workers (global `fetch` only — no SDKs), D1, Vectorize; vitest via `@cloudflare/vitest-plugin` + `@msw/cloudflare` (`test/server.ts`; `onUnhandledFrame: "error"` means any unmocked outbound request fails the test). **No new dependencies.**

## Global constraints

- Unset `AI_*` ⇒ behavior identical to today. `wrangler.jsonc` is **not touched**: the default deploy keeps `GEMINI_API_KEY` in `secrets.required`; non-Google forks remove that one line and add `AI_*` vars (docs only, Task 6).
- Tests never touch the network; free-tier discipline: all gates run locally, prod checks are single-shot (Task 7 only, never loops).
- Public repo: never print or commit secret values; tests use fake values only.
- **Gate before every commit:** `npx vitest run` (unpiped — run it and read the tail) **and** `npx tsc --noEmit`. Both green, always.
- One commit per task, conventional subject. **Push once at the end** (Task 7) after all gates pass; then watch CI + Workers build and fix-forward if red. This keeps prod to one deploy for the feature.
- Node 26 (`.nvmrc`). Match the existing comment style (short, why-focused).

## Review Focus

The spec's five failure classes — each must be pinned by the named tests:

1. **No-Google fork / keyless compat** — no `Authorization` header when no key resolves; `GEMINI_API_KEY` absent is legal in compat mode. → T1 cases 4 & 7; T2 "omits the Authorization header…"; T3 keyless case.
2. **Existing prod upgrade, no churn** — legacy bare `gemini-embedding-001` rows and NULL-with-vector rows are **not** re-embedded by a default deploy. → T4 "does not re-embed legacy…" + "stamps legacy NULL rows…".
3. **Misconfiguration is loud** — `AI_BASE_URL` without `AI_MODEL` (and embed equivalents) → `LlmError` code `"config"` naming the env; `/v1/health-report` still returns **200** with the error visible. → T1 cases 5 & 8; T5 errors test.
4. **Provider without JSON mode** — a 400 that mentions `response_format` triggers exactly one retry without it. → T2 degrade test.
5. **Dimensional safety** — wrong-size vectors → `LlmError("parse")` naming both numbers and the fix; configured dims ≠ index dims → `LlmError("config")` naming both; a `{model}@{dims}` change re-embeds while a bare legacy value does not. → T3 dims tests; T4 guard + signature tests.

## Interfaces (build exactly this)

```ts
// src/env.ts — add to `Env` (all optional; defaults = today's behavior)
AI_BASE_URL?: string;
AI_API_KEY?: string;
AI_MODEL?: string;
AI_FALLBACK_MODEL?: string;
AI_EMBED_BASE_URL?: string; // literal "native" = force the Gemini embeddings path
AI_EMBED_API_KEY?: string;
AI_EMBED_MODEL?: string;
AI_EMBED_DIMS?: string;     // string env; parsed as an integer

// src/llm.ts
// LlmError code union gains "config" (http | network | parse | config)
export interface ChatConfig {
  mode: "native" | "compat";
  base: string;
  key?: string;
  model: string;
  fallback?: string;
}
export interface EmbedConfig {
  mode: "native" | "compat";
  base: string;
  key?: string;
  model: string;
  dims: number;
  dimsExplicit: boolean;
  signature: string; // `${model}@${dims}`
}
export function chatConfig(env: Env): ChatConfig;
export function embedConfig(env: Env): EmbedConfig;
export function embeddingSignature(env: Env): string; // embedConfig(env).signature

// Renamed — same signature, compat branch inside:
export async function llmJson<T>(
  env: Env,
  input: { model?: string; system?: string; user: string; maxOutputTokens?: number; temperature?: number },
  validate: (v: unknown) => T,
): Promise<{ value: T; tokensIn: number; tokensOut: number; model: string }>;

// Same signature; native/compat branch inside:
export async function embedTexts(env: Env, texts: string[]): Promise<number[][]>;

// test/helpers.ts
export function setEnvVars(vars: Record<string, string | undefined>): void; // undefined deletes the key
export function installFakeVectorize(opts?: { dims?: number }): Map<string, StoredVector>; // describe() reports dims, default 768
```

Resolution rules (exact):

```
chatConfig(env):
  AI_BASE_URL set → compat:
    AI_MODEL missing → LlmError("config", "AI_MODEL is required when AI_BASE_URL is set")
    base = AI_BASE_URL with trailing slashes stripped
    key  = first non-empty of [AI_API_KEY, GEMINI_API_KEY]   ("" and undefined both count as absent)
    model = AI_MODEL; fallback = AI_FALLBACK_MODEL (may be undefined)
  else native:
    AI_GATEWAY_BASE missing → LlmError("config", "AI_GATEWAY_BASE is required for the Gemini path (or set AI_BASE_URL for a compatible provider)")
    GEMINI_API_KEY missing  → LlmError("config", "GEMINI_API_KEY is required for the Gemini path (or set AI_BASE_URL for a compatible provider)")
    base = AI_GATEWAY_BASE; key = GEMINI_API_KEY; model = EXTRACTION_MODEL; fallback = EXTRACTION_FALLBACK_MODEL

embedConfig(env):
  dims: AI_EMBED_DIMS unset → EMBEDDING_DIMS (768)
        else Number(raw) must be an integer 1..1536 →
          LlmError("config", `AI_EMBED_DIMS must be an integer from 1 to 1536 (got "${raw}")`)
  source: AI_EMBED_BASE_URL === "native"        → native
          else AI_EMBED_BASE_URL set            → compat(base = it)
          else AI_BASE_URL set                  → compat(base = it)
          else                                  → native
  compat: AI_EMBED_MODEL missing →
          LlmError("config", "AI_EMBED_MODEL is required when the embedding path uses a compatible provider (set AI_EMBED_BASE_URL=native to keep Gemini embeddings)")
        key = first non-empty of [AI_EMBED_API_KEY, AI_API_KEY, GEMINI_API_KEY] (may be undefined)
        model = AI_EMBED_MODEL; base = stripped
  native: same AI_GATEWAY_BASE + GEMINI_API_KEY checks as chat; model = EMBEDDING_MODEL
  signature = `${model}@${dims}`; dimsExplicit = AI_EMBED_DIMS !== undefined
```

## Files touched

| File | Task |
| --- | --- |
| `src/env.ts` | T1 |
| `src/llm.ts` | T1–T3 |
| `src/extract.ts` | T2 (rename), T4 (embed try/catch) |
| `src/consolidate.ts`, `src/reflect.ts` | T2 (rename only) |
| `src/factstore.ts`, `src/embed.ts` | T4 |
| `src/health.ts` | T5 |
| `src/search.ts` | none — branches live inside `embedTexts` |
| `test/helpers.ts` | T2 (`setEnvVars`), T4 (`installFakeVectorize` dims) |
| `test/llm.test.ts` | T1–T3 |
| `test/embed.test.ts`, `test/extract.test.ts` | T4 |
| `test/health.test.ts` | T5 |
| `test/factstore.test.ts` + suite-wide expectation fixes | T4 (where the suite says so) |
| `package.json`, `README.md`, `docs/setup.md`, `.dev.vars.example`, `CHANGELOG.md` | T6 |
| `.superpowers/sdd/…` ledger | T7 |

---

## Task 1 — AI config resolution + env surface

**Files:** `src/env.ts`, `src/llm.ts`, `test/llm.test.ts`

1. `src/env.ts`: add the eight optional `AI_*` fields with one-line JSDoc each (what it does, what unset means).
2. `src/llm.ts`: extend `LlmError`'s code union with `"config"`; add `ChatConfig`, `EmbedConfig`, and `chatConfig` / `embedConfig` / `embeddingSignature` implementing the resolution rules above. Do **not** touch `postJson`, `generate`, `geminiJson`, or `embedTexts` yet.
3. `test/llm.test.ts`: add `describe("ai provider config resolution")`. Pass literal env objects (`{ ... } as unknown as Env`) — no proxy needed for resolution tests. Cases:
   1. native chat default: `{ AI_GATEWAY_BASE: "https://gw.test/x", GEMINI_API_KEY: "g" }` → `{ mode: "native", base: "https://gw.test/x", key: "g", model: "gemini-3.5-flash-lite", fallback: "gemini-3.1-flash-lite" }` (use the exported constants).
   2. compat chat: `AI_BASE_URL: "https://api.test/v1/"` (trailing slash), `AI_API_KEY: "sk-test"`, `AI_MODEL: "oai-model"`, `AI_FALLBACK_MODEL: "oai-fallback"` → `mode: "compat"`, `base: "https://api.test/v1"` (stripped), key/model/fallback as set.
   3. compat key falls back to `GEMINI_API_KEY` when `AI_API_KEY` unset.
   4. keyless: `AI_BASE_URL` + `AI_MODEL` only → `key: undefined`.
   5. `AI_BASE_URL` without `AI_MODEL` → rejects `{ code: "config" }`, message `/AI_MODEL/`.
   6. missing `AI_GATEWAY_BASE` on native → rejects `{ code: "config" }`, message `/AI_GATEWAY_BASE/` (check order: gateway before key).
   7. native embed default: → `{ mode: "native", model: "gemini-embedding-001", dims: 768, dimsExplicit: false, signature: "gemini-embedding-001@768" }`.
   8. embed inherits compat chat base and **requires** `AI_EMBED_MODEL`: with `AI_BASE_URL` + `AI_MODEL` + `GEMINI_API_KEY: "g"` → rejects `/AI_EMBED_MODEL/`; adding `AI_EMBED_MODEL: "text-embedding-3-small"` → compat, base inherited, `key: "g"`, `signature: "text-embedding-3-small@768"`.
   9. `AI_EMBED_BASE_URL: "native"` + `AI_BASE_URL` set → embed `mode: "native"`.
   10. `AI_EMBED_BASE_URL: "https://emb.test/v1"` + `AI_EMBED_MODEL` + `AI_EMBED_API_KEY: "ek"` → compat on that base, key `"ek"`.
   11. `AI_EMBED_DIMS: "1536"` → `dims: 1536`, `dimsExplicit: true`, `signature: "gemini-embedding-001@1536"`.
   12. `AI_EMBED_DIMS` of `"abc"`, `"0"`, `"1537"` → rejects `{ code: "config" }`, message `/AI_EMBED_DIMS/`.
   13. `embeddingSignature(env) === embedConfig(env).signature` for one case.
4. **Gate:** `npx vitest run` + `npx tsc --noEmit` (existing suite must stay green — this task is additive).
5. **Commit:** `feat(llm): resolve AI provider config from env (Gemini default, compatible option)`

## Task 2 — OpenAI-compatible chat + `llmJson` rename

**Files:** `src/llm.ts`, `src/extract.ts`, `src/consolidate.ts`, `src/reflect.ts`, `test/helpers.ts`, `test/llm.test.ts`

1. `test/helpers.ts`: add `setEnvVars(vars)` — same writable env-proxy seam as `installFakeVectorize` (line ~90): `undefined` deletes the key, else assigns a string.
2. `src/llm.ts`:
   - Rename `geminiJson` → `llmJson`. New body: `const cfg = chatConfig(env); const primary = input.model ?? cfg.model;` try native → `generate(env, primary, input, validate)` (unchanged), compat → `generateCompat(cfg, primary, input, validate)`; on `LlmError` where `fallbackWorthy(err) && cfg.fallback` retry the same way with `cfg.fallback`; else rethrow.
   - Private `postCompatJson(target: { base: string; key?: string }, path: string, body: unknown): Promise<unknown>`: mirror `postJson`'s retry loop (3 attempts, 500ms·attempt backoff) with messages `ai provider fetch failed: …` (network) and `ai provider http ${status}` (retry-class 429/5xx). Non-retryable `!res.ok`: read the body and throw `LlmError("http", `ai provider http ${status}: ${text.slice(0, 200)}`, res.status)`. `res.json()` failure → `LlmError("parse", "ai provider response not json: …")`. URL = `` `${target.base}${path}` ``; headers `content-type: application/json` + `authorization: Bearer ${key}` **only when `key`**.
   - Private `generateCompat(cfg, model, input, validate)`: body exactly `{ model, messages, temperature: input.temperature ?? 0.2, max_tokens: input.maxOutputTokens ?? 2048, response_format: { type: "json_object" } }`, messages = `[...(input.system ? [{ role: "system", content: input.system }] : []), { role: "user", content: input.user }]`. Catch `LlmError` with `status === 400 && message.includes("response_format")` → one retry with `response_format: undefined`. Then parse: content not a string → `LlmError("parse", "ai provider response missing choices[0].message.content")`; `JSON.parse` fail → `ai provider text not json: …`; validator throw → `ai provider value failed validation: …`. Tokens: `usage.prompt_tokens ?? 0` / `usage.completion_tokens ?? 0`. Return `{ value, tokensIn, tokensOut, model }`.
3. Rename the three src call sites (mechanical): `src/extract.ts:13,132`, `src/consolidate.ts:8,226`, `src/reflect.ts:6,77`.
4. `test/llm.test.ts`: rename every `geminiJson` → `llmJson` (import + calls). The entire native suite must pass unchanged otherwise. Add `describe("llm via an OpenAI-compatible provider")`:
   - Shared setup: `setEnvVars` with `AI_BASE_URL: "https://oai.test/v1"`; handlers on the exact URL `https://oai.test/v1/chat/completions`; `afterEach` resets handlers **and** clears `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_FALLBACK_MODEL` (and restores `GEMINI_API_KEY: "dev-gemini"` in tests that blank it).
   - Cases:
     1. posts with bearer auth + mapped body, parses value/usage/model: assert `authorization === "Bearer sk-test"`, `body.model === "oai-test-model"`, `body.messages` = `[{role:"system",content:"be terse"},{role:"user",content:"Say ok"}]`, `max_tokens 2048`, `temperature 0.2`, `response_format {type:"json_object"}`; reply `{ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }` → `{ value: {ok:true}, tokensIn: 7, tokensOut: 3, model: "oai-test-model" }`.
     2. omits the Authorization header when no key resolves (set `AI_API_KEY: ""` and `GEMINI_API_KEY: ""`; restore after).
     3. retries a 5xx then succeeds (calls === 2).
     4. falls back to `AI_FALLBACK_MODEL` on availability failure: primary 503 always, fallback handler ok → `res.model === "oai-fallback"`, second-call `body.model === "oai-fallback"`, primaryCalls 3 / fallbackCalls 1.
     5. does not fall back when `AI_FALLBACK_MODEL` is unset: 503 always → rejects `{ code: "http", status: 503 }`, calls 3.
     6. drops JSON mode once when the provider rejects it: handler returns 400 with body text containing `response_format` **iff** the body has `response_format`, else ok → success, calls === 2, second body lacks the key.
     7. keeps parse failures fail-fast even with a fallback configured: non-JSON content + `AI_FALLBACK_MODEL` set → rejects `{ code: "parse" }`, fallback calls 0.
     8. fails `{ code: "config" }` before any fetch when `AI_MODEL` is missing (no handlers registered — the msw guard would fail any fetch).
     9. `input.model` overrides the configured model in `body.model`.
5. **Gate** (unpiped) + **Commit:** `feat(llm): route chat through any OpenAI-compatible provider when AI_BASE_URL is set`

## Task 3 — OpenAI-compatible embeddings

**Files:** `src/llm.ts`, `test/llm.test.ts`

1. `src/llm.ts` `embedTexts`: resolve `cfg = embedConfig(env)`; per `EMBED_CHUNK` chunk — native: current code, with `cfg.dims` replacing both `EMBEDDING_DIMS` uses (default 768 ⇒ identical) and `cfg.model` the model; compat: `postCompatJson(cfg, "/embeddings", { model: cfg.model, input: chunk, ...(cfg.dimsExplicit ? { dimensions: cfg.dims } : {}) })`.
   - Compat parse: `data` not an array or `data.length !== chunk.length` → `LlmError("parse", `ai provider embedding count ${n} != ${chunk.length}`)`; if every item has a numeric `index`, sort a copy by `index`; per item: `embedding.length !== cfg.dims` → `LlmError("parse", `ai provider embedding dims ${len} != ${cfg.dims} (must match the Vectorize index: recreate it at ${cfg.dims} dims or fix AI_EMBED_DIMS)`)`.
2. `test/llm.test.ts`: add `describe("compatible embeddings (embedTexts)")` — base `https://oai.test/v1`, handler on `https://oai.test/v1/embeddings`, same `afterEach` cleanup plus `AI_EMBED_BASE_URL`/`AI_EMBED_MODEL`/`AI_EMBED_DIMS`/`AI_EMBED_API_KEY`. Cases:
   1. posts `{model, input}` with **no** `dimensions` key by default, returns parsed vectors, no auth header when keyless.
   2. orders by `index` when the provider returns items out of order.
   3. sends `dimensions` only when `AI_EMBED_DIMS` is set: `AI_EMBED_DIMS: "1536"` → handler asserts `body.dimensions === 1536`, replies 1536-long vectors, output length 1536.
   4. count mismatch → `{ code: "parse" }`.
   5. wrong vector size → `{ code: "parse" }`, message matches `/512/`, `/768/`, `/Vectorize/`.
   6. native embed suite above is untouched and stays green (regression guard).
3. **Gate** + **Commit:** `feat(llm): route embeddings through any OpenAI-compatible provider (native default)`

## Task 4 — Signature-aware backfill + index guard

**Files:** `src/factstore.ts`, `src/embed.ts`, `src/extract.ts`, `test/helpers.ts`, `test/embed.test.ts`, `test/extract.test.ts`

1. `test/helpers.ts`: `installFakeVectorize(opts: { dims?: number } = {})`; `describe` returns `{ name: "fake", config: {}, vectorsCount: store.size, dimensions: opts.dims ?? 768 }`. Update its doc comment.
2. `src/factstore.ts`: replace the `EMBEDDING_MODEL` bind in `createFact` (line ~56) with `embeddingSignature(env)`; drop the now-unused `EMBEDDING_MODEL` import.
3. `src/embed.ts`:
   - Imports become `{ embedConfig, embedTexts, LlmError }`.
   - Top of `embedPendingFacts`, before the SELECT:
     ```ts
     const cfg = embedConfig(env);
     // A dims mismatch would make every upsert below fail silently in a loop.
     const info = await env.VECTORIZE.describe();
     if (info.dimensions !== cfg.dims) {
       throw new LlmError("config", `vectorize index is ${info.dimensions}-dim but AI_EMBED_DIMS is ${cfg.dims} — recreate the index at ${cfg.dims} dims or fix AI_EMBED_DIMS`);
     }
     // One-time legacy normalization: pre-signature rows were embedded at the
     // default model/size; stamp that so a later switch catches them.
     await env.BRAIN_DB.prepare(
       `UPDATE facts SET embedding_model = 'gemini-embedding-001@768' WHERE embedding_model IS NULL AND vec_id IS NOT NULL`,
     ).run();
     ```
   - Widen the SELECT (keep the column list/join as-is): `WHERE (f.vec_id IS NULL OR (f.embedding_model IS NOT ?1 AND f.embedding_model IS NOT ?2)) AND f.sensitivity != 'restricted' AND f.status = 'active' ORDER BY f.learned_at ASC LIMIT ?3`, binds `(cfg.model, cfg.signature, maxFacts)`. (`IS NOT` is SQLite's null-safe comparison; NULL rows fall in — correct, they were never embedded by a known signature.)
   - Metadata: `embedding_model: cfg.signature`.
   - Post-upsert update: `UPDATE facts SET vec_id = ?1, embedding_model = ?2 WHERE id = ?1` bind `(f.id, cfg.signature)`.
4. `src/extract.ts` step 6 (line ~242): wrap in try/catch —
   ```ts
   try {
     const embs = await embedPendingFacts(env);
     run.embedded = embs.embedded;
     run.embedFailed = embs.failed;
   } catch (err) {
     console.log(`[embed] skipped: ${err instanceof Error ? err.message : String(err)}`);
   }
   ```
5. `test/embed.test.ts`:
   - Update the existing metadata expectation to `"gemini-embedding-001@768"`; additionally assert the fact row's `embedding_model` equals the signature after embedding.
   - New cases:
     1. does not re-embed legacy bare-model rows: embed a seeded fact (native handler), then `UPDATE facts SET embedding_model = 'gemini-embedding-001' WHERE id = ?` (vec_id kept); second run → `{ embedded: 0, failed: 0 }`, zero outbound calls (register a counting handler).
     2. stamps legacy NULL rows without re-embedding: embed, then `UPDATE facts SET embedding_model = NULL`; run → embedded 0, zero calls, row now `"gemini-embedding-001@768"`.
     3. re-embeds when the signature changes: native run, then `setEnvVars({ AI_BASE_URL: "https://oai.test/v1", AI_EMBED_MODEL: "other-embed" })` + compat handler returning `fakeVec(text)` → run → `embedded: 1`, row and stored vector metadata both `"other-embed@768"` (cleanup afterEach).
     4. index guard: `installFakeVectorize({ dims: 512 })` → `embedPendingFacts(env)` rejects `{ code: "config" }`, message matches `/512/` and `/AI_EMBED_DIMS/` (no handlers needed — nothing may fetch).
   - Also run the suite and update assertion fallout: `test/factstore.test.ts` (createFact now stamps the signature) and any test asserting a value the new flow rewrites (`test/extract.test.ts:143`, `test/eval-semantic.test.ts:138`). Fixtures that simulate legacy state (`seedFact`, `test/eval-restore.test.ts:76`, hand-seeded vector metadata in `test/search.test.ts:20` / `test/mcp.test.ts`) keep the bare value — they are the point.
6. `test/extract.test.ts`: one new case — with `installFakeVectorize({ dims: 512 })`, the extraction pass (existing driving pattern in this file) still resolves, seeds facts, `run.embedded === 0`, and `console.log` (spy) received one line matching `/\[embed\] skipped:/`.
7. **Gate** + **Commit:** `feat(memory): signature-aware re-embedding and a loud index-dims guard`

## Task 5 — Health: report the AI wiring

**Files:** `src/health.ts`, `test/health.test.ts`

1. `src/health.ts`:
   ```ts
   export type AiHealthChat =
     | { mode: "native" | "compat"; model: string; fallback_model?: string }
     | { error: string };
   export type AiHealthEmbed =
     | { mode: "native" | "compat"; model: string; dims: number; signature: string; index_dims: number | null; matches_index: boolean }
     | { error: string };
   export interface AiHealth { chat: AiHealthChat; embed: AiHealthEmbed; reembed_backlog: number }
   ```
   `HealthReport` gains `ai: AiHealth`. Private `aiHealth(env)`: try `chatConfig` → summary (include `fallback_model` only when set); catch → `{ error: message }`. Try `embedConfig` → summary + `index_dims` via `(await env.VECTORIZE.describe()).dimensions` (inner try/catch → `null`) + `matches_index: indexDims === cfg.dims` + backlog `SELECT count(*) … WHERE (vec_id IS NULL OR (embedding_model IS NOT ?1 AND embedding_model IS NOT ?2)) AND sensitivity != 'restricted' AND status = 'active'` bind `(cfg.model, cfg.signature)`; catch → `{ error: message }`, backlog 0. Return `{ chat, embed, reembed_backlog }`; `healthReport` returns `{ ...existing, ai: await aiHealth(env) }`.
2. `test/health.test.ts`:
   - New: "reports the AI wiring (native defaults)" — `ai.chat` equals `{ mode: "native", model: "gemini-3.5-flash-lite", fallback_model: "gemini-3.1-flash-lite" }`; `ai.embed` matches `{ mode: "native", model: "gemini-embedding-001", dims: 768, index_dims: 768, matches_index: true }`; `reembed_backlog` 0.
   - New: "counts the re-embed backlog" — `seedFact` (vec_id NULL) → backlog ≥ 1.
   - New: "keeps the route up when AI config is broken" — `setEnvVars({ AI_BASE_URL: "https://oai.test/v1" })` (no `AI_MODEL`); `call("GET", "/v1/health-report", undefined, bearer(env, "MCP_READ"))` → 200, `body.ai.chat.error` matches `/AI_MODEL/` (cleanup after). If any test does a whole-report `toEqual`, extend it.
3. **Gate** + **Commit:** `feat(health): report the resolved AI wiring and the re-embed backlog`

## Task 6 — Bindings chart + docs

**Files:** `package.json`, `README.md`, `docs/setup.md`, `.dev.vars.example`, `CHANGELOG.md`

1. `package.json` `cloudflare.bindings` — after `GEMINI_API_KEY`, add the eight `AI_*` entries, each with a description in the chart's style ("Optional. …" + what unset means). Content rules: base URLs take any OpenAI-compatible API; keys fall back (`AI_API_KEY` → `GEMINI_API_KEY`; `AI_EMBED_API_KEY` → `AI_API_KEY` → `GEMINI_API_KEY`) and keyless works; `AI_MODEL` required when `AI_BASE_URL` is set; `AI_EMBED_BASE_URL` supports the literal `native`; `AI_EMBED_DIMS` is 1–1536, default 768, must match the Vectorize index, changing it re-embeds stored facts.
2. `README.md` §The envs (below the required table, ~line 94): an "Optional — run on any AI provider" table with the same rows, then three short paragraph points: (a) default stays Google — nothing changes; (b) to switch: set `AI_*` in the dashboard; for a fully non-Google setup also delete `GEMINI_API_KEY` from `secrets.required` in `wrangler.jsonc` (one line) — or keep it and pin `AI_EMBED_BASE_URL=native`; (c) changing embedding model or size re-embeds the backlog in the background over a few sweeps, and your prompts go only to the provider you configure.
3. `docs/setup.md`: add the same "Optional: non-Google AI provider" note where the env/secrets tables live (after ~line 92), one line at the CLI secrets step (~line 113) saying nothing is needed there for the default setup.
4. `.dev.vars.example`: append a commented block with the eight `AI_*` example lines.
5. `CHANGELOG.md`: Unreleased → Added: "Run on any OpenAI-compatible AI provider (chat and/or embeddings) with env vars only; Gemini remains the default."
6. **Gate** (cheap, but run it — the repo's rule) + **Commit:** `docs: document running on any OpenAI-compatible provider`

## Task 7 — Push, live verification, ledger

**Files:** `.superpowers/sdd/2026-10-16-any-ai-provider/progress.md` (new), one pointer line in `.superpowers/sdd/2026-10-16-repo-restructure/progress.md`

1. Push `master`. Watch the pushed HEAD: `gh run list --commit "$SHA"` (CI) and the Workers Builds API (`.secrets/cf-builds.env`; never print the token; log tail via `GET …/builds/builds/<uuid>/logs` if red). Red → fix-forward before proceeding.
2. **Single-shot** prod checks (never loops; never echo secrets):
   - `curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://brain-api.taxin-404.workers.dev/v1/health-report | jq .ai` → expect `chat.mode "native"`, `embed.mode "native"`, `dims 768`, `index_dims 768`, `matches_index true`, plausible `reembed_backlog`.
   - One read-scope recall/search call (same pattern as the phase close-outs) returns normal results — native path unaffected.
3. Ledger: create `.superpowers/sdd/2026-10-16-any-ai-provider/progress.md` recording — per task: commit hash + subject + gate result; then CI run id/conclusion and Workers build uuid/outcome per push; the prod check outputs; and fold the pending verification of `c7ed065` (GH run 38886678709 success, Workers build `08b9c651-eb9c-4d24-ab5e-8a34b9c047f0` success) with a pointer line added to the repo-restructure ledger. Commit with `git add -f` + `chore(ledger): fold the any-AI-provider delivery and c7ed065 verification`, push, confirm green.

---

## Self-review notes (for the reviewer)

- **Spec coverage:** config-only switching (T1), compat chat incl. fallback + JSON-mode degrade + keyless (T2), compat embeddings incl. dims-only-when-explicit + order-by-index (T3), signature identity + legacy no-churn + index guard + loud-not-silent (T4), observability (T5), envs chart + docs incl. the one-line `secrets.required` swap (T6), live verification + ledger (T7). No spec decision is unowned.
- **Interface consistency:** `chatConfig` / `embedConfig` / `embeddingSignature` / `llmJson` / `setEnvVars` / `installFakeVectorize({dims})` are used with the same names and shapes in every task that references them.
- **Deliberate non-goals:** no gateway for compat, no per-call overrides beyond `input.model`, no plugin changes, no `wrangler.jsonc` change.
- **Expected suite growth:** ~30 new tests (236-ish → 266-ish region); the whole suite must be green at every gate, not just new tests.
