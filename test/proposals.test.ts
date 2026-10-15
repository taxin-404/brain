import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import type { Scope } from "../src/env";
import { computeReviewMode, createProposal, expireProposals, PROPOSAL_TTL_MS } from "../src/proposals";
import { bearer, call, seedFact } from "./helpers";

const send = (body: unknown, headers: Record<string, string>) =>
  exports.default.fetch("https://brain.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });

function parseMcp(text: string): any {
  if (text.startsWith("event:") || text.startsWith("data:"))
    return JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""));
  return JSON.parse(text);
}

async function callTool(scope: Scope, name: string, args: unknown = {}) {
  const hdrs = bearer(env, scope);
  const init = await send(
    { jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    hdrs,
  );
  const sessionId = init.headers.get("mcp-session-id");
  const withSession = sessionId ? { ...hdrs, "mcp-session-id": sessionId } : hdrs;
  await send({ jsonrpc: "2.0", method: "notifications/initialized" }, withSession);
  const res = await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, withSession);
  const body = parseMcp(await res.text());
  return { text: body.result?.content?.[0]?.text as string | undefined, isError: body.result?.isError === true };
}

interface ProposalRowDb {
  id: string;
  kind: string;
  payload_json: string;
  target_type: string | null;
  target_id: string | null;
  evidence_event_id: string | null;
  sensitivity: string;
  review_mode: string;
  status: string;
  created_at: number;
  expires_at: number;
}

const getProposal = (id: string) =>
  env.BRAIN_DB.prepare(
    `SELECT id, kind, payload_json, target_type, target_id, evidence_event_id, sensitivity, review_mode,
            status, created_at, expires_at
     FROM proposals WHERE id = ?1`,
  )
    .bind(id)
    .first<ProposalRowDb>();

const budget = async (scope: string) =>
  (await env.BRAIN_DB.prepare(`SELECT rows_written FROM rate_budgets WHERE scope = ?1`)
    .bind(scope)
    .first<{ rows_written: number }>())?.rows_written ?? 0;

const seedEvidence = async (text: string) => {
  const res = await call(
    "POST",
    "/v1/events",
    { source: "manual", actor: "user", kind: "note", payload: { text } },
    bearer(env, "MCP_PROPOSE"),
  );
  return (await res.json<{ results: Array<{ id: string }> }>()).results[0].id;
};

const insertProposal = (id: string, status: string, createdAt: number) =>
  env.BRAIN_DB.prepare(
    `INSERT INTO proposals (id, kind, payload_json, target_type, target_id, evidence_event_id, sensitivity,
                            review_mode, status, created_at, expires_at)
     VALUES (?1, 'forget', '{"note":"seeded"}', NULL, NULL, NULL, 'normal', 'manual', ?2, ?3, ?4)`,
  )
    .bind(id, status, createdAt, createdAt + PROPOSAL_TTL_MS)
    .run();

describe("computeReviewMode", () => {
  it("auto only for user-evidenced normal-fact corrections", () => {
    expect(computeReviewMode("correction", "normal", "user")).toBe("auto");
    expect(computeReviewMode("correction", "normal", null)).toBe("manual");
    expect(computeReviewMode("correction", "normal", "assistant")).toBe("manual");
    expect(computeReviewMode("correction", "sensitive", "user")).toBe("manual");
    expect(computeReviewMode("correction", "restricted", "user")).toBe("manual");
    expect(computeReviewMode("correction", null, "user")).toBe("manual");
    expect(computeReviewMode("forget", "normal", "user")).toBe("manual");
    expect(computeReviewMode("block_edit", "normal", "user")).toBe("manual");
    expect(computeReviewMode("procedure", "normal", "user")).toBe("manual");
    // dispute is always auto for normal facts; the sensitive carve-out keeps it manual
    expect(computeReviewMode("dispute", "normal", null)).toBe("auto");
    expect(computeReviewMode("dispute", "normal", "assistant")).toBe("auto");
    expect(computeReviewMode("dispute", "sensitive", "user")).toBe("manual");
    expect(computeReviewMode("dispute", "restricted", "user")).toBe("manual");
  });
});

describe("createProposal", () => {
  it("charges exactly one propose row, writes the audit trail, and expires after 14 days", async () => {
    const before = await budget("MCP_PROPOSE");
    const { id } = await createProposal(env, "MCP_PROPOSE", {
      kind: "forget",
      payload: { target_type: "event", target_id: "e" },
    });
    expect((await budget("MCP_PROPOSE")) - before).toBe(1);

    const p = await getProposal(id);
    expect(p?.status).toBe("pending");
    expect(p?.review_mode).toBe("manual");
    expect((p?.expires_at ?? 0) - (p?.created_at ?? 0)).toBe(PROPOSAL_TTL_MS);
    expect(JSON.parse(p!.payload_json)).toEqual({ target_type: "event", target_id: "e" });

    const audit = await env.BRAIN_DB.prepare(
      `SELECT actor, action FROM audit_log WHERE target_type = 'proposal' AND target_id = ?1`,
    )
      .bind(id)
      .first<{ actor: string; action: string }>();
    expect(audit).toEqual({ actor: "agent", action: "create" });

    const asUser = await createProposal(env, "ADMIN", { kind: "forget", payload: {} });
    const auditAdmin = await env.BRAIN_DB.prepare(
      `SELECT actor FROM audit_log WHERE target_type = 'proposal' AND target_id = ?1`,
    )
      .bind(asUser.id)
      .first<{ actor: string }>();
    expect(auditAdmin?.actor).toBe("user");
  });

  it("computes the tier from kind, stored sensitivity and evidence actor", async () => {
    const eventId = await seedEvidence("correction evidence");

    const auto = await createProposal(env, "MCP_PROPOSE", { kind: "correction", payload: {}, evidence_event_id: eventId });
    expect((await getProposal(auto.id))?.review_mode).toBe("auto");

    const noEvidence = await createProposal(env, "MCP_PROPOSE", { kind: "correction", payload: {} });
    expect((await getProposal(noEvidence.id))?.review_mode).toBe("manual");

    const sensitive = await createProposal(env, "MCP_PROPOSE", {
      kind: "correction",
      payload: {},
      evidence_event_id: eventId,
      sensitivity: "sensitive",
    });
    expect((await getProposal(sensitive.id))?.review_mode).toBe("manual");

    const assistantRes = await call(
      "POST",
      "/v1/events",
      { source: "manual", actor: "assistant", kind: "note", payload: { text: "assistant evidence" } },
      bearer(env, "MCP_PROPOSE"),
    );
    const assistantEvent = (await assistantRes.json<{ results: Array<{ id: string }> }>()).results[0].id;
    const toolEvidence = await createProposal(env, "MCP_PROPOSE", {
      kind: "correction",
      payload: {},
      evidence_event_id: assistantEvent,
    });
    expect((await getProposal(toolEvidence.id))?.review_mode).toBe("manual");
  });
});

describe("MCP propose tools", () => {
  it("require propose scope on all four", async () => {
    const before = await budget("MCP_PROPOSE");
    const calls = [
      ["propose_correction", { fact_id: "x", correction: "y" }],
      ["propose_forget", { target_type: "event", target_id: "x" }],
      ["propose_block_edit", { key: "identity", value: "z" }],
      ["propose_procedure", { name: "n", steps: ["s"] }],
    ] as const;
    for (const [name, args] of calls) {
      const r = await callTool("MCP_READ", name, args);
      expect(r.isError).toBe(true);
      expect(r.text).toBe("MCP_PROPOSE scope required");
    }
    expect(await budget("MCP_PROPOSE")).toBe(before);
  });

  it("propose_correction errors on a missing fact and auto-applies with user evidence", async () => {
    const missing = await callTool("MCP_PROPOSE", "propose_correction", { fact_id: "nope", correction: "c" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe("fact not found");

    const factId = await seedFact({ name: "proposal-fact", predicate: "prefers", object: "old value" });
    const eventId = await seedEvidence("the user changed their mind");
    const ok = await callTool("MCP_PROPOSE", "propose_correction", {
      fact_id: factId,
      correction: "new value",
      evidence_event_id: eventId,
    });
    expect(ok.isError).toBe(false);
    const { id, applied } = JSON.parse(ok.text!) as { created: boolean; id: string; applied: boolean };
    expect(applied).toBe(true);

    const p = await getProposal(id);
    expect(p).toMatchObject({
      kind: "correction",
      target_type: "fact",
      target_id: factId,
      evidence_event_id: eventId,
      sensitivity: "normal",
      review_mode: "auto",
      status: "applied",
    });
    expect(JSON.parse(p!.payload_json)).toEqual({ fact_id: factId, correction: "new value" });

    // the auto tier applied it: the old fact is superseded by the corrected one
    const old = await env.BRAIN_DB.prepare(`SELECT status, superseded_by FROM facts WHERE id = ?1`)
      .bind(factId)
      .first<{ status: string; superseded_by: string | null }>();
    expect(old?.status).toBe("superseded");
    const nf = await env.BRAIN_DB.prepare(`SELECT object_text FROM facts WHERE id = ?1`)
      .bind(old?.superseded_by)
      .first<{ object_text: string }>();
    expect(nf?.object_text).toBe("new value");
  });

  it("forget, block_edit and procedure always land manual", async () => {
    const eventId = await seedEvidence("forget evidence");

    const forget = JSON.parse((await callTool("MCP_PROPOSE", "propose_forget", {
      target_type: "event",
      target_id: eventId,
      reason: "stale",
    })).text!) as { id: string };
    expect(await getProposal(forget.id)).toMatchObject({
      kind: "forget",
      target_type: "event",
      target_id: eventId,
      review_mode: "manual",
    });

    const block = JSON.parse((await callTool("MCP_PROPOSE", "propose_block_edit", {
      key: "identity",
      value: "new identity",
    })).text!) as { id: string };
    expect(await getProposal(block.id)).toMatchObject({
      kind: "block_edit",
      target_type: "block",
      target_id: "identity",
      review_mode: "manual",
    });

    const proc = JSON.parse((await callTool("MCP_PROPOSE", "propose_procedure", {
      name: "deploy brain",
      steps: ["test", "deploy"],
    })).text!) as { id: string };
    expect(await getProposal(proc.id)).toMatchObject({
      kind: "procedure",
      target_type: "procedure",
      review_mode: "manual",
    });
  });
});

describe("GET /v1/proposals", () => {
  it("defaults to pending, newest first, filters by status and caps the limit", async () => {
    const t0 = Date.now() - 600_000;
    const oldId = newEventId();
    const newId = newEventId();
    const appliedId = newEventId();
    await insertProposal(oldId, "pending", t0);
    await insertProposal(newId, "pending", t0 + 1000);
    await insertProposal(appliedId, "applied", t0 + 2000);

    const res = await call("GET", "/v1/proposals", undefined, bearer(env, "MCP_READ"));
    expect(res.status).toBe(200);
    const body = await res.json<{ proposals: Array<{ id: string; status: string; payload: unknown }> }>();
    expect(body.proposals.every((p) => p.status === "pending")).toBe(true);
    const iOld = body.proposals.findIndex((p) => p.id === oldId);
    const iNew = body.proposals.findIndex((p) => p.id === newId);
    expect(iOld).toBeGreaterThanOrEqual(0);
    expect(iNew).toBeGreaterThanOrEqual(0);
    expect(iNew).toBeLessThan(iOld); // newest first
    expect(body.proposals.some((p) => p.id === appliedId)).toBe(false);
    expect(body.proposals.find((p) => p.id === newId)?.payload).toEqual({ note: "seeded" });

    const applied = await call("GET", "/v1/proposals?status=applied", undefined, bearer(env, "MCP_READ"));
    // other tests may have auto-applied proposals in the shared DB; assert the
    // filter semantics (all applied, seeded one present) rather than exact set
    const appliedBody = await applied.json<{ proposals: Array<{ id: string; status: string }> }>();
    expect(appliedBody.proposals.every((p) => p.status === "applied")).toBe(true);
    expect(appliedBody.proposals.map((p) => p.id)).toContain(appliedId);

    const limited = await call("GET", "/v1/proposals?limit=1", undefined, bearer(env, "MCP_READ"));
    expect((await limited.json<{ proposals: unknown[] }>()).proposals).toHaveLength(1);
    expect((await call("GET", "/v1/proposals")).status).toBe(401);
  });

  it("expireProposals retires only lapsed pending rows", async () => {
    const id = newEventId();
    await insertProposal(id, "pending", Date.now() - 15 * 86_400_000); // expires one day ago

    const n = await expireProposals(env);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await getProposal(id))?.status).toBe("expired");
    expect(await expireProposals(env)).toBe(0);
  });
});
