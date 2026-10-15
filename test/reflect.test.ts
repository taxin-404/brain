import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { resolveSubject } from "../src/entities";
import { createFact } from "../src/factstore";
import { runReflection } from "../src/reflect";
import { bearer, call, installFakeVectorize } from "./helpers";
import { network } from "./server";

const GEN_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-3.5-flash-lite:generateContent";
const DAY = 86_400_000;
const NB = 1_840_000_000_000; // base "now" for the suite

let lastGenBody = "";
let genCalls = 0;

const seedEvent = async (ts: number, excerpt: string, privacy = "normal"): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'user', 1.0, NULL, 'note', ?4, ?5, ?6)`,
  )
    .bind(id, ts, Date.now(), privacy, excerpt, `hmac-${id}`)
    .run();
  return id;
};

const seedFact = async (opts: {
  subjectName: string;
  predicate: string;
  object: string;
  now: number;
  sensitivity?: string;
}): Promise<string> => {
  const subject = await resolveSubject(env.BRAIN_DB, opts.subjectName, "Project");
  const eventId = await seedEvent(opts.now, "reflection evidence");
  return createFact(env, {
    subjectId: subject.id,
    subjectName: subject.name,
    predicate: opts.predicate,
    objectText: opts.object,
    factKind: "user_stated",
    confidence: 0.9,
    sensitivity: opts.sensitivity ?? "normal",
    sourceEventId: eventId,
    now: opts.now,
  });
};

const handleGen = (out: unknown) => {
  network.use(
    http.post(GEN_URL, async ({ request }) => {
      const body = (await request.json()) as { contents: Array<{ parts: Array<{ text: string }> }> };
      lastGenBody = body.contents[0].parts[0].text;
      genCalls += 1;
      return HttpResponse.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      });
    }),
  );
};

describe("runReflection", () => {
  beforeAll(async () => {
    await network.enable();
  });
  beforeEach(() => {
    installFakeVectorize();
    lastGenBody = "";
    genCalls = 0;
  });
  afterEach(() => {
    network.resetHandlers();
  });
  afterAll(async () => {
    await network.disable();
  });

  it("404s GET /v1/reflections/latest before any reflection exists", async () => {
    const res = await call("GET", "/v1/reflections/latest", undefined, bearer(env, "ADMIN"));
    expect(res.status).toBe(404);
  });

  it("week run stores the reflection, sources and audit; out-of-window facts stay out", async () => {
    const fOld = await seedFact({ subjectName: "reflect old subject", predicate: "uses", object: "ancient reflection object", now: NB - 400 * DAY });
    const f1 = await seedFact({ subjectName: "reflect subject one", predicate: "uses", object: "reflection tuesday", now: NB - DAY });
    const f2 = await seedFact({ subjectName: "reflect subject two", predicate: "uses", object: "reflection wednesday", now: NB - 2 * DAY });
    await seedEvent(NB - DAY, "reflection event alpha");
    handleGen({
      insights: [
        { text: "insight one", fact_ids: [f1] },
        { text: "insight two", fact_ids: [f1, f2] },
      ],
    });

    const run = await runReflection(env, { period: "week", now: NB });

    expect(run).toMatchObject({ skipped: false, degraded: false, period: "week", period_start: NB - 7 * DAY, period_end: NB });
    expect(run.insights).toHaveLength(2);
    expect(genCalls).toBe(1);
    expect(lastGenBody).toContain(f1);
    expect(lastGenBody).toContain("reflection tuesday");
    expect(lastGenBody).toContain("reflection event alpha");
    expect(lastGenBody).not.toContain(fOld);
    expect(lastGenBody).not.toContain("ancient reflection object");

    const row = await env.BRAIN_DB.prepare(`SELECT period, period_start, period_end, text FROM reflections WHERE id = ?1`)
      .bind(run.id)
      .first<{ period: string; period_start: number; period_end: number; text: string }>();
    expect(row).toMatchObject({ period: "week", period_start: NB - 7 * DAY, period_end: NB });
    expect(JSON.parse(String(row?.text))).toHaveLength(2);

    const srcs = await env.BRAIN_DB.prepare(`SELECT fact_id FROM reflection_sources WHERE reflection_id = ?1 ORDER BY fact_id`)
      .bind(run.id)
      .all<{ fact_id: string }>();
    expect(srcs.results.map((r) => r.fact_id).sort()).toEqual([f1, f2].sort());

    const audit = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'reflect' AND target_id = ?1`)
      .bind(run.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("never serializes restricted material and drops invalid ids /empty insights", async () => {
    const restricted = await seedFact({
      subjectName: "reflect restricted subject",
      predicate: "works_on",
      object: "classified reflection text",
      now: NB - DAY,
      sensitivity: "restricted",
    });
    const normal = await seedFact({ subjectName: "reflect normal subject", predicate: "works_on", object: "normal reflection object", now: NB - DAY });
    handleGen({
      insights: [
        { text: "ok", fact_ids: [normal, restricted, "bogus-id"] },
        { text: "no valid ids", fact_ids: ["bogus-id"] },
        { text: "   ", fact_ids: [normal] },
      ],
    });

    const run = await runReflection(env, { period: "week", now: NB });

    expect(lastGenBody).not.toContain("classified reflection text");
    expect(lastGenBody).not.toContain(restricted);
    expect(run.insights).toEqual([{ text: "ok", fact_ids: [normal] }]);
    expect(run.degraded).toBe(false);
  });

  it("skips empty windows without a model call and stores nothing", async () => {
    const before = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM reflections`).first<{ n: number }>();
    const calls = genCalls;

    const run = await runReflection(env, { period: "week", now: NB - 450 * DAY });

    expect(run).toMatchObject({ skipped: true, degraded: false, insights: [], id: null });
    expect(genCalls).toBe(calls);
    const after = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM reflections`).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("degrades to an empty stored reflection when the model output survives nothing", async () => {
    await seedFact({ subjectName: "reflect degrade subject", predicate: "uses", object: "degrade reflection object", now: NB - DAY });
    handleGen({ insights: [{ text: "no ids", fact_ids: ["bogus-id"] }] });

    const run = await runReflection(env, { period: "week", now: NB });

    expect(run).toMatchObject({ skipped: false, degraded: true, insights: [] });
    const row = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM reflections WHERE id = ?1`)
      .bind(run.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(1); // auditable even when degraded
  });

  it("serves the newest reflection via GET /v1/reflections/latest with its fact ids", async () => {
    const fNew = await seedFact({
      subjectName: "reflect latest subject",
      predicate: "uses",
      object: "latest reflection object",
      now: NB - 1000,
    });
    handleGen({ insights: [{ text: "latest insight", fact_ids: [fNew] }] });
    const run = await runReflection(env, { period: "week", now: NB + 10_000 }); // strictly newest created_at

    const res = await call("GET", "/v1/reflections/latest", undefined, bearer(env, "MCP_READ"));
    expect(res.status).toBe(200);
    const body = await res.json<{
      reflection: { id: string; period: string; insights: Array<{ text: string; fact_ids: string[] }> };
      fact_ids: string[];
    }>();
    expect(body.reflection.id).toBe(run.id);
    expect(body.reflection.insights).toEqual([{ text: "latest insight", fact_ids: [fNew] }]);
    expect(body.fact_ids).toEqual([fNew]);
  });

  it("POST /v1/reflect is admin-only, validates the period and runs the month window", async () => {
    const ok = await call("POST", "/v1/reflect", { period: "month" }, bearer(env, "ADMIN"));
    expect(ok.status).toBe(200);
    const body = await ok.json<{ period: string; period_start: number; period_end: number }>();
    expect(body.period).toBe("month");
    expect(body.period_end - body.period_start).toBe(30 * DAY);

    const bad = await call("POST", "/v1/reflect", { period: "decade" }, bearer(env, "ADMIN"));
    expect(bad.status).toBe(400);
    const denied = await call("POST", "/v1/reflect", { period: "week" }, bearer(env, "MCP_READ"));
    expect(denied.status).toBe(403);
  });
});
