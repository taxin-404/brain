import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import cases from "../eval/forget.json";
import { newEventId } from "../src/crypto";
import { embedPendingFacts } from "../src/embed";
import { resolveSubject } from "../src/entities";
import { createFact } from "../src/factstore";
import { createProposal } from "../src/proposals";
import { bearer, call, fakeVec, installFakeVectorize, type StoredVector } from "./helpers";
import { network } from "./server";

const EMB_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-embedding-001:batchEmbedContents";

interface FactSpec {
  subject: string;
  predicate: string;
  object: string;
  kind: "user_stated" | "observed" | "inferred" | "guess" | "temporary";
  confidence: number;
  sensitivity: string;
}

interface Case {
  name: "supersession" | "drift" | "dispute" | "purge" | "restricted";
  setup: { fact?: FactSpec; facts?: FactSpec[] };
  action: { type: "correct" | "dispute" | "purge" | "none"; correction?: string; query: string; reason?: string };
  expect: Record<string, unknown>;
}

const CASES = cases as Case[];

/** Offline forget/supersession eval (mirrors test/eval-semantic.test.ts): every
 *  case seeds D1 + a fake Vectorize where the stored vector equals the query's
 *  embedding (cosine 1.0), so a miss can only come from the forget semantics
 *  themselves — never from weak similarity. Zero network (MSW). */

let store: Map<string, StoredVector>;

const seedEvent = async (): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'user', 1.0, 'forget-eval', 'note', 'normal', 'forget eval evidence', ?4)`,
  )
    .bind(id, Date.now(), Date.now(), `hmac-${id}`)
    .run();
  return id;
};

const vector = (id: string, query: string): StoredVector => ({
  id,
  values: fakeVec(query),
  metadata: {
    fact_id: id,
    type: "fact",
    // deliberately claims active/normal even when D1 disagrees: the search
    // re-check (not the index metadata) is what must hide forgotten facts
    status: "active",
    sensitivity: "normal",
    embedding_model: "gemini-embedding-001",
    updated_at: 0,
  },
});

const seedFactFrom = async (spec: FactSpec, query: string): Promise<string> => {
  const subject = await resolveSubject(env.BRAIN_DB, spec.subject, "Project");
  const id = await createFact(env, {
    subjectId: subject.id,
    subjectName: subject.name,
    predicate: spec.predicate,
    objectText: spec.object,
    factKind: spec.kind,
    confidence: spec.confidence,
    sensitivity: spec.sensitivity,
    sourceEventId: await seedEvent(),
  });
  store.set(id, vector(id, query));
  return id;
};

const searchObjects = async (
  query: string,
  scope: "MCP_READ" | "ADMIN" = "MCP_READ",
  opts: { includeRestricted?: boolean } = {},
): Promise<Array<{ id: string; object: string }>> => {
  const extra = opts.includeRestricted ? "&include_restricted=true" : "";
  const res = await call("GET", `/v1/search?q=${encodeURIComponent(query)}&limit=10${extra}`, undefined, bearer(env, scope));
  expect(res.status).toBe(200);
  return (await res.json<{ facts: Array<{ id: string; object: string }> }>()).facts;
};

const byName = (name: Case["name"]): Case => {
  const c = CASES.find((x) => x.name === name);
  if (!c) throw new Error(`forget eval case missing: ${name}`);
  return c;
};

describe("forget eval (offline, deterministic vectors)", () => {
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
        return HttpResponse.json({
          embeddings: reqs.map((r) => ({ values: fakeVec(r.content?.parts?.[0]?.text ?? "") })),
        });
      }),
    );
  });
  afterEach(() => {
    network.resetHandlers();
  });
  afterAll(async () => {
    await network.disable();
  });

  it("covers every documented case exactly once", () => {
    expect([...CASES.map((c) => c.name)].sort()).toEqual([
      "dispute",
      "drift",
      "purge",
      "restricted",
      "supersession",
    ]);
  });

  it("supersession: old absent from search, new present, why keeps both versions", async () => {
    const c = byName("supersession");
    const expectSpec = c.expect as { why_versions: number; search_hits: string[]; search_misses: string[] };
    const factId = await seedFactFrom(c.setup.fact!, c.action.query);

    const proposal = await createProposal(env, "ADMIN", {
      kind: "correction",
      payload: { fact_id: factId, correction: c.action.correction! },
      target_type: "fact",
      target_id: factId,
      evidence_event_id: await seedEvent(),
      sensitivity: c.setup.fact!.sensitivity,
    });
    expect(proposal.applied).toBe(true);

    const old = await env.BRAIN_DB.prepare(`SELECT status, superseded_by FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ status: string; superseded_by: string | null }>();
    expect(old?.status).toBe("superseded");
    expect(store.has(factId)).toBe(false); // old vector removed
    const newId = old!.superseded_by!;
    store.set(newId, vector(newId, c.action.query));

    const why = await call("GET", `/v1/why/${factId}`, undefined, bearer(env, "ADMIN"));
    const whyBody = await why.json<{ versions: Array<{ id: string; object: string | null; current: boolean }> }>();
    expect(whyBody.versions).toHaveLength(expectSpec.why_versions);
    expect(whyBody.versions.some((v) => v.current && v.id === newId)).toBe(true);

    const hits = await searchObjects(c.action.query);
    for (const h of expectSpec.search_hits) expect(hits.some((f) => f.object.includes(h))).toBe(true);
    for (const m of expectSpec.search_misses) expect(hits.some((f) => f.object.includes(m))).toBe(false);
  });

  it("drift: multivalued pair stays active and searchable", async () => {
    const c = byName("drift");
    const expectSpec = c.expect as { active_objects: string[]; search_hits: string[] };
    const ids: string[] = [];
    for (const spec of c.setup.facts!) ids.push(await seedFactFrom(spec, c.action.query));

    const { results } = await env.BRAIN_DB.prepare(
      `SELECT object_text FROM facts WHERE id IN (?1, ?2) AND status = 'active' ORDER BY object_text`,
    )
      .bind(ids[0], ids[1])
      .all<{ object_text: string }>();
    expect(results.map((r) => r.object_text)).toEqual(expectSpec.active_objects);

    const hits = await searchObjects(c.action.query);
    for (const h of expectSpec.search_hits) expect(hits.some((f) => f.object.includes(h))).toBe(true);
  });

  it("dispute: disputed fact is never embedded and never searchable", async () => {
    const c = byName("dispute");
    const expectSpec = c.expect as { status: string; vec_id: string | null; search_misses: string[] };
    const factId = await seedFactFrom(c.setup.fact!, c.action.query);

    const proposal = await createProposal(env, "ADMIN", {
      kind: "dispute",
      payload: {},
      target_type: "fact",
      target_id: factId,
      sensitivity: c.setup.fact!.sensitivity,
    });
    expect(proposal.applied).toBe(true);

    const row = await env.BRAIN_DB.prepare(`SELECT status, vec_id FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ status: string; vec_id: string | null }>();
    expect(row).toMatchObject({ status: expectSpec.status });

    await embedPendingFacts(env); // the sweep's embed pass skips disputed facts
    const after = await env.BRAIN_DB.prepare(`SELECT vec_id FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ vec_id: string | null }>();
    expect(after?.vec_id).toBe(expectSpec.vec_id);

    const hits = await searchObjects(c.action.query);
    for (const m of expectSpec.search_misses) expect(hits.some((f) => f.object.includes(m))).toBe(false);
  });

  it("purge: object NULL, FTS empty, vector gone — purged material cannot resurrect", async () => {
    const c = byName("purge");
    const expectSpec = c.expect as {
      object_text: null;
      status: string;
      fts_rows: number;
      vector_removed: boolean;
      search_misses: string[];
    };
    const factId = await seedFactFrom(c.setup.fact!, c.action.query);

    const before = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM facts_fts WHERE facts_fts MATCH ?1`)
      .bind(c.setup.fact!.object)
      .first<{ n: number }>();
    expect(before?.n).toBe(1); // sanity: the codeword is indexed

    const mint = await call("POST", "/v1/confirm/token", { target: `fact:${factId}` }, bearer(env, "ADMIN"));
    const { token } = await mint.json<{ token: string }>();
    const prop = await call("POST", `/v1/facts/${factId}/purge`, { reason: c.action.reason }, bearer(env, "ADMIN"));
    const { proposal_id } = await prop.json<{ proposal_id: string }>();
    const applied = await call(
      "POST",
      `/v1/proposals/${proposal_id}/apply`,
      { confirm_token: token, reason: c.action.reason },
      bearer(env, "ADMIN"),
    );
    expect(applied.status).toBe(200);

    const row = await env.BRAIN_DB.prepare(`SELECT object_text, status, vec_id FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ object_text: string | null; status: string; vec_id: string | null }>();
    expect(row?.object_text).toBe(expectSpec.object_text);
    expect(row?.status).toBe(expectSpec.status);

    const fts = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM facts_fts WHERE facts_fts MATCH ?1`)
      .bind(c.setup.fact!.object)
      .first<{ n: number }>();
    expect(fts?.n).toBe(expectSpec.fts_rows);
    expect(store.has(factId)).toBe(!expectSpec.vector_removed);

    const hits = await searchObjects(c.action.query);
    for (const m of expectSpec.search_misses) expect(hits.some((f) => f.object.includes(m))).toBe(false);
  });

  it("restricted: hidden from read scope, served to admin, search respects scope", async () => {
    const c = byName("restricted");
    const expectSpec = c.expect as {
      read_scope: number;
      admin_scope: number;
      search_misses: string[];
      admin_search_hits: string[];
    };
    const factId = await seedFactFrom(c.setup.fact!, c.action.query);

    const readFact = await call("GET", `/v1/facts/${factId}`, undefined, bearer(env, "MCP_READ"));
    expect(readFact.status).toBe(expectSpec.read_scope);
    const readWhy = await call("GET", `/v1/why/${factId}`, undefined, bearer(env, "MCP_READ"));
    expect(readWhy.status).toBe(expectSpec.read_scope);
    const adminFact = await call("GET", `/v1/facts/${factId}`, undefined, bearer(env, "ADMIN"));
    expect(adminFact.status).toBe(expectSpec.admin_scope);

    const readHits = await searchObjects(c.action.query, "MCP_READ");
    for (const m of expectSpec.search_misses) expect(readHits.some((f) => f.object.includes(m))).toBe(false);
    // even admin search omits restricted unless explicitly opted in
    const adminDefault = await searchObjects(c.action.query, "ADMIN");
    for (const m of expectSpec.search_misses) expect(adminDefault.some((f) => f.object.includes(m))).toBe(false);
    const adminHits = await searchObjects(c.action.query, "ADMIN", { includeRestricted: true });
    for (const h of expectSpec.admin_search_hits) expect(adminHits.some((f) => f.object.includes(h))).toBe(true);
  });
});
