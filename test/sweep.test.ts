import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dayKey } from "../src/budget";
import { healthReport } from "../src/health";
import worker from "../src/index";
import { runSweep } from "../src/sweep";
import { bearer, call, fakeVec, installFakeVectorize } from "./helpers";
import { network } from "./server";

const GEN_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-3.5-flash-lite:generateContent";
const EMB_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-embedding-001:batchEmbedContents";

const reply = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 7 },
});

const insertToken = (token: string, expires: number, used?: number) =>
  env.BRAIN_DB.prepare(`INSERT INTO confirm_tokens (token, target, created_at, expires_at, used_at) VALUES (?1, 'event:x', 0, ?2, ?3)`)
    .bind(token, expires, used ?? null).run();

const insertProposal = (id: string, status: string, created: number, expires: number) =>
  env.BRAIN_DB.prepare(
    `INSERT INTO proposals (id, kind, payload_json, sensitivity, review_mode, status, created_at, expires_at)
     VALUES (?1, 'forget', '{}', 'normal', 'manual', ?2, ?3, ?4)`,
  )
    .bind(id, status, created, expires)
    .run();

const seedEvents = async (n: number, tag: string) => {
  const stmts = Array.from({ length: n }, (_, i) =>
    env.BRAIN_DB.prepare(
      `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
       VALUES (?1, ?2, ?2, 'manual', 'user', 1.0, ?3, 'note', 'normal', ?4, ?5)`,
    ).bind(`evt-${tag}-${String(i).padStart(3, "0")}`, 1_700_000_000_000 + i, tag, `seed ${tag} ${i}`, `hmac-${tag}-${i}`),
  );
  await env.BRAIN_DB.batch(stmts);
};

describe("sweep", () => {
  beforeAll(async () => {
    await network.enable();
  });
  beforeEach(() => {
    installFakeVectorize();
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

  it("prunes only expired confirm tokens", async () => {
    const now = Date.now();
    await insertToken("exp-1", now - 1_000);
    await insertToken("exp-used", now - 1_000, now - 500);
    await insertToken("valid-1", now + 60_000);
    const result = await runSweep(env, now);
    expect(result.pruned_tokens).toBe(2);
    const { results } = await env.BRAIN_DB.prepare(`SELECT token FROM confirm_tokens ORDER BY token`).all<{ token: string }>();
    expect(results.map((r) => r.token)).toEqual(["valid-1"]);
  });

  it("reports warn and breaker from the global budget", async () => {
    await env.BRAIN_DB.prepare(`INSERT INTO rate_budgets (scope, day, rows_written) VALUES ('__global__', ?1, 70000)`).bind(dayKey(Date.now())).run();
    expect(await runSweep(env)).toMatchObject({ warn: true, breaker: false });
    await env.BRAIN_DB.prepare(`UPDATE rate_budgets SET rows_written = 80000 WHERE scope = '__global__'`).run();
    expect(await runSweep(env)).toMatchObject({ warn: true, breaker: true });
  });

  it("runs from the scheduled handler", async () => {
    const ctrl = createScheduledController({ scheduledTime: new Date(1000), cron: "*/30 * * * *" });
    const ctx = createExecutionContext();
    await worker.scheduled(ctrl, env, ctx);
    await waitOnExecutionContext(ctx);
  });

  it("expires proposals exactly at the boundary", async () => {
    const now = Date.now() + 10 * 86_400_000; // far grid: only these two rows cross it
    await insertProposal("prop-boundary-old", "pending", now - 1000, now); // expires_at === now → expires
    await insertProposal("prop-boundary-fresh", "pending", now - 1000, now + 1); // still pending

    const res = await runSweep(env, now);
    expect(res.expired_proposals).toBe(1);

    const { results } = await env.BRAIN_DB.prepare(
      `SELECT id, status FROM proposals WHERE id LIKE 'prop-boundary-%' ORDER BY id`,
    ).all<{ id: string; status: string }>();
    expect(results).toEqual([
      { id: "prop-boundary-fresh", status: "pending" },
      { id: "prop-boundary-old", status: "expired" },
    ]);
  });

  it("performs extraction during the sweep and reports it", async () => {
    await seedEvents(2, "sweepx");
    network.use(
      http.post(GEN_URL, async ({ request }) => {
        const body = (await request.json()) as { contents: Array<{ parts: Array<{ text: string }> }> };
        const lines = JSON.parse(body.contents[0].parts[0].text) as Array<{ event_id: string; excerpt: string }>;
        const out = lines.map((l) => ({
          subject: "sweep subject",
          predicate: "uses",
          object: `extracted ${l.excerpt}`,
          fact_kind: "user_stated",
          confidence: 0.9,
          event_id: l.event_id,
        }));
        return HttpResponse.json(reply(JSON.stringify(out)));
      }),
    );

    const res = await runSweep(env);
    expect(res.extracted.processed).toBe(2);
    expect(res.extracted.facts).toBe(2);
    expect(res.extracted.calls).toBe(1);
    expect(res.extracted.embedded).toBe(2);

    const { results } = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM facts`).all<{ n: number }>();
    expect(results[0].n).toBe(2);
  });

  it("health report adds extraction status counts", async () => {
    const base = (
      await env.BRAIN_DB.prepare(`SELECT status, count(*) AS n FROM extractions GROUP BY status`).all<{ status: string; n: number }>()
    ).results;
    const baseOf = (s: string) => base.find((r) => r.status === s)?.n ?? 0;

    await seedEvents(3, "healthx");
    await env.BRAIN_DB.prepare(
      `INSERT INTO extractions (event_id, status, created_at, updated_at)
       VALUES ('evt-healthx-000', 'running', 1, 1), ('evt-healthx-001', 'failed', 1, 1), ('evt-healthx-002', 'pending', 1, 1)`,
    ).run();

    const report = await healthReport(env);
    expect(report.extractions).toEqual({
      pending: baseOf("pending") + 1,
      running: baseOf("running") + 1,
      failed: baseOf("failed") + 1,
      done: baseOf("done"),
    });
    expect(report).toMatchObject({
      events: expect.any(Number),
      purges: 0,
      pending_proposals: expect.any(Number),
      budget: expect.any(Object),
    });
  });

  it("POST /v1/extract is admin-only and clamps to the manual caps", async () => {
    expect((await call("POST", "/v1/extract", {}, bearer(env, "MCP_READ"))).status).toBe(403);
    expect((await call("POST", "/v1/extract", {}, bearer(env, "MCP_PROPOSE"))).status).toBe(403);

    await seedEvents(105, "kickx");
    network.use(http.post(GEN_URL, () => HttpResponse.json(reply("[]"))));

    const res = await call("POST", "/v1/extract", { max_events: 1000, max_calls: 1000 }, bearer(env, "ADMIN"));
    expect(res.status).toBe(200);
    const body = await res.json<{ processed: number; calls: number }>();
    expect(body.processed).toBe(100); // clamped from 1000 to the manual cap
    expect(body.calls).toBe(10);
  });
});
