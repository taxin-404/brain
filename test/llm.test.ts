import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
  chatConfig,
  embedConfig,
  EMBEDDING_MODEL,
  embeddingSignature,
  embedTexts,
  EXTRACTION_FALLBACK_MODEL,
  EXTRACTION_MODEL,
  llmJson,
  LlmError,
} from "../src/llm";
import { network } from "./server";
import { fakeVec, setEnvVars } from "./helpers";

const GEN_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-3.5-flash-lite:generateContent";
const FALLBACK_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-3.1-flash-lite:generateContent";
const EMB_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-embedding-001:batchEmbedContents";

const genReply = (text: string, tokensIn = 12, tokensOut = 3) => ({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: tokensIn, candidatesTokenCount: tokensOut },
});

interface GenBody {
  contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
  systemInstruction?: { parts?: Array<{ text?: string }> };
  generationConfig?: { responseMimeType?: string; maxOutputTokens?: number; temperature?: number };
}

interface EmbBody {
  requests?: Array<{ content?: { parts?: Array<{ text?: string }> }; outputDimensionality?: number }>;
}

describe("llm via ai gateway", () => {
  beforeAll(async () => {
    await network.enable();
  });

  afterEach(() => {
    network.resetHandlers();
  });

  afterAll(async () => {
    await network.disable();
  });

  it("posts generateContent to the gateway with the secret header and parses JSON", async () => {
    const seen: { key: string | null; contentType: string | null; body: GenBody } = {
      key: null,
      contentType: null,
      body: {},
    };
    network.use(
      http.post(GEN_URL, async ({ request }) => {
        seen.key = request.headers.get("x-goog-api-key");
        seen.contentType = request.headers.get("content-type");
        seen.body = (await request.json()) as GenBody;
        return HttpResponse.json(genReply('{"ok":true}'));
      }),
    );
    const res = await llmJson(env, { user: "Say ok", system: "be terse" }, (v) => v as { ok: boolean });
    expect(res.value).toEqual({ ok: true });
    expect(res.tokensIn).toBe(12);
    expect(res.tokensOut).toBe(3);
    expect(res.model).toBe("gemini-3.5-flash-lite");
    expect(seen.key).toBe("dev-gemini");
    expect(seen.contentType).toContain("application/json");
    expect(seen.body.contents?.[0]?.parts?.[0]?.text).toBe("Say ok");
    expect(seen.body.systemInstruction?.parts?.[0]?.text).toBe("be terse");
    expect(seen.body.generationConfig?.responseMimeType).toBe("application/json");
    expect(seen.body.generationConfig?.maxOutputTokens).toBe(2048);
  });

  it("retries a 5xx then succeeds", async () => {
    let calls = 0;
    network.use(
      http.post(GEN_URL, () => {
        calls += 1;
        return calls === 1 ? HttpResponse.text("boom", { status: 500 }) : HttpResponse.json(genReply('{"ok":true}'));
      }),
    );
    const res = await llmJson(env, { user: "Say ok" }, (v) => v as { ok: boolean });
    expect(res.value).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("gives up after three 5xx from both models with LlmError http", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    network.use(
      http.post(GEN_URL, () => {
        primaryCalls += 1;
        return HttpResponse.text("boom", { status: 500 });
      }),
      http.post(FALLBACK_URL, () => {
        fallbackCalls += 1;
        return HttpResponse.text("boom", { status: 500 });
      }),
    );
    await expect(llmJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({
      name: "LlmError",
      code: "http",
      status: 500,
    });
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(3);
  });

  it("falls back to gemini-3.1-flash-lite when the primary is down, reporting the serving model", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    network.use(
      http.post(GEN_URL, () => {
        primaryCalls += 1;
        return HttpResponse.text("down", { status: 503 });
      }),
      http.post(FALLBACK_URL, () => {
        fallbackCalls += 1;
        return HttpResponse.json(genReply('{"ok":true}'));
      }),
    );
    const res = await llmJson(env, { user: "Say ok" }, (v) => v as { ok: boolean });
    expect(res.value).toEqual({ ok: true });
    expect(res.model).toBe("gemini-3.1-flash-lite");
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(1);
  });

  it("falls back on a 404 retired model without retrying the primary", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    network.use(
      http.post(GEN_URL, () => {
        primaryCalls += 1;
        return HttpResponse.text("model not found", { status: 404 });
      }),
      http.post(FALLBACK_URL, () => {
        fallbackCalls += 1;
        return HttpResponse.json(genReply('{"ok":true}'));
      }),
    );
    const res = await llmJson(env, { user: "Say ok" }, (v) => v as { ok: boolean });
    expect(res.value).toEqual({ ok: true });
    expect(res.model).toBe("gemini-3.1-flash-lite");
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
  });

  it("does not fall back on 4xx config errors", async () => {
    let fallbackCalls = 0;
    network.use(
      http.post(GEN_URL, () => HttpResponse.text("bad request", { status: 400 })),
      http.post(FALLBACK_URL, () => {
        fallbackCalls += 1;
        return HttpResponse.json(genReply('{"ok":true}'));
      }),
    );
    await expect(llmJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({
      code: "http",
      status: 400,
    });
    expect(fallbackCalls).toBe(0);
  });

  it("fails fast on other 4xx without retrying", async () => {
    let calls = 0;
    network.use(
      http.post(GEN_URL, () => {
        calls += 1;
        return HttpResponse.text("nope", { status: 400 });
      }),
    );
    await expect(llmJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({
      code: "http",
      status: 400,
    });
    expect(calls).toBe(1);
  });

  it("maps non-JSON model text to LlmError parse", async () => {
    network.use(http.post(GEN_URL, () => HttpResponse.json(genReply("not json at all"))));
    await expect(llmJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({ code: "parse" });
  });

  it("maps validator failures to LlmError parse", async () => {
    network.use(http.post(GEN_URL, () => HttpResponse.json(genReply("{}"))));
    await expect(
      llmJson(env, { user: "Say ok" }, () => {
        throw new Error("bad shape");
      }),
    ).rejects.toMatchObject({ code: "parse" });
  });

  it("embeds texts in batches of at most 10 and returns 768-dim vectors", async () => {
    const requestCounts: number[] = [];
    const dims = new Set<number>();
    network.use(
      http.post(EMB_URL, async ({ request }) => {
        const body = (await request.json()) as EmbBody;
        const reqs = body.requests ?? [];
        requestCounts.push(reqs.length);
        for (const r of reqs) dims.add(r.outputDimensionality ?? 0);
        return HttpResponse.json({
          embeddings: reqs.map(() => ({ values: new Array(768).fill(0.25) })),
        });
      }),
    );
    const texts = Array.from({ length: 12 }, (_, i) => `text ${i}`);
    const out = await embedTexts(env, texts);
    expect(out).toHaveLength(12);
    expect(out[0]).toHaveLength(768);
    expect(out[11][0]).toBe(0.25);
    expect(requestCounts).toEqual([10, 2]);
    expect([...dims]).toEqual([768]);
  });

  it("rejects embedding responses with the wrong dimensionality", async () => {
    network.use(
      http.post(EMB_URL, () =>
        HttpResponse.json({ embeddings: [{ values: new Array(512).fill(0.1) }] }),
      ),
    );
    await expect(embedTexts(env, ["one"])).rejects.toMatchObject({ code: "parse" });
  });

  it("exports LlmError with the documented shape", () => {
    const e = new LlmError("network", "x");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("LlmError");
  });
});

describe("ai provider config resolution", () => {
  const configError = (fn: () => unknown): LlmError => {
    try {
      fn();
    } catch (e) {
      if (e instanceof LlmError) return e;
      throw e;
    }
    throw new Error("expected a config error");
  };

  it("resolves the Gemini-native chat path by default", () => {
    const cfg = chatConfig({ AI_GATEWAY_BASE: "https://gw.test/x", GEMINI_API_KEY: "g" } as unknown as Env);
    expect(cfg).toEqual({
      mode: "native",
      base: "https://gw.test/x",
      key: "g",
      model: EXTRACTION_MODEL,
      fallback: EXTRACTION_FALLBACK_MODEL,
    });
  });

  it("switches chat to a compatible provider when AI_BASE_URL is set", () => {
    const cfg = chatConfig({
      AI_BASE_URL: "https://api.test/v1/",
      AI_API_KEY: "sk-test",
      AI_MODEL: "oai-model",
      AI_FALLBACK_MODEL: "oai-fallback",
    } as unknown as Env);
    expect(cfg).toEqual({
      mode: "compat",
      base: "https://api.test/v1",
      key: "sk-test",
      model: "oai-model",
      fallback: "oai-fallback",
    });
  });

  it("falls back to GEMINI_API_KEY as the compat key", () => {
    const cfg = chatConfig({ AI_BASE_URL: "https://api.test/v1", AI_MODEL: "m", GEMINI_API_KEY: "g" } as unknown as Env);
    expect(cfg.key).toBe("g");
  });

  it("resolves keyless compat when no key is set", () => {
    const cfg = chatConfig({ AI_BASE_URL: "https://api.test/v1", AI_MODEL: "m" } as unknown as Env);
    expect(cfg.key).toBeUndefined();
  });

  it("requires AI_MODEL when AI_BASE_URL is set", () => {
    const err = configError(() => chatConfig({ AI_BASE_URL: "https://api.test/v1" } as unknown as Env));
    expect(err.code).toBe("config");
    expect(err.message).toMatch(/AI_MODEL/);
  });

  it("requires AI_GATEWAY_BASE for the native chat path", () => {
    const err = configError(() => chatConfig({ GEMINI_API_KEY: "g" } as unknown as Env));
    expect(err.code).toBe("config");
    expect(err.message).toMatch(/AI_GATEWAY_BASE/);
  });

  it("resolves native embeddings by default", () => {
    const cfg = embedConfig({ AI_GATEWAY_BASE: "https://gw.test/x", GEMINI_API_KEY: "g" } as unknown as Env);
    expect(cfg).toEqual({
      mode: "native",
      base: "https://gw.test/x",
      key: "g",
      model: EMBEDDING_MODEL,
      dims: 768,
      dimsExplicit: false,
      signature: "gemini-embedding-001@768",
    });
  });

  it("inherits the compat chat base for embeddings and requires AI_EMBED_MODEL", () => {
    const err = configError(() =>
      embedConfig({ AI_BASE_URL: "https://api.test/v1", AI_MODEL: "m", GEMINI_API_KEY: "g" } as unknown as Env),
    );
    expect(err.code).toBe("config");
    expect(err.message).toMatch(/AI_EMBED_MODEL/);
    const cfg = embedConfig({
      AI_BASE_URL: "https://api.test/v1",
      AI_MODEL: "m",
      GEMINI_API_KEY: "g",
      AI_EMBED_MODEL: "text-embedding-3-small",
    } as unknown as Env);
    expect(cfg).toEqual({
      mode: "compat",
      base: "https://api.test/v1",
      key: "g",
      model: "text-embedding-3-small",
      dims: 768,
      dimsExplicit: false,
      signature: "text-embedding-3-small@768",
    });
  });

  it("keeps Gemini embeddings when AI_EMBED_BASE_URL is the native sentinel", () => {
    const cfg = embedConfig({
      AI_BASE_URL: "https://api.test/v1",
      AI_MODEL: "m",
      AI_EMBED_BASE_URL: "native",
      AI_GATEWAY_BASE: "https://gw.test/x",
      GEMINI_API_KEY: "g",
    } as unknown as Env);
    expect(cfg.mode).toBe("native");
    expect(cfg.model).toBe(EMBEDDING_MODEL);
  });

  it("treats an empty AI_EMBED_BASE_URL as unset and inherits the chat base", () => {
    const cfg = embedConfig({
      AI_BASE_URL: "https://api.test/v1",
      AI_MODEL: "m",
      AI_EMBED_BASE_URL: "",
      AI_EMBED_MODEL: "embed-m",
    } as unknown as Env);
    expect(cfg.mode).toBe("compat");
    expect(cfg.base).toBe("https://api.test/v1");
  });

  it("treats an empty AI_EMBED_DIMS as unset", () => {
    const cfg = embedConfig({
      AI_GATEWAY_BASE: "https://gw.test/x",
      GEMINI_API_KEY: "g",
      AI_EMBED_DIMS: "",
    } as unknown as Env);
    expect(cfg.dims).toBe(768);
    expect(cfg.dimsExplicit).toBe(false);
  });

  it("resolves an embeddings-only compatible provider", () => {
    const cfg = embedConfig({
      AI_EMBED_BASE_URL: "https://emb.test/v1",
      AI_EMBED_MODEL: "bge-m3",
      AI_EMBED_API_KEY: "ek",
    } as unknown as Env);
    expect(cfg).toEqual({
      mode: "compat",
      base: "https://emb.test/v1",
      key: "ek",
      model: "bge-m3",
      dims: 768,
      dimsExplicit: false,
      signature: "bge-m3@768",
    });
  });

  it("parses AI_EMBED_DIMS into the signature", () => {
    const cfg = embedConfig({
      AI_GATEWAY_BASE: "https://gw.test/x",
      GEMINI_API_KEY: "g",
      AI_EMBED_DIMS: "1536",
    } as unknown as Env);
    expect(cfg.dims).toBe(1536);
    expect(cfg.dimsExplicit).toBe(true);
    expect(cfg.signature).toBe("gemini-embedding-001@1536");
  });

  it("rejects a bad AI_EMBED_DIMS", () => {
    for (const raw of ["abc", "0", "1537"]) {
      const err = configError(() =>
        embedConfig({ AI_EMBED_DIMS: raw, AI_GATEWAY_BASE: "x", GEMINI_API_KEY: "g" } as unknown as Env),
      );
      expect(err.code).toBe("config");
      expect(err.message).toMatch(/AI_EMBED_DIMS/);
    }
  });

  it("exposes the signature via embeddingSignature", () => {
    const e = { AI_GATEWAY_BASE: "https://gw.test/x", GEMINI_API_KEY: "g" } as unknown as Env;
    expect(embeddingSignature(e)).toBe(embedConfig(e).signature);
  });
});

describe("llm via an OpenAI-compatible provider", () => {
  const CHAT_URL = "https://oai.test/v1/chat/completions";

  interface CompatBody {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
    response_format?: unknown;
  }

  const compatReply = (content: string, usage = { prompt_tokens: 0, completion_tokens: 0 }) => ({
    choices: [{ message: { content } }],
    usage,
  });

  const setupCompat = () =>
    setEnvVars({ AI_BASE_URL: "https://oai.test/v1", AI_API_KEY: "sk-test", AI_MODEL: "oai-test-model" });

  const clearAiEnv = () =>
    setEnvVars({
      AI_BASE_URL: undefined,
      AI_API_KEY: undefined,
      AI_MODEL: undefined,
      AI_FALLBACK_MODEL: undefined,
      GEMINI_API_KEY: "dev-gemini",
    });

  beforeAll(async () => {
    await network.enable();
  });

  afterEach(() => {
    network.resetHandlers();
    clearAiEnv();
  });

  afterAll(async () => {
    await network.disable();
  });

  it("posts chat/completions with bearer auth and parses the response", async () => {
    setupCompat();
    const seen: { auth: string | null; body: CompatBody } = { auth: null, body: {} };
    network.use(
      http.post(CHAT_URL, async ({ request }) => {
        seen.auth = request.headers.get("authorization");
        seen.body = (await request.json()) as CompatBody;
        return HttpResponse.json(compatReply('{"ok":true}', { prompt_tokens: 7, completion_tokens: 3 }));
      }),
    );
    const res = await llmJson(env, { system: "be terse", user: "Say ok" }, (v) => v as { ok: boolean });
    expect(seen.auth).toBe("Bearer sk-test");
    expect(seen.body.model).toBe("oai-test-model");
    expect(seen.body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "Say ok" },
    ]);
    expect(seen.body.max_tokens).toBe(2048);
    expect(seen.body.temperature).toBe(0.2);
    expect(seen.body.response_format).toEqual({ type: "json_object" });
    expect(res).toEqual({ value: { ok: true }, tokensIn: 7, tokensOut: 3, model: "oai-test-model" });
  });

  it("omits the Authorization header when no key resolves", async () => {
    setEnvVars({ AI_BASE_URL: "https://oai.test/v1", AI_API_KEY: "", AI_MODEL: "oai-test-model", GEMINI_API_KEY: "" });
    let auth: string | null = "unset";
    network.use(
      http.post(CHAT_URL, ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json(compatReply('{"ok":true}'));
      }),
    );
    const res = await llmJson(env, { user: "Say ok" }, (v) => v as { ok: boolean });
    expect(res.value).toEqual({ ok: true });
    expect(auth).toBeNull();
  });

  it("retries a 5xx and succeeds on the second attempt", async () => {
    setupCompat();
    let calls = 0;
    network.use(
      http.post(CHAT_URL, () => {
        calls += 1;
        return calls === 1 ? HttpResponse.text("boom", { status: 500 }) : HttpResponse.json(compatReply('{"ok":true}'));
      }),
    );
    const res = await llmJson(env, { user: "Say ok" }, (v) => v as { ok: boolean });
    expect(res.value).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("falls back to AI_FALLBACK_MODEL on availability failures", async () => {
    setEnvVars({
      AI_BASE_URL: "https://oai.test/v1",
      AI_API_KEY: "sk-test",
      AI_MODEL: "oai-test-model",
      AI_FALLBACK_MODEL: "oai-fallback",
    });
    const models: string[] = [];
    network.use(
      http.post(CHAT_URL, async ({ request }) => {
        const body = (await request.json()) as CompatBody;
        models.push(body.model ?? "");
        if (body.model === "oai-fallback") return HttpResponse.json(compatReply('{"ok":true}'));
        return HttpResponse.text("down", { status: 503 });
      }),
    );
    const res = await llmJson(env, { user: "Say ok" }, (v) => v as { ok: boolean });
    expect(res.model).toBe("oai-fallback");
    expect(models).toEqual(["oai-test-model", "oai-test-model", "oai-test-model", "oai-fallback"]);
  });

  it("does not fall back when AI_FALLBACK_MODEL is unset", async () => {
    setupCompat();
    let calls = 0;
    network.use(
      http.post(CHAT_URL, () => {
        calls += 1;
        return HttpResponse.text("down", { status: 503 });
      }),
    );
    await expect(llmJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({ code: "http", status: 503 });
    expect(calls).toBe(3);
  });

  it("drops JSON mode once when the provider rejects response_format", async () => {
    setupCompat();
    const bodies: CompatBody[] = [];
    network.use(
      http.post(CHAT_URL, async ({ request }) => {
        const body = (await request.json()) as CompatBody;
        bodies.push(body);
        if (body.response_format) {
          return HttpResponse.json({ error: { message: "unknown parameter: response_format" } }, { status: 400 });
        }
        return HttpResponse.json(compatReply('{"ok":true}'));
      }),
    );
    const res = await llmJson(env, { user: "Say ok" }, (v) => v as { ok: boolean });
    expect(res.value).toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].response_format).toBeUndefined();
  });

  it("keeps parse failures fail-fast even with a fallback configured", async () => {
    setEnvVars({
      AI_BASE_URL: "https://oai.test/v1",
      AI_API_KEY: "sk-test",
      AI_MODEL: "oai-test-model",
      AI_FALLBACK_MODEL: "oai-fallback",
    });
    let calls = 0;
    network.use(
      http.post(CHAT_URL, () => {
        calls += 1;
        return HttpResponse.json(compatReply("not json at all"));
      }),
    );
    await expect(llmJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({ code: "parse" });
    expect(calls).toBe(1);
  });

  it("fails with a config error before any fetch when AI_MODEL is missing", async () => {
    setEnvVars({ AI_BASE_URL: "https://oai.test/v1" });
    await expect(llmJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({ code: "config" });
  });

  it("lets input.model override the configured model", async () => {
    setupCompat();
    const seen: { body: CompatBody } = { body: {} };
    network.use(
      http.post(CHAT_URL, async ({ request }) => {
        seen.body = (await request.json()) as CompatBody;
        return HttpResponse.json(compatReply('{"ok":true}'));
      }),
    );
    await llmJson(env, { model: "custom-1", user: "Say ok" }, (v) => v);
    expect(seen.body.model).toBe("custom-1");
  });
});

describe("compatible embeddings (embedTexts)", () => {
  const EMB_COMPAT_URL = "https://oai.test/v1/embeddings";

  interface CompatEmbBody {
    model?: string;
    input?: string[];
    dimensions?: number;
  }

  const clearAiEnv = () =>
    setEnvVars({
      AI_BASE_URL: undefined,
      AI_API_KEY: undefined,
      AI_MODEL: undefined,
      AI_FALLBACK_MODEL: undefined,
      AI_EMBED_BASE_URL: undefined,
      AI_EMBED_API_KEY: undefined,
      AI_EMBED_MODEL: undefined,
      AI_EMBED_DIMS: undefined,
      GEMINI_API_KEY: "dev-gemini",
    });

  beforeAll(async () => {
    await network.enable();
  });
  afterEach(() => {
    network.resetHandlers();
    clearAiEnv();
  });
  afterAll(async () => {
    await network.disable();
  });

  it("posts {model, input} without dimensions by default and stays keyless", async () => {
    setEnvVars({
      AI_BASE_URL: "https://oai.test/v1",
      AI_EMBED_MODEL: "text-embedding-3-small",
      AI_EMBED_API_KEY: "",
      AI_API_KEY: "",
      GEMINI_API_KEY: "",
    });
    const seen: { auth: string | null; body: CompatEmbBody } = { auth: null, body: {} };
    network.use(
      http.post(EMB_COMPAT_URL, async ({ request }) => {
        seen.auth = request.headers.get("authorization");
        seen.body = (await request.json()) as CompatEmbBody;
        return HttpResponse.json({ data: (seen.body.input ?? []).map((t) => ({ embedding: fakeVec(t) })) });
      }),
    );
    const out = await embedTexts(env, ["alpha", "beta"]);
    expect(seen.auth).toBeNull();
    expect(seen.body.model).toBe("text-embedding-3-small");
    expect(seen.body.input).toEqual(["alpha", "beta"]);
    expect(seen.body.dimensions).toBeUndefined();
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(fakeVec("alpha"));
    expect(out[1]).toEqual(fakeVec("beta"));
  });

  it("orders the response by index when the provider returns items out of order", async () => {
    setEnvVars({ AI_BASE_URL: "https://oai.test/v1", AI_EMBED_MODEL: "m" });
    network.use(
      http.post(EMB_COMPAT_URL, () =>
        HttpResponse.json({
          data: [
            { index: 1, embedding: fakeVec("b") },
            { index: 0, embedding: fakeVec("a") },
          ],
        }),
      ),
    );
    const out = await embedTexts(env, ["a", "b"]);
    expect(out[0]).toEqual(fakeVec("a"));
    expect(out[1]).toEqual(fakeVec("b"));
  });

  it("sends dimensions only when AI_EMBED_DIMS is set", async () => {
    setEnvVars({ AI_BASE_URL: "https://oai.test/v1", AI_EMBED_MODEL: "m", AI_EMBED_DIMS: "1536" });
    const seen: { body: CompatEmbBody } = { body: {} };
    network.use(
      http.post(EMB_COMPAT_URL, async ({ request }) => {
        seen.body = (await request.json()) as CompatEmbBody;
        return HttpResponse.json({
          data: (seen.body.input ?? []).map(() => ({ embedding: new Array(1536).fill(0.5) })),
        });
      }),
    );
    const out = await embedTexts(env, ["one"]);
    expect(seen.body.dimensions).toBe(1536);
    expect(out[0]).toHaveLength(1536);
  });

  it("rejects a response with the wrong count", async () => {
    setEnvVars({ AI_BASE_URL: "https://oai.test/v1", AI_EMBED_MODEL: "m" });
    network.use(http.post(EMB_COMPAT_URL, () => HttpResponse.json({ data: [{ embedding: fakeVec("only") }] })));
    await expect(embedTexts(env, ["one", "two"])).rejects.toMatchObject({ code: "parse" });
  });

  it("rejects wrong-size vectors and names the fix", async () => {
    setEnvVars({ AI_BASE_URL: "https://oai.test/v1", AI_EMBED_MODEL: "m" });
    network.use(
      http.post(EMB_COMPAT_URL, () => HttpResponse.json({ data: [{ embedding: new Array(512).fill(0.1) }] })),
    );
    const err = (await embedTexts(env, ["one"]).catch((e) => e)) as LlmError;
    expect(err.code).toBe("parse");
    expect(err.message).toMatch(/512/);
    expect(err.message).toMatch(/768/);
    expect(err.message).toMatch(/Vectorize/);
  });
});
