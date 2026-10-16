import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { embedPendingFacts, readIndexDims } from "../src/embed";
import { LlmError } from "../src/llm";
import { fakeVec, installFakeVectorize, seedFact, setEnvVars } from "./helpers";
import { network } from "./server";

const EMB_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-embedding-001:batchEmbedContents";

const handleEmbed = () =>
  network.use(
    http.post(EMB_URL, async ({ request }) => {
      const body = (await request.json()) as {
        requests?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const reqs = body.requests ?? [];
      return HttpResponse.json({ embeddings: reqs.map((r) => ({ values: fakeVec(r.content?.parts?.[0]?.text ?? "") })) });
    }),
  );

describe("embedPendingFacts", () => {
  beforeAll(async () => {
    await network.enable();
  });
  afterEach(() => {
    network.resetHandlers();
    setEnvVars({
      AI_BASE_URL: undefined,
      AI_EMBED_BASE_URL: undefined,
      AI_EMBED_API_KEY: undefined,
      AI_EMBED_MODEL: undefined,
      AI_EMBED_DIMS: undefined,
    });
  });
  afterAll(async () => {
    await network.disable();
  });

  it("embeds pending facts, sets vec_id, and stores exact metadata", async () => {
    const store = installFakeVectorize();
    handleEmbed();
    const factId = await seedFact({ name: "seed", predicate: "text", object: "alpha" });
    const restrictedId = await seedFact({ name: "vault", predicate: "login", object: "hunter2", sensitivity: "restricted" });

    const run = await embedPendingFacts(env);
    expect(run).toEqual({ embedded: 1, failed: 0 });

    const vecRow = await env.BRAIN_DB.prepare(`SELECT vec_id FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ vec_id: string | null }>();
    expect(vecRow?.vec_id).toBe(factId);
    const restrictedRow = await env.BRAIN_DB.prepare(`SELECT vec_id FROM facts WHERE id = ?1`)
      .bind(restrictedId)
      .first<{ vec_id: string | null }>();
    expect(restrictedRow?.vec_id).toBeNull();

    expect(store.size).toBe(1);
    expect(store.get(factId)?.metadata).toEqual({
      fact_id: factId,
      type: "fact",
      status: "active",
      sensitivity: "normal",
      embedding_model: "gemini-embedding-001@768",
      updated_at: expect.any(Number),
    });

    // the fake index answers queries by cosine: the exact text matches first
    const res = await env.VECTORIZE.query(fakeVec("seed text alpha"), { topK: 5 });
    expect(res.matches[0]?.id).toBe(factId);
  });

  it("counts gateway failures, leaves vec_id NULL, and never throws", async () => {
    const store = installFakeVectorize();
    network.use(http.post(EMB_URL, () => HttpResponse.text("boom", { status: 500 })));
    const factId = await seedFact({ name: "failing", predicate: "text", object: "beta" });

    const run = await embedPendingFacts(env);
    expect(run).toEqual({ embedded: 0, failed: 1 });

    const row = await env.BRAIN_DB.prepare(`SELECT vec_id FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ vec_id: string | null }>();
    expect(row?.vec_id).toBeNull();
    expect(store.size).toBe(0);
  });

  it("does not re-embed legacy rows whose bare model matches the current signature", async () => {
    const store = installFakeVectorize();
    handleEmbed();
    await embedPendingFacts(env); // flush facts left pending by earlier tests
    const factId = await seedFact({ name: "legacy", predicate: "text", object: "old alpha" });
    const first = await embedPendingFacts(env);
    expect(first).toEqual({ embedded: 1, failed: 0 });

    // simulate a pre-signature row: bare model name, vector already present
    await env.BRAIN_DB.prepare(`UPDATE facts SET embedding_model = 'gemini-embedding-001' WHERE id = ?1`)
      .bind(factId)
      .run();
    let calls = 0;
    network.use(
      http.post(EMB_URL, () => {
        calls += 1;
        return HttpResponse.json({ embeddings: [] });
      }),
    );

    const sizeBefore = store.size;
    const second = await embedPendingFacts(env);
    expect(second).toEqual({ embedded: 0, failed: 0 });
    expect(calls).toBe(0);
    expect(store.size).toBe(sizeBefore);
  });

  it("re-embeds rows when the embedding signature changes", async () => {
    const store = installFakeVectorize();
    handleEmbed();
    await embedPendingFacts(env); // flush facts left pending by earlier tests
    const factId = await seedFact({ name: "switcher", predicate: "text", object: "delta" });
    const first = await embedPendingFacts(env);
    expect(first).toEqual({ embedded: 1, failed: 0 });
    expect(store.get(factId)?.metadata.embedding_model).toBe("gemini-embedding-001@768");

    // pin every other vector to the target signature so only our fact is stale
    await env.BRAIN_DB.prepare(`UPDATE facts SET embedding_model = 'other-embed@768' WHERE id != ?1 AND vec_id IS NOT NULL`)
      .bind(factId)
      .run();

    // switch embeddings to a compatible provider with a different model
    setEnvVars({ AI_BASE_URL: "https://oai.test/v1", AI_EMBED_MODEL: "other-embed" });
    network.use(
      http.post("https://oai.test/v1/embeddings", async ({ request }) => {
        const body = (await request.json()) as { input?: string[] };
        return HttpResponse.json({ data: (body.input ?? []).map((t) => ({ embedding: fakeVec(t) })) });
      }),
    );

    const second = await embedPendingFacts(env);
    expect(second).toEqual({ embedded: 1, failed: 0 });
    const row = await env.BRAIN_DB.prepare(`SELECT embedding_model FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ embedding_model: string | null }>();
    expect(row?.embedding_model).toBe("other-embed@768");
    expect(store.get(factId)?.metadata.embedding_model).toBe("other-embed@768");
  });

  it("fails loudly when the index dimensions and the expected dims disagree", async () => {
    installFakeVectorize({ dims: 512 });
    const err = (await embedPendingFacts(env).catch((e) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe("config");
    expect(err.message).toMatch(/512/);
    expect(err.message).toMatch(/AI_EMBED_DIMS/);
  });

  it("reads index dims from either describe() shape", () => {
    expect(readIndexDims({ config: { dimensions: 768, metric: "cosine" } })).toBe(768);
    expect(readIndexDims({ dimensions: 512 })).toBe(512);
    expect(readIndexDims({ config: { preset: "some-preset" } })).toBeNull();
    expect(readIndexDims({})).toBeNull();
  });

  it("re-embeds pre-signature rows when the dims change (legacy counts only at the default size)", async () => {
    const store = installFakeVectorize({ dims: 1536 });
    setEnvVars({ AI_EMBED_DIMS: "1536" });
    network.use(
      http.post(EMB_URL, async ({ request }) => {
        const body = (await request.json()) as {
          requests?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const reqs = body.requests ?? [];
        return HttpResponse.json({ embeddings: reqs.map((r) => ({ values: fakeVec(r.content?.parts?.[0]?.text ?? "", 1536) })) });
      }),
    );
    await embedPendingFacts(env); // flush facts left pending by earlier tests at the new dims

    const factId = await seedFact({ name: "dims switch", predicate: "text", object: "epsilon" });
    const first = await embedPendingFacts(env);
    expect(first).toEqual({ embedded: 1, failed: 0 });

    // pre-signature state: bare model name, vector already present
    await env.BRAIN_DB.prepare(`UPDATE facts SET embedding_model = 'gemini-embedding-001' WHERE id = ?1`)
      .bind(factId)
      .run();

    const second = await embedPendingFacts(env);
    expect(second).toEqual({ embedded: 1, failed: 0 });
    const row = await env.BRAIN_DB.prepare(`SELECT embedding_model FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ embedding_model: string | null }>();
    expect(row?.embedding_model).toBe("gemini-embedding-001@1536");
    expect(store.get(factId)?.metadata.embedding_model).toBe("gemini-embedding-001@1536");
  });
});
