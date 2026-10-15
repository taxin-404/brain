### Task 2: Full D1 schema (migrations) + immutability tests

**Files:**
- Create: `migrations/0001_events.sql` … `migrations/0005_audit.sql`, `test/apply-migrations.ts`, `test/schema.test.ts`
- Modify: `vitest.config.ts` (read migrations + setup file)

**Interfaces:**
- Produces: every table/index/trigger from spec §4 exists after migrations; test setup applies them per test file. Split: 0001 = `events` (+ both triggers + 3 indexes), `event_keys`, `events_fts` (+ insert trigger); 0002 = `entities`, `entity_aliases`, `edges`, `facts`, `fact_sources`, `facts_fts`, `procedures`, `procedure_versions`; 0003 = `reflections`, `reflection_sources`, `blocks`; 0004 = `proposals`, `confirm_tokens`, `rate_budgets`; 0005 = `audit_log`, `consolidation_runs`.
- Note: copy the SQL from spec §4 verbatim. Only reorder within 0002 so `entities`/`entity_aliases`/`edges` precede `facts` (FK target must exist before use in some SQLite builds).

- [ ] **Step 1: Write the failing schema test** — `test/schema.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const seedEvent = async (id: string, excerpt = "hello world") =>
  env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, kind, excerpt, content_hmac)
     VALUES (?1, 1, 1, 'manual', 'user', 1.0, 'note', ?2, 'hmac-' || ?1)`,
  ).bind(id, excerpt).run();

describe("schema", () => {
  it("tables exist", async () => {
    const { results } = await env.BRAIN_DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of ["events", "event_keys", "facts", "entities", "proposals", "confirm_tokens", "rate_budgets", "audit_log", "events_fts"])
      expect(names).toContain(t);
  });

  it("events is append-only except the whitelisted purge transition", async () => {
    await seedEvent("e1");
    await expect(
      env.BRAIN_DB.prepare(`UPDATE events SET importance = 0.9 WHERE id = 'e1'`).run(),
    ).rejects.toThrow("events is append-only");
    await expect(env.BRAIN_DB.prepare(`DELETE FROM events WHERE id = 'e1'`).run()).rejects.toThrow("events is append-only");
    await env.BRAIN_DB.prepare(`UPDATE events SET redacted = 1, excerpt = NULL WHERE id = 'e1'`).run(); // whitelisted
    const row = await env.BRAIN_DB.prepare(`SELECT redacted, excerpt FROM events WHERE id = 'e1'`).first<{ redacted: number; excerpt: string | null }>();
    expect(row).toEqual({ redacted: 1, excerpt: null });
  });

  it("FTS insert trigger feeds events_fts from redacted excerpts", async () => {
    await seedEvent("e2", "kubernetes cluster upgrade");
    const row = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH '"kubernetes"'`,
    ).first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  it("entities are unique per (type, norm_name)", async () => {
    await env.BRAIN_DB.prepare(`INSERT INTO entities (id, type, name, norm_name) VALUES ('x1','Tool','Foo','foo')`).run();
    await expect(
      env.BRAIN_DB.prepare(`INSERT INTO entities (id, type, name, norm_name) VALUES ('x2','Tool','Foo','foo')`).run(),
    ).rejects.toThrow();
  });

  it("migration replay is clean", async () => {
    const { applyD1Migrations } = await import("cloudflare:test");
    const { env: e } = await import("cloudflare:workers");
    await expect(applyD1Migrations(e.BRAIN_DB, (e as unknown as { TEST_MIGRATIONS: never[] }).TEST_MIGRATIONS)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run test/schema.test.ts` → FAIL (`no such table: events`).

- [ ] **Step 3: Add migrations + test config**

Write the five migration files from spec §4. Modify `vitest.config.ts`:

```ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            PAYLOAD_KEK: "dev-kek",
            CONTENT_HMAC_KEY: "dev-hmac",
            MCP_READ_TOKEN: "dev-read",
            MCP_PROPOSE_TOKEN: "dev-propose",
            ADMIN_TOKEN: "dev-admin",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
```

`test/apply-migrations.ts`:

```ts
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";

await applyD1Migrations(env.BRAIN_DB, env.TEST_MIGRATIONS);
```

Extend the `ProvidedEnv` augmentation in `test/helpers.ts` with `TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[]`.

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run test/schema.test.ts` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: full D1 schema with append-only triggers and FTS5"
```


---

