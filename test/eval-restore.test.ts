import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { decryptPayload } from "../src/crypto";
import { ingestEvents } from "../src/ingest";
import { bearer, call } from "./helpers";

/** Phase-6 done-when eval (design §8): "a `backup` export restores a working
 *  brain on a fresh account using only the escrowed KEK."
 *
 *  The test performs the real sequence: build a small brain → backup export →
 *  **wipe to a fresh account** (drop every table, re-apply migrations, clear
 *  R2 payload objects) → restore through the admin route → verify the brain
 *  works through its read surfaces and that the raw payload decrypts with
 *  `PAYLOAD_KEK` alone. */

/** Fresh account = a new deployment: schema from migrations, zero rows.
 *  Drops run child-before-parent (D1 enforces FKs even on DROP's implicit
 *  delete) with `defer_foreign_keys` as a second safety net. */
const DROP_ORDER = [
  "events_fts",
  "facts_fts",
  "fact_sources",
  "reflection_sources",
  "entity_aliases",
  "extractions",
  "event_keys",
  "proposals",
  "edges",
  "facts",
  "procedure_versions",
  "procedures",
  "reflections",
  "blocks",
  "audit_log",
  "consolidation_runs",
  "confirm_tokens",
  "rate_budgets",
  "entities",
  "events",
];

const wipeToFreshAccount = async () => {
  const { results } = await env.BRAIN_DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%'`,
  ).all<{ name: string }>();
  const names = new Set(results.map((r) => r.name));
  // Ordered list first, then any leftovers (e.g. the migrations bookkeeping
  // table, whatever the test helper names it).
  const all = [...DROP_ORDER, ...names].filter((n, i, a) => names.has(n) && a.indexOf(n) === i);
  const stmts = [env.BRAIN_DB.prepare("PRAGMA defer_foreign_keys = true")];
  for (const name of all) stmts.push(env.BRAIN_DB.prepare(`DROP TABLE IF EXISTS "${name}"`));
  await env.BRAIN_DB.batch(stmts);
  await applyD1Migrations(env.BRAIN_DB, env.TEST_MIGRATIONS);
};

const seed = async (): Promise<string> => {
  const ingested = await ingestEvents(env, "ADMIN", [
    {
      source: "manual",
      actor: "user",
      kind: "note",
      excerpt: "restore evidence one",
      payload: { text: "the brain likes restore tests" },
    },
  ]);
  const eventId = ingested.results[0].id;

  await env.BRAIN_DB.batch([
    env.BRAIN_DB.prepare(
      `INSERT INTO entities (id, type, name, norm_name, summary, first_seen_at, last_seen_at)
       VALUES ('ent-restore', 'Project', 'Brain', 'brain', 'the memory worker', 1, 2)`,
    ),
    env.BRAIN_DB.prepare(
      `INSERT INTO facts (id, subject_id, predicate, object_text, fact_kind, confidence, status, learned_at, sensitivity, source_event_id, embedding_model)
       VALUES ('fact-restore', 'ent-restore', 'works_on', 'procedural memory', 'user_stated', 0.9, 'active', 1, 'normal', ?1, 'gemini-embedding-001')`,
    ).bind(eventId),
    env.BRAIN_DB.prepare(`INSERT INTO fact_sources (fact_id, event_id) VALUES ('fact-restore', ?1)`).bind(eventId),
    env.BRAIN_DB.prepare(
      `INSERT INTO procedures (id, name, current_version, status, origin_trust, created_at)
       VALUES ('proc-restore', 'Restore drill', 1, 'approved', 1, 1)`,
    ),
    env.BRAIN_DB.prepare(
      `INSERT INTO procedure_versions (id, procedure_id, version, steps, created_at)
       VALUES ('proc-restore-v1', 'proc-restore', 1, '["export","wipe","restore"]', 1)`,
    ),
    env.BRAIN_DB.prepare(
      `INSERT INTO reflections (id, period, period_start, period_end, text, created_at)
       VALUES ('refl-restore', 'week', 1, 2, '${JSON.stringify([{ text: "restore drills work", fact_ids: ["fact-restore"] }])}', 3)`,
    ),
    env.BRAIN_DB.prepare(
      `INSERT INTO reflection_sources (reflection_id, fact_id, event_id) VALUES ('refl-restore', 'fact-restore', ?1)`,
    ).bind(eventId),
    env.BRAIN_DB.prepare(
      `INSERT INTO blocks (key, value, updated_at) VALUES ('objective', 'survive a clean-account restore', 4)`,
    ),
  ]);
  return eventId;
};

describe("eval: clean-account restore (done-when)", () => {
  it("a backup export restores a working brain on a fresh account using only the KEK", async () => {
    const eventId = await seed();

    // 1. Backup export.
    const exp = await call("GET", "/v1/export?profile=backup", undefined, bearer(env, "ADMIN"));
    expect(exp.status).toBe(200);
    const { job } = await exp.json<{ job: string }>();

    // 2. Fresh account: schema only, no rows, no R2 payload objects.
    await wipeToFreshAccount();
    for (const o of (await env.BRAIN_RAW.list({ prefix: "payloads/" })).objects) {
      await env.BRAIN_RAW.delete(o.key);
    }
    expect((await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM facts`).first<{ n: number }>())?.n).toBe(0);
    expect((await env.BRAIN_RAW.list({ prefix: "payloads/" })).objects.length).toBe(0);

    // 3. Restore.
    const res = await call("POST", "/v1/restore", { job }, bearer(env, "ADMIN"));
    expect(res.status).toBe(200);
    const body = await res.json<{ restored: Record<string, number>; r2_payloads: number; fts_rows: number }>();
    expect(body.restored.facts).toBe(1);
    expect(body.restored.events).toBe(1);
    expect(body.restored.procedures).toBe(1);
    expect(body.restored.reflections).toBe(1);
    expect(body.r2_payloads).toBe(1);
    expect(body.fts_rows).toBeGreaterThan(0);

    // 4. Working brain, through the real read surfaces.
    const search = await call("GET", "/v1/search?q=procedural", undefined, bearer(env, "MCP_READ"));
    expect(search.status).toBe(200);
    expect(JSON.stringify(await search.json())).toContain("fact-restore");

    const fact = await call("GET", "/v1/facts/fact-restore", undefined, bearer(env, "MCP_READ"));
    expect(fact.status).toBe(200);

    const why = await call("GET", "/v1/why/fact-restore", undefined, bearer(env, "MCP_READ"));
    expect(why.status).toBe(200);
    expect(JSON.stringify(await why.json())).toContain(eventId);

    const proc = await call("GET", "/v1/procedures/proc-restore", undefined, bearer(env, "MCP_READ"));
    const procBody = await proc.json<{ procedure: { status: string }; versions: unknown[] }>();
    expect(procBody.procedure.status).toBe("approved");
    expect(procBody.versions.length).toBe(1);

    const blocks = await call("GET", "/v1/blocks", undefined, bearer(env, "MCP_READ"));
    expect(JSON.stringify(await blocks.json())).toContain("survive a clean-account restore");

    const refl = await call("GET", "/v1/reflections/latest", undefined, bearer(env, "MCP_READ"));
    expect(JSON.stringify(await refl.json())).toContain("restore drills work");

    // 5. The raw payload decrypts with the KEK alone (wrapped key from D1,
    //    ciphertext from R2 — nothing else in play).
    const keyRow = await env.BRAIN_DB.prepare(`SELECT wrapped_key FROM event_keys WHERE event_id = ?1`)
      .bind(eventId)
      .first<{ wrapped_key: string }>();
    const blob = await (await env.BRAIN_RAW.get(`payloads/${eventId}`))!.arrayBuffer();
    const plaintext = await decryptPayload(env.PAYLOAD_KEK, keyRow!.wrapped_key, blob);
    expect(plaintext).toContain("restore tests");

    // 6. Idempotent: a second restore adds nothing.
    const again = await call("POST", "/v1/restore", { job }, bearer(env, "ADMIN"));
    expect(again.status).toBe(200);
    expect((await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM facts`).first<{ n: number }>())?.n).toBe(1);
    expect((await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM procedures`).first<{ n: number }>())?.n).toBe(1);
  });

  it("refuses unknown jobs, portable exports, and non-admin callers", async () => {
    expect((await call("POST", "/v1/restore", { job: "nope" }, bearer(env, "ADMIN"))).status).toBe(404);
    expect((await call("POST", "/v1/restore", {}, bearer(env, "ADMIN"))).status).toBe(400);
    expect((await call("POST", "/v1/restore", { job: "nope" }, bearer(env, "MCP_READ"))).status).toBe(403);

    const mint = await call("POST", "/v1/confirm/token", { target: "export:portable" }, bearer(env, "ADMIN"));
    const { token } = await mint.json<{ token: string }>();
    const portable = await call(
      "GET",
      `/v1/export?profile=portable&confirm_token=${token}`,
      undefined,
      bearer(env, "ADMIN"),
    );
    const { job } = await portable.json<{ job: string }>();
    const res = await call("POST", "/v1/restore", { job }, bearer(env, "ADMIN"));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("bad_request");
  });
});

describe("eval: sliced restore (free-plan subrequest ceiling)", () => {
  it("restores payloads in bounded slices and audits exactly once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const ingested = await ingestEvents(env, "ADMIN", [
        { source: "manual", actor: "user", kind: "note", excerpt: `slice ${i}`, payload: { i } },
      ]);
      ids.push(ingested.results[0].id);
    }

    const exp = await call("GET", "/v1/export?profile=backup", undefined, bearer(env, "ADMIN"));
    const { job } = await exp.json<{ job: string }>();

    // One payload file contains 4 objects by now (1 seeded earlier + 3 here);
    // limit=2 forces two calls.
    const first = await call("POST", "/v1/restore", { job, limit: 2 }, bearer(env, "ADMIN"));
    expect(first.status).toBe(200);
    const b1 = await first.json<{ done: boolean; r2_payloads: number; fts_rows: number | null }>();
    expect(b1.done).toBe(false);
    expect(b1.r2_payloads).toBe(2);
    expect(b1.fts_rows).toBeNull();

    const second = await call("POST", "/v1/restore", { job, limit: 2 }, bearer(env, "ADMIN"));
    const b2 = await second.json<{ done: boolean; r2_payloads: number; fts_rows: number }>();
    expect(b2.done).toBe(true);
    expect(b2.r2_payloads).toBe(2);
    expect(b2.fts_rows).toBeGreaterThan(0);

    // Every original payload object exists in R2 again.
    for (const id of ids) {
      expect(await env.BRAIN_RAW.get(`payloads/${id}`)).toBeTruthy();
    }

    // Audit exactly once, on the completing call.
    const audit = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'restore' AND target_id = ?1`,
    )
      .bind(job)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);

    // Completed restore calls are cached no-ops.
    const third = await call("POST", "/v1/restore", { job, limit: 2 }, bearer(env, "ADMIN"));
    const b3 = await third.json<{ done: boolean; cached: boolean }>();
    expect(b3.done).toBe(true);
    expect(b3.cached).toBe(true);
  });
});
