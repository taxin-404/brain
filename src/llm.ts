import type { Env } from "./env";

export class LlmError extends Error {
  constructor(
    readonly code: "http" | "network" | "parse",
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

export async function geminiJson<T>(
  env: Env,
  input: { model?: string; system?: string; user: string; maxOutputTokens?: number; temperature?: number },
  validate: (v: unknown) => T,
): Promise<{ value: T; tokensIn: number; tokensOut: number; model: string }> {
  const primary = input.model ?? EXTRACTION_MODEL;
  try {
    return await generate(env, primary, input, validate);
  } catch (err) {
    if (!(err instanceof LlmError) || !fallbackWorthy(err)) throw err;
    return await generate(env, EXTRACTION_FALLBACK_MODEL, input, validate);
  }
}

interface BatchEmbedResponse {
  embeddings?: Array<{ values?: number[] }>;
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_CHUNK) {
    const chunk = texts.slice(i, i + EMBED_CHUNK);
    const resp = (await postJson(env, `/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`, {
      requests: chunk.map((text) => ({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBEDDING_DIMS,
      })),
    })) as BatchEmbedResponse;
    const embeddings = resp.embeddings ?? [];
    if (embeddings.length !== chunk.length) {
      throw new LlmError("parse", `embedding count ${embeddings.length} != ${chunk.length}`);
    }
    for (const e of embeddings) {
      const values = e.values ?? [];
      if (values.length !== EMBEDDING_DIMS) {
        throw new LlmError("parse", `embedding dims ${values.length} != ${EMBEDDING_DIMS}`);
      }
      out.push(values);
    }
  }
  return out;
}
