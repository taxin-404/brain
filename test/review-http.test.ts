import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { resolveSubject } from "../src/entities";
import { createFact } from "../src/factstore";
import { createProposal } from "../src/proposals";
import { bearer, call, installFakeVectorize } from "./helpers";

let seq = 1_785_000_000_000;

const seedUserEvent = async (): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'user', 1.0, NULL, 'note', 'normal', 'review-http evidence', ?4)`,
  )
    .bind(id, (seq += 1000), Date.now(), `hmac-${id}`)
    .run();
  return id;
};

const seedActiveFact = async (objectText: string, opts: { sensitivity?: string } = {}) => {
  const eventId = await seedUserEvent();
  const subject = await resolveSubject(env.BRAIN_DB, `HTTP Review Subject ${newEventId().slice(-5)}`, "Project");
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
  return { factId, eventId };
};

describe("REST fact review", () => {
  beforeEach(() => {
    installFakeVectorize();
  });

  it("correct with user evidence auto-applies and supersedes in the same response cycle", async () => {
    const { factId, eventId } = await seedActiveFact("rest old");
    const res = await call(
      "POST",
      `/v1/facts/${factId}/correct`,
      { correction: "REST New", evidence_event_id: eventId, reason: "acceptance" },
      bearer(env, "ADMIN"),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ proposal_id: string; review_mode: string; applied: boolean }>();
    expect(body.review_mode).toBe("auto");
    expect(body.applied).toBe(true);

    const old = await env.BRAIN_DB.prepare(`SELECT status, superseded_by FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ status: string; superseded_by: string | null }>();
    expect(old?.status).toBe("superseded");
    const nf = await env.BRAIN_DB.prepare(`SELECT object_text FROM facts WHERE id = ?1`)
      .bind(old?.superseded_by)
      .first<{ object_text: string }>();
    expect(nf?.object_text).toBe("rest new");
  });

  it("correct without evidence stays pending", async () => {
    const { factId } = await seedActiveFact("manual old");
    const res = await call("POST", `/v1/facts/${factId}/correct`, { correction: "manual new" }, bearer(env, "ADMIN"));
    expect(res.status).toBe(201);
    const body = await res.json<{ proposal_id: string; review_mode: string; applied: boolean }>();
    expect(body.review_mode).toBe("manual");
    expect(body.applied).toBe(false);
    const p = await env.BRAIN_DB.prepare(`SELECT status FROM proposals WHERE id = ?1`)
      .bind(body.proposal_id)
      .first<{ status: string }>();
    expect(p?.status).toBe("pending");
  });

  it("auto-apply on a vanished target reports applied:false without a 500", async () => {
    const { factId, eventId } = await seedActiveFact("vanishing target");
    await env.BRAIN_DB.prepare(`UPDATE facts SET status = 'superseded' WHERE id = ?1`).bind(factId).run();
    const res = await call(
      "POST",
      `/v1/facts/${factId}/correct`,
      { correction: "x", evidence_event_id: eventId },
      bearer(env, "ADMIN"),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ proposal_id: string; applied: boolean; error?: string }>();
    expect(body.applied).toBe(false);
    expect(body.error).toBe("conflict");
    const p = await env.BRAIN_DB.prepare(`SELECT status FROM proposals WHERE id = ?1`)
      .bind(body.proposal_id)
      .first<{ status: string }>();
    expect(p?.status).toBe("pending");
  });

  it("agent-proposed corrections auto-apply with user evidence (direct createProposal)", async () => {
    const { factId, eventId } = await seedActiveFact("agent old");
    const res = await createProposal(env, "MCP_PROPOSE", {
      kind: "correction",
      payload: { fact_id: factId, correction: "agent new" },
      target_type: "fact",
      target_id: factId,
      evidence_event_id: eventId,
      sensitivity: "normal",
    });
    expect(res.review_mode).toBe("auto");
    expect(res.applied).toBe(true);
    const old = await env.BRAIN_DB.prepare(`SELECT status FROM facts WHERE id = ?1`).bind(factId).first<{ status: string }>();
    expect(old?.status).toBe("superseded");
  });

  it("dispute auto-applies for normal facts and stays manual for sensitive ones", async () => {
    const normal = await seedActiveFact("dispute me");
    const r1 = await call("POST", `/v1/facts/${normal.factId}/dispute`, { reason: "check" }, bearer(env, "ADMIN"));
    expect(r1.status).toBe(201);
    const b1 = await r1.json<{ applied: boolean }>();
    expect(b1.applied).toBe(true);
    const row1 = await env.BRAIN_DB.prepare(`SELECT status FROM facts WHERE id = ?1`)
      .bind(normal.factId)
      .first<{ status: string }>();
    expect(row1?.status).toBe("disputed");

    const sensitive = await seedActiveFact("dispute me too", { sensitivity: "sensitive" });
    const r2 = await call("POST", `/v1/facts/${sensitive.factId}/dispute`, {}, bearer(env, "ADMIN"));
    expect(r2.status).toBe(201);
    const b2 = await r2.json<{ applied: boolean; review_mode: string }>();
    expect(b2.review_mode).toBe("manual");
    expect(b2.applied).toBe(false);
    const row2 = await env.BRAIN_DB.prepare(`SELECT status FROM facts WHERE id = ?1`)
      .bind(sensitive.factId)
      .first<{ status: string }>();
    expect(row2?.status).toBe("active");
  });

  it("404s unknown facts and requires admin scope", async () => {
    const res = await call("POST", `/v1/facts/01NOPEUNKNOWN/correct`, { correction: "x" }, bearer(env, "ADMIN"));
    expect(res.status).toBe(404);

    const { factId } = await seedActiveFact("scope check");
    const denied = await call("POST", `/v1/facts/${factId}/purge`, {}, bearer(env, "MCP_READ"));
    expect(denied.status).toBe(403);
  });
});

describe("REST proposal review", () => {
  beforeEach(() => {
    installFakeVectorize();
  });

  it("purge → apply requires a fact:{id} confirm token and purges on success", async () => {
    const { factId } = await seedActiveFact("rest purgeable");
    const r1 = await call("POST", `/v1/facts/${factId}/purge`, { reason: "test" }, bearer(env, "ADMIN"));
    expect(r1.status).toBe(201);
    const { proposal_id } = await r1.json<{ proposal_id: string }>();

    const r2 = await call("POST", `/v1/proposals/${proposal_id}/apply`, {}, bearer(env, "ADMIN"));
    expect(r2.status).toBe(400);
    expect((await r2.json<{ error: string }>()).error).toBe("invalid_token");

    const wrongMint = await call("POST", "/v1/confirm/token", { target: "event:whatever" }, bearer(env, "ADMIN"));
    const wrong = await wrongMint.json<{ token: string }>();
    const r3 = await call("POST", `/v1/proposals/${proposal_id}/apply`, { confirm_token: wrong.token }, bearer(env, "ADMIN"));
    expect(r3.status).toBe(400);
    expect((await r3.json<{ error: string }>()).error).toBe("invalid_token");

    const mint = await call("POST", "/v1/confirm/token", { target: `fact:${factId}` }, bearer(env, "ADMIN"));
    const { token } = await mint.json<{ token: string }>();
    const r4 = await call("POST", `/v1/proposals/${proposal_id}/apply`, { confirm_token: token, reason: "go" }, bearer(env, "ADMIN"));
    expect(r4.status).toBe(200);
    const row = await env.BRAIN_DB.prepare(`SELECT object_text, status FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ object_text: string | null; status: string }>();
    expect(row).toMatchObject({ object_text: null, status: "deleted" });
  });

  it("discard requires admin and marks the proposal", async () => {
    const { factId } = await seedActiveFact("to discard");
    const r1 = await call("POST", `/v1/facts/${factId}/purge`, {}, bearer(env, "ADMIN"));
    const { proposal_id } = await r1.json<{ proposal_id: string }>();

    const denied = await call("POST", `/v1/proposals/${proposal_id}/discard`, {}, bearer(env, "MCP_READ"));
    expect(denied.status).toBe(403);

    const r2 = await call("POST", `/v1/proposals/${proposal_id}/discard`, {}, bearer(env, "ADMIN"));
    expect(r2.status).toBe(200);
    expect((await r2.json<{ discarded: boolean }>()).discarded).toBe(true);
    const p = await env.BRAIN_DB.prepare(`SELECT status FROM proposals WHERE id = ?1`)
      .bind(proposal_id)
      .first<{ status: string }>();
    expect(p?.status).toBe("discarded");
  });

  it("undo round-trips an applied correction over REST", async () => {
    const { factId, eventId } = await seedActiveFact("undo me");
    const r1 = await call(
      "POST",
      `/v1/facts/${factId}/correct`,
      { correction: "undone new", evidence_event_id: eventId },
      bearer(env, "ADMIN"),
    );
    const { proposal_id } = await r1.json<{ proposal_id: string }>();

    const r2 = await call("POST", `/v1/proposals/${proposal_id}/undo`, {}, bearer(env, "ADMIN"));
    expect(r2.status).toBe(200);
    expect((await r2.json<{ undone: boolean }>()).undone).toBe(true);
    const old = await env.BRAIN_DB.prepare(`SELECT status, superseded_by FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ status: string; superseded_by: string | null }>();
    expect(old).toMatchObject({ status: "active", superseded_by: null });

    const r3 = await call("POST", `/v1/proposals/${proposal_id}/undo`, {}, bearer(env, "ADMIN"));
    expect(r3.status).toBe(400);
    expect((await r3.json<{ error: string }>()).error).toBe("not_applied");
  });

  it("hides restricted proposals from non-admin listings", async () => {
    const restricted = await seedActiveFact("restricted thing", { sensitivity: "restricted" });
    const r1 = await call("POST", `/v1/facts/${restricted.factId}/purge`, {}, bearer(env, "ADMIN"));
    const { proposal_id } = await r1.json<{ proposal_id: string }>();

    const read = await call("GET", "/v1/proposals", undefined, bearer(env, "MCP_READ"));
    expect(read.status).toBe(200);
    const readBody = await read.json<{ proposals: Array<{ id: string }> }>();
    expect(readBody.proposals.map((p) => p.id)).not.toContain(proposal_id);

    const admin = await call("GET", "/v1/proposals?limit=100", undefined, bearer(env, "ADMIN"));
    const adminBody = await admin.json<{ proposals: Array<{ id: string }> }>();
    expect(adminBody.proposals.map((p) => p.id)).toContain(proposal_id);
  });
});
