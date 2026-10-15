import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { applyProposal, undoProposal } from "../src/review";
import { installFakeVectorize } from "./helpers";

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
