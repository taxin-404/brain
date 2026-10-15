import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { applyProposal, undoProposal } from "../src/review";
import { bearer, call, installFakeVectorize } from "./helpers";

const seedEvent = async (actor: string, trust: number): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', ?4, ?5, NULL, 'note', 'normal', 'procedure evidence', ?6)`,
  )
    .bind(id, 1_850_000_000_000 + Math.floor(Math.random() * 1_000_000), Date.now(), actor, trust, `hmac-${id}`)
    .run();
  return id;
};

const seedProposal = async (payload: unknown, evidenceEventId: string | null = null): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO proposals (id, kind, payload_json, target_type, target_id, evidence_event_id, sensitivity,
                            review_mode, status, created_at, expires_at)
     VALUES (?1, 'procedure', ?2, 'procedure', NULL, ?3, 'normal', 'manual', 'pending', 1, 2)`,
  )
    .bind(id, JSON.stringify(payload), evidenceEventId)
    .run();
  return id;
};

const procedureRow = async (id: string) =>
  env.BRAIN_DB.prepare(
    `SELECT id, name, current_version, status, origin_trust FROM procedures WHERE id = ?1`,
  )
    .bind(id)
    .first<{ id: string; name: string; current_version: number; status: string; origin_trust: number }>();

const versionRows = async (id: string) =>
  env.BRAIN_DB.prepare(
    `SELECT version, steps, promoted_from_events FROM procedure_versions WHERE procedure_id = ?1 ORDER BY version`,
  )
    .bind(id)
    .all<{ version: number; steps: string; promoted_from_events: string | null }>();

describe("procedure promotion", () => {
  beforeEach(() => {
    installFakeVectorize();
  });

  it("applies a proposal into a draft v1 with version row, origin trust and audit", async () => {
    const ev = await seedEvent("user", 1.0);
    const pid = await seedProposal(
      { name: "Deploy the brain", steps: ["run the gate", "merge to master", "watch the build"] },
      ev,
    );

    const res = await applyProposal(env, pid, { actor: "user" });
    expect(res).toMatchObject({ applied: true, kind: "procedure", version: 1 });
    const procedureId = res.procedure_id;
    expect(typeof procedureId).toBe("string");

    const proc = await procedureRow(procedureId!);
    expect(proc).toMatchObject({
      name: "Deploy the brain",
      current_version: 1,
      status: "draft",
      origin_trust: 1,
    });

    const versions = await versionRows(procedureId!);
    expect(versions.results).toHaveLength(1);
    expect(versions.results[0].version).toBe(1);
    expect(JSON.parse(versions.results[0].steps)).toEqual(["run the gate", "merge to master", "watch the build"]);
    expect(JSON.parse(String(versions.results[0].promoted_from_events))).toEqual([ev]);

    const audit = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'approve' AND target_type = 'procedure' AND target_id = ?1`,
    )
      .bind(procedureId)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);

    const proposal = await env.BRAIN_DB.prepare(`SELECT status FROM proposals WHERE id = ?1`)
      .bind(pid)
      .first<{ status: string }>();
    expect(proposal?.status).toBe("applied");
  });

  it("refuses external-origin evidence and writes nothing", async () => {
    const before = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM procedures`).first<{ n: number }>();
    const evExt = await seedEvent("external", 0.4);
    const pid = await seedProposal({ name: "Poisoned procedure", steps: ["do the thing"] }, evExt);

    await expect(applyProposal(env, pid, { actor: "user" })).rejects.toMatchObject({ code: "untrusted_origin" });

    const after = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM procedures`).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    const proposal = await env.BRAIN_DB.prepare(`SELECT status FROM proposals WHERE id = ?1`)
      .bind(pid)
      .first<{ status: string }>();
    expect(proposal?.status).toBe("pending");
    const audit = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM audit_log WHERE target_type = 'procedure' AND target_id = ?1`,
    )
      .bind(pid)
      .first<{ n: number }>();
    expect(audit?.n).toBe(0);
  });

  it("uses a neutral 0.5 origin trust when no evidence is attached", async () => {
    const pid = await seedProposal({ name: "Evidence-free procedure", steps: ["step one"] });
    const res = await applyProposal(env, pid, { actor: "user" });
    const proc = await procedureRow(res.procedure_id!);
    expect(proc?.origin_trust).toBe(0.5);
  });

  it("appends v2 via explicit procedure_id and flips an approved procedure back to draft", async () => {
    const pid = await seedProposal({ name: "Versioned procedure", steps: ["one"] });
    const res1 = await applyProposal(env, pid, { actor: "user" });
    const procedureId = res1.procedure_id!;
    await env.BRAIN_DB.prepare(`UPDATE procedures SET status = 'approved' WHERE id = ?1`).bind(procedureId).run();

    const pid2 = await seedProposal({
      procedure_id: procedureId,
      name: "Versioned procedure",
      steps: ["one", "two", "three"],
    });
    const res2 = await applyProposal(env, pid2, { actor: "user" });
    expect(res2).toMatchObject({ procedure_id: procedureId, version: 2 });

    const proc = await procedureRow(procedureId);
    expect(proc).toMatchObject({ current_version: 2, status: "draft" }); // fresh approval required

    const versions = await versionRows(procedureId);
    expect(versions.results.map((v) => v.version)).toEqual([1, 2]);
    expect(JSON.parse(versions.results[0].steps)).toEqual(["one"]); // v1 intact
    expect(JSON.parse(versions.results[1].steps)).toEqual(["one", "two", "three"]);
  });

  it("appends a version by normalized name match when procedure_id is absent", async () => {
    const pid = await seedProposal({ name: "Name matched procedure", steps: ["a"] });
    const res1 = await applyProposal(env, pid, { actor: "user" });

    const pid2 = await seedProposal({ name: "  NAME MATCHED PROCEDURE ", steps: ["a", "b"] });
    const res2 = await applyProposal(env, pid2, { actor: "user" });
    expect(res2).toMatchObject({ procedure_id: res1.procedure_id, version: 2 });

    const proc = await procedureRow(res1.procedure_id!);
    expect(proc?.current_version).toBe(2);
  });

  it("refuses deprecated targets and invalid payloads", async () => {
    const pid = await seedProposal({ name: "Deprecated target", steps: ["x"] });
    const res = await applyProposal(env, pid, { actor: "user" });
    await env.BRAIN_DB.prepare(`UPDATE procedures SET status = 'deprecated' WHERE id = ?1`)
      .bind(res.procedure_id)
      .run();

    const pid2 = await seedProposal({ procedure_id: res.procedure_id, name: "Deprecated target", steps: ["y"] });
    await expect(applyProposal(env, pid2, { actor: "user" })).rejects.toMatchObject({ code: "conflict" });

    await expect(applyProposal(env, await seedProposal({ name: "Bad", steps: [] }), { actor: "user" })).rejects.toMatchObject(
      { code: "conflict" },
    );
    await expect(
      applyProposal(env, await seedProposal({ name: "", steps: ["ok"] }), { actor: "user" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      applyProposal(env, await seedProposal({ name: "Bad steps", steps: ["ok", "  "] }), { actor: "user" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("has no undo for procedure promotion (manual tier, append-only versions)", async () => {
    const pid = await seedProposal({ name: "No undo procedure", steps: ["x"] });
    await applyProposal(env, pid, { actor: "user" });
    await expect(undoProposal(env, pid, { actor: "user" })).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("procedure approval gate", () => {
  beforeEach(() => {
    installFakeVectorize();
  });

  const seedDraft = async (name: string): Promise<string> => {
    const pid = await seedProposal({ name, steps: ["step"] });
    const res = await applyProposal(env, pid, { actor: "user" });
    return res.procedure_id!;
  };

  it("approves a draft through the ADMIN route and audits it", async () => {
    const id = await seedDraft("Gate approve");
    const res = await call("POST", `/v1/procedures/${id}/approve`, undefined, bearer(env, "ADMIN"));
    expect(res.status).toBe(200);
    const body = await res.json<{ id: string; status: string }>();
    expect(body).toMatchObject({ id, status: "approved" });

    const row = await procedureRow(id);
    expect(row?.status).toBe("approved");
    const audit = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'approve_procedure' AND target_id = ?1`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("409s a second approval, a deprecated procedure, and 404s unknown ids", async () => {
    const id = await seedDraft("Gate conflicts");
    expect((await call("POST", `/v1/procedures/${id}/approve`, undefined, bearer(env, "ADMIN"))).status).toBe(200);
    const again = await call("POST", `/v1/procedures/${id}/approve`, undefined, bearer(env, "ADMIN"));
    expect(again.status).toBe(409);
    expect((await again.json<{ error: string }>()).error).toBe("conflict");

    await env.BRAIN_DB.prepare(`UPDATE procedures SET status = 'deprecated' WHERE id = ?1`).bind(id).run();
    expect((await call("POST", `/v1/procedures/${id}/approve`, undefined, bearer(env, "ADMIN"))).status).toBe(409);

    expect((await call("POST", `/v1/procedures/nope/approve`, undefined, bearer(env, "ADMIN"))).status).toBe(404);
  });

  it("never lets an agent token approve or apply (self-approval impossible)", async () => {
    const id = await seedDraft("Gate agent");
    for (const scope of ["MCP_READ", "MCP_PROPOSE"] as const) {
      expect((await call("POST", `/v1/procedures/${id}/approve`, undefined, bearer(env, scope))).status).toBe(403);
    }
    const row = await procedureRow(id);
    expect(row?.status).toBe("draft"); // untouched by the refused attempts

    const pid = await seedProposal({ name: "Agent apply attempt", steps: ["x"] });
    for (const scope of ["MCP_READ", "MCP_PROPOSE"] as const) {
      expect((await call("POST", `/v1/proposals/${pid}/apply`, undefined, bearer(env, scope))).status).toBe(403);
    }
    const proposal = await env.BRAIN_DB.prepare(`SELECT status FROM proposals WHERE id = ?1`)
      .bind(pid)
      .first<{ status: string }>();
    expect(proposal?.status).toBe("pending");
  });

  it("refuses external-evidence promotion through the REST apply with 400 untrusted_origin", async () => {
    const evExt = await seedEvent("external", 0.4);
    const pid = await seedProposal({ name: "External REST procedure", steps: ["x"] }, evExt);
    const res = await call("POST", `/v1/proposals/${pid}/apply`, undefined, bearer(env, "ADMIN"));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe("untrusted_origin");
  });
});

describe("procedure read routes", () => {
  beforeEach(() => {
    installFakeVectorize();
  });

  it("lists procedures and serves one with its full version history (newest first)", async () => {
    const pid = await seedProposal({ name: "Read route procedure", steps: ["v1 step"] });
    const res1 = await applyProposal(env, pid, { actor: "user" });
    const procedureId = res1.procedure_id!;
    const pid2 = await seedProposal({ procedure_id: procedureId, name: "Read route procedure", steps: ["v1 step", "v2 step"] });
    await applyProposal(env, pid2, { actor: "user" });

    const list = await call("GET", "/v1/procedures", undefined, bearer(env, "MCP_READ"));
    expect(list.status).toBe(200);
    const listed = (await list.json<{ procedures: Array<{ id: string; current_version: number }> }>()).procedures;
    const entry = listed.find((p) => p.id === procedureId);
    expect(entry?.current_version).toBe(2);

    const detail = await call("GET", `/v1/procedures/${procedureId}`, undefined, bearer(env, "MCP_READ"));
    expect(detail.status).toBe(200);
    const body = await detail.json<{
      procedure: { id: string; status: string; current_version: number };
      versions: Array<{ version: number; steps: string }>;
    }>();
    expect(body.procedure).toMatchObject({ id: procedureId, status: "draft", current_version: 2 });
    expect(body.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(JSON.parse(body.versions[1].steps)).toEqual(["v1 step"]); // v1 intact

    expect((await call("GET", "/v1/procedures/nope", undefined, bearer(env, "MCP_READ"))).status).toBe(404);
    expect((await call("GET", "/v1/procedures", undefined, bearer(env, "MCP_PROPOSE"))).status).toBe(403);
  });
});
