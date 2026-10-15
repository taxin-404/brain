import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { embedTexts, geminiJson, LlmError } from "../src/llm";
import { network } from "./server";

const GEN_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-3.5-flash-lite:generateContent";
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

  it("gives up after three 5xx replies with LlmError http", async () => {
    let calls = 0;
    network.use(
      http.post(GEN_URL, () => {
        calls += 1;
        return HttpResponse.text("boom", { status: 500 });
      }),
    );
    await expect(geminiJson(env, { user: "Say ok" }, (v) => v)).rejects.toMatchObject({
      name: "LlmError",
      code: "http",
      status: 500,
    });
    expect(calls).toBe(3);
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
