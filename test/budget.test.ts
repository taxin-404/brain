import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { charge, dayKey, readBudget } from "../src/budget";

// @cloudflare/vitest-plugin 1.4.2: storage is fresh per test FILE but SHARED
// across tests within the file (no per-test isolation — verified empirically).
// Each test pins its own day key so its rows can never collide with another's.

const T1 = Date.UTC(2031, 0, 1);
const T2 = Date.UTC(2031, 0, 2);
const T3 = Date.UTC(2031, 0, 3);
const T4 = Date.UTC(2031, 0, 4);
const T5 = Date.UTC(2031, 0, 5);

const seed = async (scope: string, rows: number, now: number) =>
  env.BRAIN_DB.prepare(`INSERT INTO rate_budgets (scope, day, rows_written) VALUES (?1, ?2, ?3)`)
    .bind(scope, dayKey(now), rows)
    .run();

describe("budgets", () => {
  it("charges ok below caps and counts both rows", async () => {
    expect(await charge(env.BRAIN_DB, "MCP_PROPOSE", 5, T1)).toBe("ok");
    const { results } = await env.BRAIN_DB.prepare(
      `SELECT scope, rows_written FROM rate_budgets WHERE day = ?1 ORDER BY scope`,
    )
      .bind(dayKey(T1))
      .all();
    expect(results).toEqual([
      { scope: "MCP_PROPOSE", rows_written: 5 },
      { scope: "__global__", rows_written: 5 },
    ]);
  });

  it("429s past the propose cap without writing", async () => {
    await seed("MCP_PROPOSE", 10_000, T2);
    expect(await charge(env.BRAIN_DB, "MCP_PROPOSE", 1, T2)).toBe("over_limit");
    expect((await readBudget(env.BRAIN_DB, T2)).used).toBe(0); // global untouched by seed above
  });

  it("opens the breaker for non-admin writes past 80,000", async () => {
    await seed("__global__", 79_995, T3);
    expect(await charge(env.BRAIN_DB, "MCP_PROPOSE", 10, T3)).toBe("breaker_open");
    expect((await readBudget(env.BRAIN_DB, T3)).used).toBe(79_995);
  });

  it("never blocks ADMIN, even past cap and breaker", async () => {
    await seed("ADMIN", 10_000, T4);
    await seed("__global__", 90_000, T4);
    expect(await charge(env.BRAIN_DB, "ADMIN", 1, T4)).toBe("ok");
    expect((await readBudget(env.BRAIN_DB, T4)).used).toBe(90_001);
  });

  it("flags warn at 70,000 and breaker at 80,000", async () => {
    expect(await readBudget(env.BRAIN_DB, T5)).toMatchObject({ warn: false, breaker: false });
    await seed("__global__", 70_000, T5);
    expect(await readBudget(env.BRAIN_DB, T5)).toMatchObject({ used: 70_000, warn: true, breaker: false });
    await env.BRAIN_DB.prepare(`UPDATE rate_budgets SET rows_written = 80000 WHERE scope = '__global__' AND day = ?1`)
      .bind(dayKey(T5))
      .run();
    expect(await readBudget(env.BRAIN_DB, T5)).toMatchObject({ used: 80_000, warn: true, breaker: true });
  });
});
