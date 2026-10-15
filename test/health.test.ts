import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { healthReport } from "../src/health";
import { bearer, call, installFakeVectorize } from "./helpers";

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
});
