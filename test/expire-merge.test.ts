import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { resolveSubject } from "../src/entities";
import { confirmFact, createFact, disputeFact, expireFact, mergeFacts } from "../src/factstore";
import { fakeVec, installFakeVectorize, type StoredVector } from "./helpers";

const seedEvent = async (): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'user', 1.0, NULL, 'note', 'normal', 'note for expire/merge test', ?4)`,
  )
    .bind(id, 1_770_000_000_000 + Math.floor(Math.random() * 1_000_000), Date.now(), `hmac-${id}`)
    .run();
  return id;
};

const seedFact = async (opts: {
  subjectId: string;
  subjectName: string;
  predicate: string;
  object: string;
  now?: number;
  kind?: "inferred" | "temporary";
  expiresAt?: number;
}): Promise<string> => {
  const eventId = await seedEvent();
  return createFact(env, {
    subjectId: opts.subjectId,
    subjectName: opts.subjectName,
    predicate: opts.predicate,
    objectText: opts.object,
    factKind: opts.kind ?? "inferred",
    confidence: 0.5,
    expiresAt: opts.expiresAt,
    sensitivity: "normal",
    sourceEventId: eventId,
    now: opts.now,
  });
};

describe("expireFact / mergeFacts", () => {
  let store: Map<string, StoredVector>;
  beforeEach(() => {
    store = installFakeVectorize();
  });

  it("expireFact archives a lapsed fact: expired_at, closed edge, pruned vector, audit", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "expire subject", "Project");
    const target = await resolveSubject(env.BRAIN_DB, "expire target", "Project");
    const id = await seedFact({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      object: "expire target",
      kind: "temporary",
      expiresAt: 900,
      now: 1000,
    });
    store.set(id, { id, values: fakeVec("expire target"), metadata: {} });

    const edgeBefore = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM edges WHERE src = ?1 AND dst = ?2 AND rel = 'uses' AND invalid_at IS NULL`,
    )
      .bind(subject.id, target.id)
      .first<{ n: number }>();
    expect(edgeBefore?.n).toBe(1);

    await expireFact(env, id, { now: 3000 });

    const row = await env.BRAIN_DB.prepare(`SELECT status, expired_at, object_text FROM facts WHERE id = ?1`)
      .bind(id)
      .first<{ status: string; expired_at: number | null; object_text: string | null }>();
    expect(row).toMatchObject({ status: "archived", expired_at: 3000, object_text: "expire target" }); // text kept for why
    expect(store.has(id)).toBe(false); // vector pruned

    const edgeAfter = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM edges WHERE src = ?1 AND dst = ?2 AND rel = 'uses' AND invalid_at IS NULL`,
    )
      .bind(subject.id, target.id)
      .first<{ n: number }>();
    expect(edgeAfter?.n).toBe(0);

    const aud = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'expire' AND target_id = ?1`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(aud?.n).toBe(1);
  });

  it("expireFact refuses non-active facts", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "expire guard subject", "Project");
    const id = await seedFact({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      object: "guard object",
    });
    await disputeFact(env, id, 5000);
    await expect(expireFact(env, id, { now: 6000 })).rejects.toThrow(/not active/);
    const row = await env.BRAIN_DB.prepare(`SELECT status, expired_at FROM facts WHERE id = ?1`)
      .bind(id)
      .first<{ status: string; expired_at: number | null }>();
    expect(row).toMatchObject({ status: "disputed", expired_at: null });
  });

  it("mergeFacts unions sources, aggregates timestamps/confidence and supersedes the victim", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "merge subject", "Project");
    const survivor = await seedFact({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      object: "alpha lib",
      now: 1000,
    });
    const survivorExtra = await seedEvent();
    await confirmFact(env, survivor, survivorExtra, 1500);

    const victim = await seedFact({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      object: "alpha library",
      now: 2000,
    });
    const victimExtra = await seedEvent();
    await confirmFact(env, victim, victimExtra, 5000); // victim's last_confirmed is the newest of both
    store.set(victim, { id: victim, values: fakeVec("alpha library"), metadata: {} });

    await mergeFacts(env, survivor, victim, { now: 6000, confidence: 0.8 });

    const s = await env.BRAIN_DB.prepare(
      `SELECT confidence, first_seen_at, last_confirmed_at, status FROM facts WHERE id = ?1`,
    )
      .bind(survivor)
      .first<{ confidence: number; first_seen_at: number; last_confirmed_at: number; status: string }>();
    expect(s).toMatchObject({ confidence: 0.8, first_seen_at: 1000, last_confirmed_at: 5000, status: "active" });

    const v = await env.BRAIN_DB.prepare(`SELECT status, superseded_by FROM facts WHERE id = ?1`)
      .bind(victim)
      .first<{ status: string; superseded_by: string | null }>();
    expect(v).toMatchObject({ status: "superseded", superseded_by: survivor });
    expect(store.has(victim)).toBe(false);

    // union: survivor's 2 events + victim's 2 events
    const src = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM fact_sources WHERE fact_id = ?1`)
      .bind(survivor)
      .first<{ n: number }>();
    expect(src?.n).toBe(4);
    const hasVictimExtra = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM fact_sources WHERE fact_id = ?1 AND event_id = ?2`,
    )
      .bind(survivor, victimExtra)
      .first<{ n: number }>();
    expect(hasVictimExtra?.n).toBe(1);

    const audits = await env.BRAIN_DB.prepare(
      `SELECT action, target_id FROM audit_log WHERE (action = 'merge' AND target_id = ?1) OR (action = 'supersede' AND target_id = ?2)`,
    )
      .bind(survivor, victim)
      .all<{ action: string; target_id: string }>();
    expect(audits.results.map((a) => `${a.action}:${a.target_id}`).sort()).toEqual([
      `merge:${survivor}`,
      `supersede:${victim}`,
    ]);
  });

  it("mergeFacts refuses inactive victims and mismatched predicates", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "merge guard subject", "Project");
    const survivor = await seedFact({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      object: "guard alpha",
    });

    const disputedVictim = await seedFact({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      object: "guard beta",
    });
    await disputeFact(env, disputedVictim, 7000);
    await expect(mergeFacts(env, survivor, disputedVictim, { now: 8000, confidence: 0.6 })).rejects.toThrow(
      /not active/,
    );

    const otherPredicate = await seedFact({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "prefers",
      object: "guard gamma",
    });
    await expect(mergeFacts(env, survivor, otherPredicate, { now: 8000, confidence: 0.6 })).rejects.toThrow(
      /mismatch/,
    );
  });

  it("mergeFacts clamps merged confidence at the 0.85 inferred ceiling", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "merge clamp subject", "Project");
    const survivor = await seedFact({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      object: "clamp alpha",
      now: 1000,
    });
    const victim = await seedFact({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      object: "clamp beta",
      now: 2000,
    });
    await mergeFacts(env, survivor, victim, { now: 3000, confidence: 0.95 });
    const row = await env.BRAIN_DB.prepare(`SELECT confidence FROM facts WHERE id = ?1`)
      .bind(survivor)
      .first<{ confidence: number }>();
    expect(row?.confidence).toBe(0.85);
  });
});
