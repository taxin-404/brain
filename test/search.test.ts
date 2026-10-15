import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventInput } from "../src/ingest";
import { bearer, call, fakeVec, installFakeVectorize, seedFact, type StoredVector } from "./helpers";
import { network } from "./server";

const EMB_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-embedding-001:batchEmbedContents";

const seed = (over: Partial<EventInput>) =>
  call("POST", "/v1/events", { source: "manual", actor: "user", kind: "note", ...over }, bearer(env, "MCP_PROPOSE"));
const search = (qs: string, scope: "MCP_READ" | "ADMIN" = "MCP_READ") =>
  call("GET", `/v1/search${qs}`, undefined, bearer(env, scope));

const VEC_META = (id: string, sensitivity: string) => ({
  fact_id: id,
  type: "fact",
  status: "active",
  sensitivity,
  embedding_model: "gemini-embedding-001",
  updated_at: 0,
});
const mark = (id: string, values: number[], sensitivity: string): StoredVector => ({
  id,
  values,
  metadata: VEC_META(id, sensitivity),
});
// same direction as the query vector but not identical → cosine < 1 → second place
const perturb = (v: number[]) => v.map((x, i) => (i === 0 ? x + 0.1 : x));

let store: Map<string, StoredVector>;

describe("search", () => {
  beforeAll(async () => {
    await network.enable();
  });
  beforeEach(() => {
    store = installFakeVectorize();
    network.use(
      http.post(EMB_URL, async ({ request }) => {
        const body = (await request.json()) as {
          requests?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const reqs = body.requests ?? [];
        return HttpResponse.json({ embeddings: reqs.map((r) => ({ values: fakeVec(r.content?.parts?.[0]?.text ?? "") })) });
      }),
    );
  });
  afterEach(() => {
    network.resetHandlers();
  });
  afterAll(async () => {
    await network.disable();
  });

  it("returns keyword hits and excludes restricted for read scope", async () => {
    await seed({ session_id: "sq-1", payload: { text: "kubernetes rollout plan" } });
    await seed({ session_id: "sq-2", privacy: "restricted", payload: { text: "kubernetes restricted detail" } });
    const res = await search("?q=kubernetes");
    expect(res.status).toBe(200);
    const body = await res.json<{ results: Array<{ excerpt: string }> }>();
    expect(body.results.some((r) => r.excerpt.includes("rollout plan"))).toBe(true);
    expect(body.results.some((r) => r.excerpt.includes("restricted detail"))).toBe(false);
    expect((await search("?q=kubernetes&include_restricted=true")).status).toBe(403);
    const admin = await search("?q=kubernetes&include_restricted=true", "ADMIN");
    expect((await admin.json<{ results: unknown[] }>()).results.length).toBeGreaterThanOrEqual(2);
  });

  it("never returns purged events", async () => {
    const id = (await (await seed({ session_id: "sq-3", payload: { text: "vanishterm unique" } })).json<{ results: Array<{ id: string }> }>()).results[0].id;
    const token = (await (await call("POST", "/v1/confirm/token", { target: `event:${id}` }, bearer(env, "ADMIN"))).json<{ token: string }>()).token;
    await call("POST", `/v1/events/${id}/purge`, { confirm_token: token, reason: "t" }, bearer(env, "ADMIN"));
    const body = await (await search("?q=vanishterm")).json<{ results: unknown[] }>();
    expect(body.results).toEqual([]);
  });

  it("sanitizes FTS metacharacters and validates input", async () => {
    expect((await search("")).status).toBe(400);
    expect((await search('?q=kube" OR x=1')).status).toBe(200);
    expect((await call("GET", "/v1/search?q=x")).status).toBe(401);
  });

  it("blends vector and keyword ranks with RRF modifiers", async () => {
    const ageDays = 30;
    const learnedAt = Date.now() - ageDays * 86_400_000;
    const a = await seedFact({ name: "blend-a", predicate: "prefers", object: "alpenglow", confidence: 0.9, learnedAt, lastConfirmedAt: null });
    const b = await seedFact({ name: "blend-b", predicate: "prefers", object: "borealis", confidence: 0.5, learnedAt, lastConfirmedAt: null });
    // crafted vector list: B is the exact query vector (rank 1), A is a close second (rank 2)
    const qvec = fakeVec("alpenglow");
    store.set(b, mark(b, qvec, "normal"));
    store.set(a, mark(a, perturb(qvec), "normal"));

    const body = await (await search("?q=alpenglow")).json<{
      facts: Array<{ id: string; score: number; subject: string; predicate: string; object: string }>;
    }>();
    // A is the only keyword hit (rank 1) and vector rank 2; B has vector rank 1 only.
    const age = 0.1 * Math.exp(-ageDays / 30);
    const expectedA = 1 / (60 + 2) + 1 / (60 + 1) + age + 0.05 * 0.9;
    const expectedB = 1 / (60 + 1) + age + 0.05 * 0.5;
    expect(body.facts.map((f) => f.id)).toEqual([a, b]);
    expect(body.facts[0].score).toBeCloseTo(expectedA, 4);
    expect(body.facts[1].score).toBeCloseTo(expectedB, 4);
    expect(body.facts[0]).toMatchObject({ subject: "blend-a", predicate: "prefers", object: "alpenglow" });
  });

  it("breaks score ties by id ascending", async () => {
    const learnedAt = Date.now() - 86_400_000;
    const c = await seedFact({ name: "tie-c", predicate: "rel", object: "zebra", confidence: 0.9, learnedAt, lastConfirmedAt: null });
    const d = await seedFact({ name: "tie-d", predicate: "rel", object: "tiebreak", confidence: 0.9, learnedAt, lastConfirmedAt: null });
    store.set(c, mark(c, fakeVec("tiebreak"), "normal")); // vector rank 1, no keyword hit

    const body = await (await search("?q=tiebreak")).json<{ facts: Array<{ id: string; score: number }> }>();
    expect(body.facts).toHaveLength(2);
    // C: 1/61 (vector) vs D: 1/61 (keyword) + identical modifiers → exact tie
    expect(body.facts[0].score).toBeCloseTo(body.facts[1].score, 10);
    expect(body.facts.map((f) => f.id)).toEqual([c, d].sort());
  });

  it("degrades to keyword-only facts when embedding fails", async () => {
    const f = await seedFact({ name: "degrade-f", predicate: "rel", object: "degradekeyword note", confidence: 0.8 });
    network.use(http.post(EMB_URL, () => HttpResponse.text("boom", { status: 500 })));

    const res = await search("?q=degradekeyword");
    expect(res.status).toBe(200);
    const body = await res.json<{ facts: Array<{ id: string }>; degraded?: boolean }>();
    expect(body.degraded).toBe(true);
    expect(body.facts.map((x) => x.id)).toEqual([f]);
  });

  it("hides restricted facts from read scope but shows them to include_restricted admins", async () => {
    const r = await seedFact({ name: "restricted-r", predicate: "rel", object: "restrictedkeyword secret", sensitivity: "restricted" });
    const n = await seedFact({ name: "normal-n", predicate: "rel", object: "restrictedkeyword public" });
    // R ranks first in the vector list: read scope must filter it in code, not just at query time
    const qvec = fakeVec("restrictedkeyword");
    store.set(r, mark(r, qvec, "restricted"));
    store.set(n, mark(n, perturb(qvec), "normal"));

    const read = await (await search("?q=restrictedkeyword")).json<{ facts: Array<{ id: string }> }>();
    expect(read.facts.map((x) => x.id)).toEqual([n]);
    const admin = await (await search("?q=restrictedkeyword&include_restricted=true", "ADMIN")).json<{ facts: Array<{ id: string }> }>();
    expect(admin.facts.map((x) => x.id).sort()).toEqual([n, r].sort());
  });

  it("serves GET /v1/facts/:id with provenance and hides restricted from read scope", async () => {
    const f = await seedFact({ name: "detail-d", predicate: "rel", object: "detailobject", confidence: 0.7 });
    const r = await seedFact({ name: "detail-r", predicate: "rel", object: "detailsecret", sensitivity: "restricted" });

    const res = await call("GET", `/v1/facts/${f}`, undefined, bearer(env, "MCP_READ"));
    expect(res.status).toBe(200);
    const body = await res.json<{
      id: string;
      subject: string;
      predicate: string;
      object: string;
      fact_kind: string;
      confidence: number;
      status: string;
      sources: Array<{ event_id: string; ts: number; kind: string }>;
    }>();
    expect(body).toMatchObject({
      id: f,
      subject: "detail-d",
      predicate: "rel",
      object: "detailobject",
      fact_kind: "user_stated",
      confidence: 0.7,
      status: "active",
    });
    expect(body.sources).toEqual([{ event_id: `evt-${f}`, ts: expect.any(Number), kind: "note" }]);

    expect((await call("GET", `/v1/facts/${r}`, undefined, bearer(env, "MCP_READ"))).status).toBe(404);
    expect((await call("GET", `/v1/facts/${r}`, undefined, bearer(env, "ADMIN"))).status).toBe(200);
    expect((await call("GET", "/v1/facts/nope", undefined, bearer(env, "MCP_READ"))).status).toBe(404);
    expect((await call("GET", `/v1/facts/${f}`)).status).toBe(401);
  });
});
