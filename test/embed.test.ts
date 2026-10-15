import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { embedPendingFacts } from "../src/embed";
import { fakeVec, installFakeVectorize, seedFact } from "./helpers";
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
      embedding_model: "gemini-embedding-001",
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
});
