import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { dayKey } from "../src/budget";
import { runSweep } from "../src/sweep";

const insertToken = (token: string, expires: number, used?: number) =>
  env.BRAIN_DB.prepare(`INSERT INTO confirm_tokens (token, target, created_at, expires_at, used_at) VALUES (?1, 'event:x', 0, ?2, ?3)`)
    .bind(token, expires, used ?? null).run();

describe("sweep", () => {
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
});
