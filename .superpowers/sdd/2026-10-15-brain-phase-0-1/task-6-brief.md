### Task 6: Write budgets + breaker

**Files:**
- Modify: `src/budget.ts`
- Create: `test/budget.test.ts`

**Interfaces:**
- Produces: `charge(db: D1Database, scope: Scope, rows: number, now?: number): Promise<"ok" | "over_limit" | "breaker_open">`. Rules (pinned): for non-ADMIN scopes, reject with `"over_limit"` when `scope_row + rows > PROPOSE_CAP` (checked first), then `"breaker_open"` when `global_row + rows > BREAKER_AT`; a rejected charge writes nothing. ADMIN skips both checks, always `"ok"`. On success, upserts both the scope row and the `__global__` row (`ON CONFLICT(scope, day) DO UPDATE SET rows_written = rows_written + excluded.rows_written`). Checks are read-then-write (best-effort under concurrency — documented, accepted for a single-owner brain).

- [ ] **Step 1: Write the failing budget test** — `test/budget.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { charge, dayKey, readBudget } from "../src/budget";

const seed = async (scope: string, rows: number) =>
  env.BRAIN_DB.prepare(`INSERT INTO rate_budgets (scope, day, rows_written) VALUES (?1, ?2, ?3)`)
    .bind(scope, dayKey(Date.now()), rows).run();

describe("budgets", () => {
  it("charges ok below caps and counts both rows", async () => {
    expect(await charge(env.BRAIN_DB, "MCP_PROPOSE", 5)).toBe("ok");
    const { results } = await env.BRAIN_DB.prepare(`SELECT scope, rows_written FROM rate_budgets ORDER BY scope`).all();
    expect(results).toEqual([
      { scope: "__global__", rows_written: 5 },
      { scope: "MCP_PROPOSE", rows_written: 5 },
    ]);
  });

  it("429s past the propose cap without writing", async () => {
    await seed("MCP_PROPOSE", 10_000);
    expect(await charge(env.BRAIN_DB, "MCP_PROPOSE", 1)).toBe("over_limit");
    expect((await readBudget(env.BRAIN_DB)).used).toBe(0); // global untouched by seed above
  });

  it("opens the breaker for non-admin writes past 80,000", async () => {
    await seed("__global__", 79_995);
    expect(await charge(env.BRAIN_DB, "MCP_PROPOSE", 10)).toBe("breaker_open");
    expect((await readBudget(env.BRAIN_DB)).used).toBe(79_995);
  });

  it("never blocks ADMIN, even past cap and breaker", async () => {
    await seed("ADMIN", 10_000);
    await seed("__global__", 90_000);
    expect(await charge(env.BRAIN_DB, "ADMIN", 1)).toBe("ok");
    expect((await readBudget(env.BRAIN_DB)).used).toBe(90_001);
  });

  it("flags warn at 70,000 and breaker at 80,000", async () => {
    expect(await readBudget(env.BRAIN_DB)).toMatchObject({ warn: false, breaker: false });
    await seed("__global__", 70_000);
    expect(await readBudget(env.BRAIN_DB)).toMatchObject({ used: 70_000, warn: true, breaker: false });
    await env.BRAIN_DB.prepare(`UPDATE rate_budgets SET rows_written = 80000 WHERE scope = '__global__'`).run();
    expect(await readBudget(env.BRAIN_DB)).toMatchObject({ used: 80_000, warn: true, breaker: true });
  });
});
```

- [ ] **Step 2: Run it, verify it fails** → FAIL (`charge` missing).

- [ ] **Step 3: Implement `charge` in `src/budget.ts`**

- [ ] **Step 4: Run it, verify it passes** → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: write budget charging with cap and breaker, admin-exempt"
```

---

