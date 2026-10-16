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
  geminiJson,
  LlmError,
} from "../src/llm";
import { network } from "./server";

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
    const res = await geminiJson(env, { user: "Say ok", system: "be terse" }, (v) => v as { ok: boolean });
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
    const res = await geminiJson(env, { user: "Say ok" }, (v) => v as { ok: boolean });
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
    await expect(geminiJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({
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
    const res = await geminiJson(env, { user: "Say ok" }, (v) => v as { ok: boolean });
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
    const res = await geminiJson(env, { user: "Say ok" }, (v) => v as { ok: boolean });
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
    await expect(geminiJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({
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
    await expect(geminiJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({
      code: "http",
      status: 400,
    });
    expect(calls).toBe(1);
  });

  it("maps non-JSON model text to LlmError parse", async () => {
    network.use(http.post(GEN_URL, () => HttpResponse.json(genReply("not json at all"))));
    await expect(geminiJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({ code: "parse" });
  });

  it("maps validator failures to LlmError parse", async () => {
    network.use(http.post(GEN_URL, () => HttpResponse.json(genReply("{}"))));
    await expect(
      geminiJson(env, { user: "Say ok" }, () => {
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
