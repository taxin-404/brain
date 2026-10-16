import type { Env } from "./env";

export class LlmError extends Error {
  constructor(
    readonly code: "http" | "network" | "parse" | "config",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export const EXTRACTION_MODEL = "gemini-3.5-flash-lite";
/** Availability fallback (owner directive 2026-10-16): when the primary is
 *  down past its retries, retired (404), or rate-limited, the same call runs
 *  once more on this model. Config errors and parse failures stay fail-fast. */
export const EXTRACTION_FALLBACK_MODEL = "gemini-3.1-flash-lite";
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMS = 768;
export const EMBED_CHUNK = 10;

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
  signature: string;
}

/** First value that is neither undefined nor "" (empty env vars count as unset). */
const firstSet = (...values: Array<string | undefined>): string | undefined =>
  values.find((v) => v !== undefined && v !== "");

const stripTrailingSlashes = (url: string): string => url.replace(/\/+$/, "");

const GEMINI_PATH_HINT = " (or set AI_BASE_URL for a compatible provider)";

/** Resolve the chat path from env. No AI_BASE_URL = the Gemini-native path. */
export function chatConfig(env: Env): ChatConfig {
  if (env.AI_BASE_URL) {
    if (!env.AI_MODEL) {
      throw new LlmError("config", "AI_MODEL is required when AI_BASE_URL is set");
    }
    return {
      mode: "compat",
      base: stripTrailingSlashes(env.AI_BASE_URL),
      key: firstSet(env.AI_API_KEY, env.GEMINI_API_KEY),
      model: env.AI_MODEL,
      fallback: env.AI_FALLBACK_MODEL,
    };
  }
  if (!env.AI_GATEWAY_BASE) {
    throw new LlmError("config", `AI_GATEWAY_BASE is required for the Gemini path${GEMINI_PATH_HINT}`);
  }
  if (!env.GEMINI_API_KEY) {
    throw new LlmError("config", `GEMINI_API_KEY is required for the Gemini path${GEMINI_PATH_HINT}`);
  }
  return {
    mode: "native",
    base: env.AI_GATEWAY_BASE,
    key: env.GEMINI_API_KEY,
    model: EXTRACTION_MODEL,
    fallback: EXTRACTION_FALLBACK_MODEL,
  };
}

/** Resolve the embeddings path from env. Independent of chat except that
 *  embeddings without their own base URL inherit a compat chat base; the
 *  literal "native" sentinel keeps Gemini embeddings regardless. */
export function embedConfig(env: Env): EmbedConfig {
  const dimsRaw = env.AI_EMBED_DIMS;
  let dims = EMBEDDING_DIMS;
  if (dimsRaw !== undefined) {
    const n = Number(dimsRaw);
    if (!Number.isInteger(n) || n < 1 || n > 1536) {
      throw new LlmError("config", `AI_EMBED_DIMS must be an integer from 1 to 1536 (got "${dimsRaw}")`);
    }
    dims = n;
  }
  const base = env.AI_EMBED_BASE_URL === "native" ? undefined : env.AI_EMBED_BASE_URL ?? env.AI_BASE_URL;
  if (base) {
    if (!env.AI_EMBED_MODEL) {
      throw new LlmError(
        "config",
        "AI_EMBED_MODEL is required when the embedding path uses a compatible provider (set AI_EMBED_BASE_URL=native to keep Gemini embeddings)",
      );
    }
    return {
      mode: "compat",
      base: stripTrailingSlashes(base),
      key: firstSet(env.AI_EMBED_API_KEY, env.AI_API_KEY, env.GEMINI_API_KEY),
      model: env.AI_EMBED_MODEL,
      dims,
      dimsExplicit: dimsRaw !== undefined,
      signature: `${env.AI_EMBED_MODEL}@${dims}`,
    };
  }
  if (!env.AI_GATEWAY_BASE) {
    throw new LlmError("config", `AI_GATEWAY_BASE is required for the Gemini path${GEMINI_PATH_HINT}`);
  }
  if (!env.GEMINI_API_KEY) {
    throw new LlmError("config", `GEMINI_API_KEY is required for the Gemini path${GEMINI_PATH_HINT}`);
  }
  return {
    mode: "native",
    base: env.AI_GATEWAY_BASE,
    key: env.GEMINI_API_KEY,
    model: EMBEDDING_MODEL,
    dims,
    dimsExplicit: dimsRaw !== undefined,
    signature: `${EMBEDDING_MODEL}@${dims}`,
  };
}

/** The `{model}@{dims}` identity stamped on facts and vectors; the backfill
 *  re-embeds when a fact's stored value differs. */
export function embeddingSignature(env: Env): string {
  return embedConfig(env).signature;
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface GeminiPart {
  text?: string;
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** POST through AI Gateway with pass-through key auth. Retries 429/5xx/network
 *  up to 3 total attempts (500ms * attempt backoff); other 4xx fail fast. */
async function postJson(env: Env, path: string, body: unknown): Promise<GeminiResponse> {
  let lastError: LlmError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${env.AI_GATEWAY_BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastError = new LlmError("network", `gemini fetch failed: ${String(e)}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      throw lastError;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = new LlmError("http", `gemini http ${res.status}`, res.status);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      throw lastError;
    }
    if (!res.ok) throw new LlmError("http", `gemini http ${res.status}`, res.status);
    try {
      return (await res.json()) as GeminiResponse;
    } catch (e) {
      throw new LlmError("parse", `gemini response not json: ${String(e)}`);
    }
  }
  throw lastError ?? new LlmError("network", "unreachable");
}

function textOf(resp: GeminiResponse): string {
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

/** Availability-class failures only: a different model can serve these.
 *  4xx request/auth errors and parse failures stay with the caller. */
const fallbackWorthy = (e: LlmError): boolean =>
  e.code === "network" || e.status === 404 || e.status === 429 || (e.status ?? 0) >= 500;

async function generate<T>(
  env: Env,
  model: string,
  input: { system?: string; user: string; maxOutputTokens?: number; temperature?: number },
  validate: (v: unknown) => T,
): Promise<{ value: T; tokensIn: number; tokensOut: number; model: string }> {
  const body = {
    contents: [{ role: "user", parts: [{ text: input.user }] }],
    ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
    generationConfig: {
      maxOutputTokens: input.maxOutputTokens ?? 2048,
      temperature: input.temperature ?? 0.2,
      responseMimeType: "application/json",
    },
  };
  const resp = await postJson(env, `/v1beta/models/${model}:generateContent`, body);

  let parsed: unknown;
  try {
    parsed = JSON.parse(textOf(resp));
  } catch (e) {
    throw new LlmError("parse", `gemini text not json: ${String(e)}`);
  }
  let value: T;
  try {
    value = validate(parsed);
  } catch (e) {
    throw new LlmError("parse", `gemini value failed validation: ${String(e)}`);
  }
  return {
    value,
    tokensIn: resp.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: resp.usageMetadata?.candidatesTokenCount ?? 0,
    model,
  };
}

interface CompatChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** POST to an OpenAI-compatible provider. Retries 429/5xx/network up to 3
 *  total attempts (500ms * attempt backoff); other 4xx fail fast with the
 *  provider's response text clipped into the message. */
async function postCompatJson(
  target: { base: string; key?: string },
  path: string,
  body: unknown,
): Promise<unknown> {
  let lastError: LlmError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${target.base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(target.key ? { authorization: `Bearer ${target.key}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastError = new LlmError("network", `ai provider fetch failed: ${String(e)}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      throw lastError;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = new LlmError("http", `ai provider http ${res.status}`, res.status);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      throw lastError;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LlmError("http", `ai provider http ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    try {
      return await res.json();
    } catch (e) {
      throw new LlmError("parse", `ai provider response not json: ${String(e)}`);
    }
  }
  throw lastError ?? new LlmError("network", "unreachable");
}

async function generateCompat<T>(
  cfg: ChatConfig,
  model: string,
  input: { system?: string; user: string; maxOutputTokens?: number; temperature?: number },
  validate: (v: unknown) => T,
): Promise<{ value: T; tokensIn: number; tokensOut: number; model: string }> {
  const messages = [
    ...(input.system ? [{ role: "system", content: input.system }] : []),
    { role: "user", content: input.user },
  ];
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: input.temperature ?? 0.2,
    max_tokens: input.maxOutputTokens ?? 2048,
    response_format: { type: "json_object" },
  };
  let resp: CompatChatResponse;
  try {
    resp = (await postCompatJson(cfg, "/chat/completions", body)) as CompatChatResponse;
  } catch (err) {
    // Some providers reject JSON mode with a 400 that names the parameter:
    // retry once without it instead of failing the whole call.
    if (err instanceof LlmError && err.status === 400 && err.message.includes("response_format")) {
      resp = (await postCompatJson(cfg, "/chat/completions", {
        ...body,
        response_format: undefined,
      })) as CompatChatResponse;
    } else {
      throw err;
    }
  }
  const content = resp.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new LlmError("parse", "ai provider response missing choices[0].message.content");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new LlmError("parse", `ai provider text not json: ${String(e)}`);
  }
  let value: T;
  try {
    value = validate(parsed);
  } catch (e) {
    throw new LlmError("parse", `ai provider value failed validation: ${String(e)}`);
  }
  return {
    value,
    tokensIn: resp.usage?.prompt_tokens ?? 0,
    tokensOut: resp.usage?.completion_tokens ?? 0,
    model,
  };
}

export async function llmJson<T>(
  env: Env,
  input: { model?: string; system?: string; user: string; maxOutputTokens?: number; temperature?: number },
  validate: (v: unknown) => T,
): Promise<{ value: T; tokensIn: number; tokensOut: number; model: string }> {
  const cfg = chatConfig(env);
  const primary = input.model ?? cfg.model;
  try {
    return cfg.mode === "native"
      ? await generate(env, primary, input, validate)
      : await generateCompat(cfg, primary, input, validate);
  } catch (err) {
    if (!(err instanceof LlmError) || !fallbackWorthy(err) || !cfg.fallback) throw err;
    const fallback = cfg.fallback;
    return cfg.mode === "native"
      ? await generate(env, fallback, input, validate)
      : await generateCompat(cfg, fallback, input, validate);
  }
}

interface BatchEmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
}

interface CompatEmbedResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  const cfg = embedConfig(env);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_CHUNK) {
    const chunk = texts.slice(i, i + EMBED_CHUNK);
    const vectors = cfg.mode === "native" ? await embedChunkNative(env, cfg, chunk) : await embedChunkCompat(cfg, chunk);
    out.push(...vectors);
  }
  return out;
}

/** Gemini-native batch embeddings. outputDimensionality is always sent (the
 *  API supports truncation), unlike the compat path's opt-in dimensions. */
async function embedChunkNative(env: Env, cfg: EmbedConfig, chunk: string[]): Promise<number[][]> {
  const resp = (await postJson(env, `/v1beta/models/${cfg.model}:batchEmbedContents`, {
    requests: chunk.map((text) => ({
      model: `models/${cfg.model}`,
      content: { parts: [{ text }] },
      outputDimensionality: cfg.dims,
    })),
  })) as BatchEmbedResponse;
  const embeddings = resp.embeddings ?? [];
  if (embeddings.length !== chunk.length) {
    throw new LlmError("parse", `embedding count ${embeddings.length} != ${chunk.length}`);
  }
  const out: number[][] = [];
  for (const e of embeddings) {
    const values = e.values ?? [];
    if (values.length !== cfg.dims) {
      throw new LlmError("parse", `embedding dims ${values.length} != ${cfg.dims}`);
    }
    out.push(values);
  }
  return out;
}

/** OpenAI-compatible embeddings. `dimensions` is opt-in (some providers
 *  reject unknown parameters); vectors are ordered by `index` when present. */
async function embedChunkCompat(cfg: EmbedConfig, chunk: string[]): Promise<number[][]> {
  const body: Record<string, unknown> = { model: cfg.model, input: chunk };
  if (cfg.dimsExplicit) body.dimensions = cfg.dims;
  const resp = (await postCompatJson(cfg, "/embeddings", body)) as CompatEmbedResponse;
  const data = resp.data;
  if (!Array.isArray(data) || data.length !== chunk.length) {
    throw new LlmError("parse", `ai provider embedding count ${data?.length ?? 0} != ${chunk.length}`);
  }
  const ordered = data.every((d) => typeof d.index === "number")
    ? [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    : data;
  const out: number[][] = [];
  for (const d of ordered) {
    const values = d.embedding ?? [];
    if (values.length !== cfg.dims) {
      throw new LlmError(
        "parse",
        `ai provider embedding dims ${values.length} != ${cfg.dims} (must match the Vectorize index: recreate it at ${cfg.dims} dims or fix AI_EMBED_DIMS)`,
      );
    }
    out.push(values);
  }
  return out;
}
