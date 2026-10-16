import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { resolveSubject } from "../src/entities";
import { confirmFact, createFact, deleteFactVector } from "../src/factstore";
import { fakeVec, installFakeVectorize, type StoredVector } from "./helpers";

const seedUserEvent = async (): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'user', 1.0, NULL, 'note', 'normal', 'note for factstore test', ?4)`,
  )
    .bind(id, 1_760_000_000_000 + Math.floor(Math.random() * 1_000_000), Date.now(), `hmac-${id}`)
    .run();
  return id;
};

describe("factstore", () => {
  let store: Map<string, StoredVector>;
  beforeEach(() => {
    store = installFakeVectorize();
  });

  it("createFact writes the fact row, FTS index row, source link and create audit", async () => {
    const eventId = await seedUserEvent();
    const subject = await resolveSubject(env.BRAIN_DB, "factstore subject", "Project");
    const id = await createFact(env, {
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      objectText: "alpha marker",
      factKind: "inferred",
      confidence: 0.59,
      sensitivity: "normal",
      sourceEventId: eventId,
    });

    const row = await env.BRAIN_DB.prepare(
      `SELECT subject_id, predicate, object_text, fact_kind, confidence, status, vec_id, embedding_model
       FROM facts WHERE id = ?1`,
    )
      .bind(id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      subject_id: subject.id,
      predicate: "uses",
      object_text: "alpha marker",
      fact_kind: "inferred",
      confidence: 0.59,
      status: "active",
      vec_id: null,
      embedding_model: "gemini-embedding-001@768",
    });

    // FTS5 is external-content: MATCH hits prove the manual index row exists.
    const ftsHits = await env.BRAIN_DB.prepare(`SELECT rowid FROM facts_fts WHERE facts_fts MATCH '"alpha"'`).all<{
      rowid: number;
    }>();
    const own = await env.BRAIN_DB.prepare(`SELECT rowid FROM facts WHERE id = ?1`).bind(id).first<{ rowid: number }>();
    expect(ftsHits.results.map((r) => r.rowid)).toContain(own?.rowid);

    const src = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM fact_sources WHERE fact_id = ?1 AND event_id = ?2`)
      .bind(id, eventId)
      .first<{ n: number }>();
    expect(src?.n).toBe(1);

    const aud = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM audit_log WHERE target_type = 'fact' AND target_id = ?1 AND action = 'create'`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(aud?.n).toBe(1);
  });

  it("createFact honors status, validAt and expiresAt", async () => {
    const eventId = await seedUserEvent();
    const subject = await resolveSubject(env.BRAIN_DB, "disputed subject", "Project");
    const id = await createFact(env, {
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      objectText: "maybe",
      factKind: "inferred",
      confidence: 0.5,
      status: "disputed",
      validAt: 111,
      expiresAt: 222,
      sensitivity: "normal",
      sourceEventId: eventId,
    });
    const row = await env.BRAIN_DB.prepare(`SELECT status, valid_at, expires_at FROM facts WHERE id = ?1`)
      .bind(id)
      .first<{ status: string; valid_at: number; expires_at: number }>();
    expect(row).toEqual({ status: "disputed", valid_at: 111, expires_at: 222 });
  });

  it("confirmFact bumps last_confirmed_at and dedupes source links", async () => {
    const eventId = await seedUserEvent();
    const subject = await resolveSubject(env.BRAIN_DB, "confirm subject", "Project");
    const id = await createFact(env, {
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "likes",
      objectText: "beta marker",
      factKind: "user_stated",
      confidence: 0.9,
      sensitivity: "normal",
      sourceEventId: eventId,
    });

    await confirmFact(env, id, eventId, 1_999_999_999_999);
    const row = await env.BRAIN_DB.prepare(`SELECT last_confirmed_at FROM facts WHERE id = ?1`)
      .bind(id)
      .first<{ last_confirmed_at: number }>();
    expect(row?.last_confirmed_at).toBe(1_999_999_999_999);

    const other = await seedUserEvent();
    await confirmFact(env, id, other, 1_999_999_999_999);
    await confirmFact(env, id, other, 1_999_999_999_999); // repeat: dedupe
    const n = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM fact_sources WHERE fact_id = ?1`)
      .bind(id)
      .first<{ n: number }>();
    expect(n?.n).toBe(2); // original source + one new event, no duplicate
  });

  it("deleteFactVector removes the index entry and nulls vec_id", async () => {
    const eventId = await seedUserEvent();
    const subject = await resolveSubject(env.BRAIN_DB, "vector subject", "Project");
    const id = await createFact(env, {
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      objectText: "gamma marker",
      factKind: "observed",
      confidence: 0.5,
      sensitivity: "normal",
      sourceEventId: eventId,
    });

    // simulate a completed embed pass
    await env.BRAIN_DB.prepare(`UPDATE facts SET vec_id = ?1 WHERE id = ?1`).bind(id).run();
    store.set(id, { id, values: fakeVec("gamma marker"), metadata: { fact_id: id, status: "active" } });

    await deleteFactVector(env, id);
    expect(store.has(id)).toBe(false);
    const row = await env.BRAIN_DB.prepare(`SELECT vec_id FROM facts WHERE id = ?1`).bind(id).first<{ vec_id: string | null }>();
    expect(row?.vec_id).toBeNull();
  });
});
