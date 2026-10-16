import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { MIGRATIONS } from "../src/migrations.generated";
import { ensureSchema } from "../src/bootstrap";

/** The plugin's own embedded copy of migrations/ (vitest.config.ts binding) —
 *  the same splitter, read at test-start. */
const dirMigrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
/** A migration-free D1 binding (vitest-only) to exercise a genuine first boot. */
const freshDb = (env as unknown as { MIGRATION_DB: D1Database }).MIGRATION_DB;

const ALL_TABLES = [
  "events",
  "event_keys",
  "facts",
  "entities",
  "proposals",
  "confirm_tokens",
  "rate_budgets",
  "audit_log",
  "events_fts",
  "extractions",
];

describe("embedded migrations (src/migrations.generated.ts)", () => {
  it("stay in sync with migrations/ — on failure run: npm run migrations:embed", () => {
    expect(MIGRATIONS.map((m) => ({ name: m.name, queries: [...m.queries] }))).toEqual(
      dirMigrations.map((m) => ({ name: m.name, queries: [...m.queries] })),
    );
  });

  it("bootstrap applies every embedded migration to a virgin database", async () => {
    await ensureSchema(freshDb);

    const { results: tables } = await freshDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all<{ name: string }>();
    const names = tables.map((t) => t.name);
    for (const table of ALL_TABLES) expect(names).toContain(table);

    const { results: applied } = await freshDb
      .prepare(`SELECT name FROM d1_migrations ORDER BY id`)
      .all<{ name: string }>();
    expect(applied.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
  });

  it("bootstrap is idempotent and interoperates with the vitest plugin", async () => {
    await ensureSchema(freshDb); // memoized second call — must resolve, not re-apply
    const { applyD1Migrations } = await import("cloudflare:test");
    await expect(applyD1Migrations(freshDb, dirMigrations)).resolves.toBeUndefined();
    const row = await freshDb.prepare(`SELECT count(*) AS n FROM d1_migrations`).first<{ n: number }>();
    expect(row?.n).toBe(MIGRATIONS.length);
  });

  it("the main test database was bootstrapped with the standard bookkeeping", async () => {
    const { results } = await env.BRAIN_DB.prepare(`SELECT name FROM d1_migrations ORDER BY id`).all<{
      name: string;
    }>();
    expect(results.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
  });
});
