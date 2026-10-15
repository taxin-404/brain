import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { resolveObjectEntity, resolveSubject } from "../src/entities";
import { createFact } from "../src/factstore";
import { bearer, call } from "./helpers";

const seedUserEvent = async (): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'user', 1.0, NULL, 'note', 'normal', 'note for graph test', ?4)`,
  )
    .bind(id, 1_770_000_000_000 + Math.floor(Math.random() * 1_000_000), Date.now(), `hmac-${id}`)
    .run();
  return id;
};

const aliasNorms = async (entityId: string): Promise<string[]> => {
  const { results } = await env.BRAIN_DB.prepare(`SELECT norm_alias FROM entity_aliases WHERE entity_id = ?1`)
    .bind(entityId)
    .all<{ norm_alias: string }>();
  return results.map((r) => r.norm_alias);
};

describe("entity aliases", () => {
  it("learns SELF aliases for the Person 'user' entity", async () => {
    const user = await resolveSubject(env.BRAIN_DB, "taxin 404");
    expect(user.norm).toBe("user");
    await resolveSubject(env.BRAIN_DB, "Taxin404");
    const norms = await aliasNorms(user.id);
    expect(norms).toContain("taxin 404");
    expect(norms).toContain("taxin404");
  });

  it("resolves a mention through a stored alias", async () => {
    const project = await resolveSubject(env.BRAIN_DB, "Domus Core", "Project");
    await env.BRAIN_DB.prepare(
      `INSERT OR IGNORE INTO entity_aliases (entity_id, alias, norm_alias) VALUES (?1, 'domus', 'domus')`,
    )
      .bind(project.id)
      .run();
    const again = await resolveSubject(env.BRAIN_DB, "domus");
    expect(again.id).toBe(project.id);
    expect(again.created).toBe(false);
  });

  it("learns display variants and dedupes repeat mentions", async () => {
    const first = await resolveSubject(env.BRAIN_DB, "Graph API", "Project");
    const second = await resolveSubject(env.BRAIN_DB, "graph api");
    expect(second.id).toBe(first.id);
    await resolveSubject(env.BRAIN_DB, "graph api");
    const n = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM entity_aliases WHERE entity_id = ?1 AND norm_alias = 'graph api'`,
    )
      .bind(first.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe("resolveObjectEntity", () => {
  it("matches existing entities by norm and never creates", async () => {
    const tool = await resolveSubject(env.BRAIN_DB, "Keynote App", "Tool");
    const hit = await resolveObjectEntity(env.BRAIN_DB, "Keynote App");
    expect(hit?.id).toBe(tool.id);

    const before = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM entities`).first<{ n: number }>();
    const miss = await resolveObjectEntity(env.BRAIN_DB, "no such thing zeta");
    expect(miss).toBeNull();
    const after = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM entities`).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

describe("fact edges", () => {
  it("createFact links the object entity and writes an edge", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "Brain System", "Project");
    const object = await resolveSubject(env.BRAIN_DB, "Toolx", "Tool");
    const eventId = await seedUserEvent();
    const id = await createFact(env, {
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      objectText: "toolx",
      factKind: "observed",
      confidence: 0.5,
      sensitivity: "normal",
      sourceEventId: eventId,
    });

    const fact = await env.BRAIN_DB.prepare(`SELECT object_entity_id FROM facts WHERE id = ?1`)
      .bind(id)
      .first<{ object_entity_id: string | null }>();
    expect(fact?.object_entity_id).toBe(object.id);

    const edge = await env.BRAIN_DB.prepare(
      `SELECT src, dst, rel, confidence, invalid_at, source_event_id FROM edges WHERE src = ?1 AND dst = ?2 AND rel = 'uses'`,
    )
      .bind(subject.id, object.id)
      .first<Record<string, unknown>>();
    expect(edge).toMatchObject({
      src: subject.id,
      dst: object.id,
      rel: "uses",
      confidence: 0.5,
      invalid_at: null,
      source_event_id: eventId,
    });
  });

  it("leaves the link NULL and writes no edge when the object is not an entity", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "Lonely Subject", "Project");
    const eventId = await seedUserEvent();
    const id = await createFact(env, {
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      objectText: "entity-free object",
      factKind: "inferred",
      confidence: 0.5,
      sensitivity: "normal",
      sourceEventId: eventId,
    });
    const fact = await env.BRAIN_DB.prepare(`SELECT object_entity_id FROM facts WHERE id = ?1`)
      .bind(id)
      .first<{ object_entity_id: string | null }>();
    expect(fact?.object_entity_id).toBeNull();
    const n = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM edges WHERE src = ?1`).bind(subject.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("disputed facts do not generate edges", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "Disputed Subject", "Project");
    await resolveSubject(env.BRAIN_DB, "Tooly", "Tool");
    const eventId = await seedUserEvent();
    const id = await createFact(env, {
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      objectText: "tooly",
      factKind: "inferred",
      confidence: 0.5,
      status: "disputed",
      sensitivity: "normal",
      sourceEventId: eventId,
    });
    const fact = await env.BRAIN_DB.prepare(`SELECT object_entity_id, status FROM facts WHERE id = ?1`)
      .bind(id)
      .first<{ object_entity_id: string | null; status: string }>();
    expect(fact?.status).toBe("disputed");
    const n = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM edges WHERE src = ?1`).bind(subject.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("GET /v1/entities/:id", () => {
  it("returns entity, aliases, active facts and edges; hides restricted for read scope", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "Entity View Test", "Project");
    await resolveSubject(env.BRAIN_DB, "Entity View Alias");
    await env.BRAIN_DB.prepare(
      `INSERT OR IGNORE INTO entity_aliases (entity_id, alias, norm_alias) VALUES (?1, 'evt alias', 'evt alias')`,
    )
      .bind(subject.id)
      .run();
    const object = await resolveSubject(env.BRAIN_DB, "Toolz", "Tool");
    const eventId = await seedUserEvent();
    await createFact(env, {
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      objectText: "toolz",
      factKind: "observed",
      confidence: 0.5,
      sensitivity: "normal",
      sourceEventId: eventId,
    });
    await createFact(env, {
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "login",
      objectText: "hunter2",
      factKind: "user_stated",
      confidence: 0.9,
      sensitivity: "restricted",
      sourceEventId: eventId,
    });

    const res = await call("GET", `/v1/entities/${subject.id}`, undefined, bearer(env, "MCP_READ"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entity: { id: string; name: string };
      aliases: Array<{ alias: string }>;
      facts: Array<{ object: string }>;
      edges: { out: Array<{ dst: { id: string; name: string } }>; in: unknown[] };
    };
    expect(body.entity.id).toBe(subject.id);
    expect(body.aliases.map((a) => a.alias)).toContain("evt alias");
    expect(body.facts.map((f) => f.object)).not.toContain("hunter2");
    expect(body.facts.map((f) => f.object)).toContain("toolz");
    expect(body.edges.out.some((e) => e.dst.id === object.id)).toBe(true);

    const adminRes = await call("GET", `/v1/entities/${subject.id}`, undefined, bearer(env, "ADMIN"));
    const adminBody = (await adminRes.json()) as { facts: Array<{ object: string }> };
    expect(adminBody.facts.map((f) => f.object)).toContain("hunter2");
  });

  it("404s unknown entities", async () => {
    const res = await call("GET", `/v1/entities/01ZZZUNKNOWN`, undefined, bearer(env, "MCP_READ"));
    expect(res.status).toBe(404);
  });
});
