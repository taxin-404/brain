import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const seedEvent = async (id: string, excerpt = "hello world") =>
  env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, kind, excerpt, content_hmac)
     VALUES (?1, 1, 1, 'manual', 'user', 1.0, 'note', ?2, 'hmac-' || ?1)`,
  )
    .bind(id, excerpt)
    .run();

describe("schema", () => {
  it("tables exist", async () => {
    const { results } = await env.BRAIN_DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of ["events", "event_keys", "facts", "entities", "proposals", "confirm_tokens", "rate_budgets", "audit_log", "events_fts", "extractions"])
      expect(names).toContain(t);
  });

  it("extractions queue has the exact columns and status index", async () => {
    const { results } = await env.BRAIN_DB.prepare(`PRAGMA table_info(extractions)`).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "event_id",
      "status",
      "attempts",
      "model",
      "error",
      "facts_created",
      "tokens_in",
      "tokens_out",
      "injection_suspected",
      "created_at",
      "updated_at",
    ]);
    const idx = await env.BRAIN_DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_extractions_status'`,
    ).first<{ name: string }>();
    expect(idx?.name).toBe("idx_extractions_status");
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
