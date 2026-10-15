import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { embedPendingFacts } from "../src/embed";
import { fakeVec } from "./helpers";
import { network } from "./server";

const EMB_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-embedding-001:batchEmbedContents";

interface StoredVector {
  id: string;
  values: number[];
  metadata: Record<string, unknown>;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

/** In-memory Vectorize stand-in installed through the env proxy (same seam as
 *  test/smoke.test.ts — miniflare has no local Vectorize simulation). */
const installFakeVectorize = () => {
  const store = new Map<string, StoredVector>();
  const index = {
    upsert: async (vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) => {
      for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: v.metadata ?? {} });
      return { mutationId: "test" };
    },
    insert: async (vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) => {
      for (const v of vectors) store.set(v.id, { id: v.id, values: v.values, metadata: v.metadata ?? {} });
      return { mutationId: "test" };
    },
    query: async (values: number[], options?: { topK?: number }) => {
      const scored = [...store.values()]
        .map((v) => ({ id: v.id, score: cosine(values, v.values) }))
        .sort((a, b) => b.score - a.score);
      return { matches: scored.slice(0, options?.topK ?? 10) };
    },
    deleteByIds: async () => ({ mutationId: "test" }),
    describe: async () => ({ name: "fake", config: {}, vectorsCount: store.size }),
  };
  (env as unknown as Record<string, unknown>).VECTORIZE = index as unknown as VectorizeIndex;
  return store;
};

let nextTs = 1_750_000_000_000;

const seedFact = async (over: {
  name: string;
  predicate: string;
  object: string;
  sensitivity?: string;
  status?: string;
}) => {
  const now = (nextTs += 1000);
  const entityId = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO entities (id, type, name, norm_name, first_seen_at, last_seen_at)
     VALUES (?1, 'Project', ?2, ?3, ?4, ?4)`,
  )
    .bind(entityId, over.name, over.name.toLowerCase(), now)
    .run();
  const factId = newEventId();
  const eventId = `evt-${factId}`;
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'user', 1.0, NULL, 'note', 'normal', 'embed seed', ?4)`,
  )
    .bind(eventId, now, now, `hmac-${eventId}`)
    .run();
  await env.BRAIN_DB.prepare(
    `INSERT INTO facts (id, subject_id, predicate, object_text, fact_kind, confidence, status,
                        learned_at, first_seen_at, last_confirmed_at, sensitivity, source_event_id,
                        embedding_model, vec_id)
     VALUES (?1, ?2, ?3, ?4, 'user_stated', 0.9, ?5, ?6, ?6, ?6, ?7, ?8, 'gemini-embedding-001', NULL)`,
  )
    .bind(
      factId,
      entityId,
      over.predicate,
      over.object,
      over.status ?? "active",
      now,
      over.sensitivity ?? "normal",
      eventId,
    )
    .run();
  return factId;
};

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
