import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { healthReport } from "../src/health";
import { bearer, call, installFakeVectorize, seedFact, setEnvVars } from "./helpers";

describe("health report (phase 4 fields)", () => {
  beforeEach(() => {
    installFakeVectorize();
  });

  it("reports no consolidation run and zero reflections on a fresh brain", async () => {
    const report = await healthReport(env);
    expect(report.consolidation).toEqual({ last_run: null });
    expect(report.reflections).toBe(0);
  });

  it("surfaces the newest consolidation run and the reflection count", async () => {
    await env.BRAIN_DB.prepare(
      `INSERT INTO consolidation_runs (id, started_at, finished_at, new_facts, merged, superseded, conflicts, pruned, report)
       VALUES ('run-old', 10, 11, 0, 0, 0, 0, 0, '{}')`,
    ).run();
    await env.BRAIN_DB.prepare(
      `INSERT INTO consolidation_runs (id, started_at, finished_at, new_facts, merged, superseded, conflicts, pruned, report)
       VALUES ('run-new', 20, 21, 0, 3, 1, 2, 4, '{}')`,
    ).run();
    await env.BRAIN_DB.prepare(
      `INSERT INTO reflections (id, period, period_start, period_end, text, created_at) VALUES ('refl-a', 'week', 1, 2, '[]', 5)`,
    ).run();

    const report = await healthReport(env);

    expect(report.reflections).toBe(1);
    expect(report.consolidation.last_run).toMatchObject({
      id: "run-new",
      merged: 3,
      superseded: 1,
      conflicts: 2,
      pruned: 4,
    });
  });

  it("serves the fields through GET /v1/health-report", async () => {
    const res = await call("GET", "/v1/health-report", undefined, bearer(env, "MCP_READ"));
    expect(res.status).toBe(200);
    const body = await res.json<{ consolidation: { last_run: { id: string } | null }; reflections: number }>();
    expect(body.consolidation.last_run?.id).toBe("run-new");
    expect(body.reflections).toBe(1);
  });

  it("reports the AI wiring (native defaults)", async () => {
    const report = await healthReport(env);
    expect(report.ai.chat).toEqual({
      mode: "native",
      model: "gemini-3.5-flash-lite",
      fallback_model: "gemini-3.1-flash-lite",
    });
    expect(report.ai.embed).toEqual({
      mode: "native",
      model: "gemini-embedding-001",
      dims: 768,
      signature: "gemini-embedding-001@768",
      index_dims: 768,
      matches_index: true,
    });
    expect(report.ai.reembed_backlog).toBe(0);
  });

  it("counts the re-embed backlog", async () => {
    await seedFact({ name: "backlog", predicate: "waits", object: "for a vector" });
    const report = await healthReport(env);
    expect(report.ai.reembed_backlog).toBeGreaterThanOrEqual(1);
  });

  it("counts pre-signature rows in the backlog once dims differ from the default", async () => {
    const factId = await seedFact({ name: "legacy backlog", predicate: "waits", object: "old vector" });
    await env.BRAIN_DB.prepare(
      `UPDATE facts SET vec_id = id, embedding_model = 'gemini-embedding-001' WHERE id = ?1`,
    )
      .bind(factId)
      .run();
    // normalize every other fact so the count is exactly ours
    await env.BRAIN_DB.prepare(
      `UPDATE facts SET vec_id = COALESCE(vec_id, id), embedding_model = 'gemini-embedding-001@1536' WHERE id != ?1`,
    )
      .bind(factId)
      .run();
    setEnvVars({ AI_EMBED_DIMS: "1536" });
    try {
      const report = await healthReport(env);
      expect(report.ai.reembed_backlog).toBe(1);
    } finally {
      setEnvVars({ AI_EMBED_DIMS: undefined });
    }
  });

  it("keeps the route up when AI config is broken", async () => {
    setEnvVars({ AI_BASE_URL: "https://oai.test/v1" }); // no AI_MODEL -> chat config error
    try {
      const res = await call("GET", "/v1/health-report", undefined, bearer(env, "MCP_READ"));
      expect(res.status).toBe(200);
      const body = await res.json<{ ai: { chat: { error?: string; mode?: string } } }>();
      expect(body.ai.chat.error).toMatch(/AI_MODEL/);
    } finally {
      setEnvVars({ AI_BASE_URL: undefined });
    }
  });
});
