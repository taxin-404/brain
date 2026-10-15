import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { resolveSubject } from "../src/entities";
import { createFact, purgeFact } from "../src/factstore";
import { mintConfirmToken } from "../src/purge";
import { applyProposal, discardProposal, undoProposal } from "../src/review";
import { fakeVec, installFakeVectorize, type StoredVector } from "./helpers";

let seq = 1_780_000_000_000;

const seedUserEvent = async (): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'user', 1.0, NULL, 'note', 'normal', 'review test note', ?4)`,
  )
    .bind(id, (seq += 1000), Date.now(), `hmac-${id}`)
    .run();
  return id;
};

const seedProposal = async (over: {
  kind: string;
  payload: unknown;
  target_type?: string;
  target_id?: string;
  sensitivity?: string;
  review_mode?: string;
  status?: string;
  evidence_event_id?: string;
}): Promise<string> => {
  const id = newEventId();
  const now = seq += 1000;
  await env.BRAIN_DB.prepare(
    `INSERT INTO proposals (id, kind, payload_json, target_type, target_id, evidence_event_id, sensitivity,
                            review_mode, status, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      id,
      over.kind,
      JSON.stringify(over.payload),
      over.target_type ?? null,
      over.target_id ?? null,
      over.evidence_event_id ?? null,
      over.sensitivity ?? "normal",
      over.review_mode ?? "manual",
      over.status ?? "pending",
      now,
      now + 14 * 86_400_000,
    )
    .run();
  return id;
};

const seedActiveFact = async (objectText: string, opts: { sensitivity?: string } = {}) => {
  const eventId = await seedUserEvent();
  const subject = await resolveSubject(env.BRAIN_DB, `Review Subject ${newEventId().slice(-5)}`, "Project");
  const factId = await createFact(env, {
    subjectId: subject.id,
    subjectName: subject.name,
    predicate: "is_called",
    objectText,
    factKind: "user_stated",
    confidence: 0.9,
    sensitivity: opts.sensitivity ?? "normal",
    sourceEventId: eventId,
  });
  return { factId, eventId, subjectId: subject.id };
};

describe("applyProposal — correction", () => {
  let store: Map<string, StoredVector>;
  beforeEach(() => {
    store = installFakeVectorize();
  });

  it("supersedes the old fact, creates the replacement, copies sources, audits", async () => {
    const { factId: oldId, eventId } = await seedActiveFact("old name");
    await env.BRAIN_DB.prepare(`UPDATE facts SET vec_id = ?1 WHERE id = ?1`).bind(oldId).run();
    store.set(oldId, { id: oldId, values: fakeVec("old name"), metadata: { fact_id: oldId, status: "active" } });

    const proposalId = await seedProposal({
      kind: "correction",
      payload: { fact_id: oldId, correction: "New Name" },
      target_type: "fact",
      target_id: oldId,
      evidence_event_id: eventId,
    });

    const res = await applyProposal(env, proposalId, { actor: "user" });
    expect(res).toEqual({ applied: true, kind: "correction" });

    const old = await env.BRAIN_DB.prepare(
      `SELECT status, invalid_at, superseded_by, vec_id FROM facts WHERE id = ?1`,
    )
      .bind(oldId)
      .first<{ status: string; invalid_at: number | null; superseded_by: string | null; vec_id: string | null }>();
    expect(old?.status).toBe("superseded");
    expect(old?.invalid_at).not.toBeNull();
    expect(old?.superseded_by).not.toBeNull();
    expect(old?.vec_id).toBeNull();
    expect(store.has(oldId)).toBe(false);

    const nf = await env.BRAIN_DB.prepare(
      `SELECT object_text, fact_kind, confidence, status, source_event_id, sensitivity, valid_at FROM facts WHERE id = ?1`,
    )
      .bind(old?.superseded_by)
      .first<Record<string, unknown>>();
    expect(nf).toMatchObject({
      object_text: "new name",
      fact_kind: "user_stated",
      confidence: 0.9,
      status: "active",
      source_event_id: eventId,
      sensitivity: "normal",
    });
    expect(nf?.valid_at).not.toBeNull();

    const src = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM fact_sources WHERE fact_id = ?1`)
      .bind(old?.superseded_by)
      .first<{ n: number }>();
    expect(src?.n).toBeGreaterThanOrEqual(1);

    const aud = await env.BRAIN_DB.prepare(
      `SELECT before_json, after_json FROM audit_log WHERE target_type = 'proposal' AND target_id = ?1 AND action = 'approve'`,
    )
      .bind(proposalId)
      .first<{ before_json: string; after_json: string }>();
    expect(aud).not.toBeNull();
    expect(JSON.parse(aud?.after_json ?? "{}")).toMatchObject({ new_fact_id: old?.superseded_by });

    const prop = await env.BRAIN_DB.prepare(`SELECT status, applied_at, applied_by FROM proposals WHERE id = ?1`)
      .bind(proposalId)
      .first<{ status: string; applied_at: number | null; applied_by: string | null }>();
    expect(prop).toMatchObject({ status: "applied", applied_by: "user" });
    expect(prop?.applied_at).not.toBeNull();
  });

  it("refuses non-pending proposals", async () => {
    const { factId } = await seedActiveFact("some name");
    const proposalId = await seedProposal({
      kind: "correction",
      payload: { fact_id: factId, correction: "x" },
      target_id: factId,
      status: "applied",
    });
    await expect(applyProposal(env, proposalId, { actor: "user" })).rejects.toMatchObject({ code: "not_pending" });
  });

  it("refuses corrections whose target is no longer active", async () => {
    const { factId } = await seedActiveFact("stale name");
    await env.BRAIN_DB.prepare(`UPDATE facts SET status = 'superseded' WHERE id = ?1`).bind(factId).run();
    const proposalId = await seedProposal({ kind: "correction", payload: { fact_id: factId, correction: "x" }, target_id: factId });
    await expect(applyProposal(env, proposalId, { actor: "user" })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("applyProposal — forget", () => {
  let store: Map<string, StoredVector>;
  beforeEach(() => {
    store = installFakeVectorize();
  });

  it("requires a confirm token and leaves the proposal pending without one", async () => {
    const { factId } = await seedActiveFact("purgeable alpha");
    const proposalId = await seedProposal({
      kind: "forget",
      payload: { target_type: "fact", target_id: factId },
      target_type: "fact",
      target_id: factId,
    });
    await expect(applyProposal(env, proposalId, { actor: "user" })).rejects.toMatchObject({ code: "invalid_token" });
    const prop = await env.BRAIN_DB.prepare(`SELECT status FROM proposals WHERE id = ?1`).bind(proposalId).first<{ status: string }>();
    expect(prop?.status).toBe("pending");
  });

  it("purges a fact with a valid token: object NULL, FTS gone, vector gone, audit written", async () => {
    const { factId } = await seedActiveFact("purgeable beta");
    await env.BRAIN_DB.prepare(`UPDATE facts SET vec_id = ?1 WHERE id = ?1`).bind(factId).run();
    store.set(factId, { id: factId, values: fakeVec("purgeable beta"), metadata: { fact_id: factId } });
    const rowid = await env.BRAIN_DB.prepare(`SELECT rowid FROM facts WHERE id = ?1`).bind(factId).first<{ rowid: number }>();

    const proposalId = await seedProposal({
      kind: "forget",
      payload: { target_type: "fact", target_id: factId },
      target_type: "fact",
      target_id: factId,
    });
    const { token } = await mintConfirmToken(env, `fact:${factId}`);

    const res = await applyProposal(env, proposalId, { actor: "user", confirmToken: token });
    expect(res).toEqual({ applied: true, kind: "forget" });

    const row = await env.BRAIN_DB.prepare(`SELECT object_text, status, vec_id FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ object_text: string | null; status: string; vec_id: string | null }>();
    expect(row).toMatchObject({ object_text: null, status: "deleted", vec_id: null });
    expect(store.has(factId)).toBe(false);

    const ftsHits = await env.BRAIN_DB.prepare(`SELECT rowid FROM facts_fts WHERE facts_fts MATCH '"purgeable"'`).all<{
      rowid: number;
    }>();
    expect(ftsHits.results.map((r) => r.rowid)).not.toContain(rowid?.rowid);

    const aud = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM audit_log WHERE target_type = 'fact' AND target_id = ?1 AND action = 'purge'`,
    )
      .bind(factId)
      .first<{ n: number }>();
    expect(aud?.n).toBeGreaterThanOrEqual(1);

    // idempotent second run (no FTS delete on NULL, no error)
    await purgeFact(env, factId);
    const again = await env.BRAIN_DB.prepare(`SELECT status FROM facts WHERE id = ?1`).bind(factId).first<{ status: string }>();
    expect(again?.status).toBe("deleted");
  });

  it("purges an event with a valid token: crypto-shred + tombstone", async () => {
    const eventId = await seedUserEvent();
    const proposalId = await seedProposal({
      kind: "forget",
      payload: { target_type: "event", target_id: eventId },
      target_type: "event",
      target_id: eventId,
    });
    const { token } = await mintConfirmToken(env, `event:${eventId}`);

    const res = await applyProposal(env, proposalId, { actor: "user", confirmToken: token });
    expect(res).toEqual({ applied: true, kind: "forget" });

    const row = await env.BRAIN_DB.prepare(`SELECT redacted, excerpt FROM events WHERE id = ?1`)
      .bind(eventId)
      .first<{ redacted: number; excerpt: string | null }>();
    expect(row).toMatchObject({ redacted: 1, excerpt: null });

    const tomb = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM events WHERE kind = 'purge_tombstone'`).first<{
      n: number;
    }>();
    expect(tomb?.n).toBeGreaterThanOrEqual(1);

    const prop = await env.BRAIN_DB.prepare(`SELECT status FROM proposals WHERE id = ?1`).bind(proposalId).first<{ status: string }>();
    expect(prop?.status).toBe("applied");
  });
});

describe("applyProposal — dispute", () => {
  it("marks an active fact disputed", async () => {
    const { factId } = await seedActiveFact("disputed object");
    const proposalId = await seedProposal({
      kind: "dispute",
      payload: { reason: "looks wrong" },
      target_type: "fact",
      target_id: factId,
    });
    const res = await applyProposal(env, proposalId, { actor: "system" });
    expect(res).toEqual({ applied: true, kind: "dispute" });
    const row = await env.BRAIN_DB.prepare(`SELECT status FROM facts WHERE id = ?1`).bind(factId).first<{ status: string }>();
    expect(row?.status).toBe("disputed");
  });

  it("refuses disputes of non-active facts", async () => {
    const { factId } = await seedActiveFact("already gone");
    await env.BRAIN_DB.prepare(`UPDATE facts SET status = 'deleted' WHERE id = ?1`).bind(factId).run();
    const proposalId = await seedProposal({ kind: "dispute", payload: {}, target_type: "fact", target_id: factId });
    await expect(applyProposal(env, proposalId, { actor: "system" })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("applyProposal — block_edit", () => {
  it("writes the block and records before/after", async () => {
    await env.BRAIN_DB.prepare(`INSERT INTO blocks (key, value, updated_at) VALUES ('objective', 'old objective', ?1)`)
      .bind(Date.now())
      .run();
    const proposalId = await seedProposal({
      kind: "block_edit",
      payload: { key: "objective", value: "new objective" },
      target_type: "block",
      target_id: "objective",
    });
    const res = await applyProposal(env, proposalId, { actor: "user" });
    expect(res).toEqual({ applied: true, kind: "block_edit" });
    const block = await env.BRAIN_DB.prepare(`SELECT value FROM blocks WHERE key = 'objective'`).first<{ value: string }>();
    expect(block?.value).toBe("new objective");
    const aud = await env.BRAIN_DB.prepare(
      `SELECT before_json, after_json FROM audit_log WHERE target_type = 'proposal' AND target_id = ?1 AND action = 'approve'`,
    )
      .bind(proposalId)
      .first<{ before_json: string; after_json: string }>();
    expect(JSON.parse(aud?.before_json ?? "{}")).toMatchObject({ value: "old objective" });
    expect(JSON.parse(aud?.after_json ?? "{}")).toMatchObject({ value: "new objective" });
  });
});

describe("applyProposal — procedure", () => {
  it("is unsupported until Phase 5", async () => {
    const proposalId = await seedProposal({ kind: "procedure", payload: { name: "p", steps: ["a"] }, target_type: "procedure" });
    await expect(applyProposal(env, proposalId, { actor: "user" })).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("discardProposal", () => {
  it("discards pending proposals and refuses others", async () => {
    const id = await seedProposal({ kind: "correction", payload: { fact_id: "x", correction: "y" } });
    await discardProposal(env, id, { actor: "user" });
    const row = await env.BRAIN_DB.prepare(`SELECT status FROM proposals WHERE id = ?1`).bind(id).first<{ status: string }>();
    expect(row?.status).toBe("discarded");

    await expect(discardProposal(env, id, { actor: "user" })).rejects.toMatchObject({ code: "not_pending" });
  });
});

describe("undoProposal", () => {
  let store: Map<string, StoredVector>;
  beforeEach(() => {
    store = installFakeVectorize();
  });

  it("restores the old fact and archives the replacement; a second undo is refused", async () => {
    const { factId: oldId, eventId } = await seedActiveFact("undo old");
    const proposalId = await seedProposal({
      kind: "correction",
      payload: { fact_id: oldId, correction: "undo new" },
      target_id: oldId,
      evidence_event_id: eventId,
    });
    await applyProposal(env, proposalId, { actor: "user" });
    const mid = await env.BRAIN_DB.prepare(`SELECT superseded_by FROM facts WHERE id = ?1`).bind(oldId).first<{ superseded_by: string }>();
    const newFactId = mid?.superseded_by;
    store.set(newFactId!, { id: newFactId!, values: fakeVec("undo new"), metadata: { fact_id: newFactId } });

    await undoProposal(env, proposalId, { actor: "user" });

    const old = await env.BRAIN_DB.prepare(`SELECT status, superseded_by, invalid_at FROM facts WHERE id = ?1`)
      .bind(oldId)
      .first<{ status: string; superseded_by: string | null; invalid_at: number | null }>();
    expect(old).toMatchObject({ status: "active", superseded_by: null, invalid_at: null });
    const nf = await env.BRAIN_DB.prepare(`SELECT status FROM facts WHERE id = ?1`).bind(newFactId).first<{ status: string }>();
    expect(nf?.status).toBe("archived");
    expect(store.has(newFactId!)).toBe(false);
    const prop = await env.BRAIN_DB.prepare(`SELECT undone_at, status FROM proposals WHERE id = ?1`)
      .bind(proposalId)
      .first<{ undone_at: number | null; status: string }>();
    expect(prop?.undone_at).not.toBeNull();
    expect(prop?.status).toBe("applied");

    await expect(undoProposal(env, proposalId, { actor: "user" })).rejects.toMatchObject({ code: "not_applied" });
  });

  it("refuses to undo a purge (irreversible)", async () => {
    const { factId } = await seedActiveFact("irreversible thing");
    const proposalId = await seedProposal({
      kind: "forget",
      payload: { target_type: "fact", target_id: factId },
      target_type: "fact",
      target_id: factId,
    });
    const { token } = await mintConfirmToken(env, `fact:${factId}`);
    await applyProposal(env, proposalId, { actor: "user", confirmToken: token });
    await expect(undoProposal(env, proposalId, { actor: "user" })).rejects.toMatchObject({ code: "irreversible" });
  });

  it("restores a disputed fact to active", async () => {
    const { factId } = await seedActiveFact("dispute undo");
    const proposalId = await seedProposal({ kind: "dispute", payload: {}, target_type: "fact", target_id: factId });
    await applyProposal(env, proposalId, { actor: "system" });
    await undoProposal(env, proposalId, { actor: "user" });
    const row = await env.BRAIN_DB.prepare(`SELECT status FROM facts WHERE id = ?1`).bind(factId).first<{ status: string }>();
    expect(row?.status).toBe("active");
  });

  it("restores the previous block value", async () => {
    await env.BRAIN_DB.prepare(`INSERT INTO blocks (key, value, updated_at) VALUES ('constraints', 'before edit', ?1)`)
      .bind(Date.now())
      .run();
    const proposalId = await seedProposal({
      kind: "block_edit",
      payload: { key: "constraints", value: "after edit" },
      target_type: "block",
      target_id: "constraints",
    });
    await applyProposal(env, proposalId, { actor: "user" });
    await undoProposal(env, proposalId, { actor: "user" });
    const block = await env.BRAIN_DB.prepare(`SELECT value FROM blocks WHERE key = 'constraints'`).first<{ value: string }>();
    expect(block?.value).toBe("before edit");
  });
});
