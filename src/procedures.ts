import { writeAudit } from "./audit";
import { newEventId } from "./crypto";
import type { Env } from "./env";
import { ReviewError, type ReviewActor } from "./review";

/** Procedural memory (design §8 phase 5). Procedure proposals land through the
 *  review engine (always manual); promotion creates or versions a procedure.
 *  Trust on origin is enforced here: external-origin evidence is never
 *  promotable. The approval gate itself is an ADMIN-only REST route — never an
 *  MCP tool — so the agent surface cannot self-approve. */

export interface ProcedurePayload {
  name: string;
  steps: string[];
  trigger: string | null;
  tools: string[] | null;
  success_criteria: string | null;
  failure_notes: string | null;
  procedure_id: string | null;
}

const LIMITS = { name: 120, steps: 50, step: 500, trigger: 2000, tools: 50, criteria: 2000, notes: 2000 };

const invalid = (why: string): ReviewError => new ReviewError("conflict", `procedure payload invalid: ${why}`);

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  const t = value.trim();
  if (t.length === 0 || t.length > max) throw invalid(`${field} out of range`);
  return t;
}

export function parseProcedurePayload(payload: unknown): ProcedurePayload {
  if (typeof payload !== "object" || payload === null) throw invalid("not an object");
  const p = payload as Record<string, unknown>;

  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (name.length === 0 || name.length > LIMITS.name) throw invalid("name out of range");

  if (!Array.isArray(p.steps) || p.steps.length < 1 || p.steps.length > LIMITS.steps) throw invalid("steps out of range");
  const steps = p.steps.map((s) => (typeof s === "string" ? s.trim() : ""));
  if (steps.some((s) => s.length === 0 || s.length > LIMITS.step)) throw invalid("step entries out of range");

  let tools: string[] | null = null;
  if (p.tools !== undefined && p.tools !== null) {
    if (!Array.isArray(p.tools) || p.tools.length < 1 || p.tools.length > LIMITS.tools) throw invalid("tools out of range");
    tools = p.tools.map((t) => (typeof t === "string" ? t.trim() : ""));
    if (tools.some((t) => t.length === 0)) throw invalid("tool entries out of range");
  }

  let procedureId: string | null = null;
  if (p.procedure_id !== undefined && p.procedure_id !== null) {
    if (typeof p.procedure_id !== "string" || p.procedure_id.trim() === "") throw invalid("procedure_id");
    procedureId = p.procedure_id.trim();
  }

  return {
    name,
    steps,
    tools,
    procedure_id: procedureId,
    trigger: optionalText(p.trigger, "trigger", LIMITS.trigger),
    success_criteria: optionalText(p.success_criteria, "success_criteria", LIMITS.criteria),
    failure_notes: optionalText(p.failure_notes, "failure_notes", LIMITS.notes),
  };
}

export interface ProcedureProposalRow {
  id: string;
  payload_json: string;
  evidence_event_id: string | null;
}

export interface PromotionResult {
  procedure_id: string;
  version: number;
}

/** Promotion gate (apply side): create draft v1 or append v N+1. Any new
 *  version flips an approved procedure back to draft — every version needs a
 *  fresh human approval. External-origin evidence refuses before any write. */
export async function promoteProcedureProposal(
  env: Env,
  row: ProcedureProposalRow,
  opts: { now: number; actor: ReviewActor; reason: string },
): Promise<PromotionResult> {
  const db = env.BRAIN_DB;
  let raw: unknown = {};
  try {
    raw = JSON.parse(row.payload_json || "{}");
  } catch {
    throw invalid("json");
  }
  const payload = parseProcedurePayload(raw);

  let originTrust = 0.5; // no evidence: neutral, conservative — the human gate still applies
  if (row.evidence_event_id) {
    const ev = await db
      .prepare(`SELECT actor, trust FROM events WHERE id = ?1`)
      .bind(row.evidence_event_id)
      .first<{ actor: string; trust: number }>();
    if (!ev) throw new ReviewError("conflict", "procedure evidence event not found");
    if (ev.actor === "external") {
      throw new ReviewError("untrusted_origin", "procedures are never promoted from external-origin evidence");
    }
    originTrust = ev.trust;
  }

  let target: { id: string; status: string; current_version: number } | null = null;
  if (payload.procedure_id) {
    target = await db
      .prepare(`SELECT id, status, current_version FROM procedures WHERE id = ?1`)
      .bind(payload.procedure_id)
      .first<{ id: string; status: string; current_version: number }>();
    if (!target) throw new ReviewError("not_found", "target procedure not found");
  } else {
    target = await db
      .prepare(`SELECT id, status, current_version FROM procedures WHERE lower(trim(name)) = lower(trim(?1))`)
      .bind(payload.name)
      .first<{ id: string; status: string; current_version: number }>();
  }
  if (target?.status === "deprecated") throw new ReviewError("conflict", "procedure is deprecated");

  const insertVersion = (procedureId: string, version: number) =>
    db
      .prepare(
        `INSERT INTO procedure_versions (id, procedure_id, version, trigger, steps, tools, success_criteria, failure_notes, promoted_from_events, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        newEventId(),
        procedureId,
        version,
        payload.trigger,
        JSON.stringify(payload.steps),
        payload.tools ? JSON.stringify(payload.tools) : null,
        payload.success_criteria,
        payload.failure_notes,
        row.evidence_event_id ? JSON.stringify([row.evidence_event_id]) : null,
        opts.now,
      )
      .run();

  if (!target) {
    const procedureId = newEventId();
    await db
      .prepare(`INSERT INTO procedures (id, name, current_version, status, origin_trust, created_at) VALUES (?1, ?2, 1, 'draft', ?3, ?4)`)
      .bind(procedureId, payload.name, originTrust, opts.now)
      .run();
    await insertVersion(procedureId, 1);
    await writeAudit(db, {
      actor: opts.actor,
      action: "approve",
      targetType: "procedure",
      targetId: procedureId,
      after: { version: 1, status: "draft", origin_trust: originTrust, proposal_id: row.id },
      reason: opts.reason,
    });
    return { procedure_id: procedureId, version: 1 };
  }

  const version = target.current_version + 1;
  await db
    .prepare(`UPDATE procedures SET name = ?1, current_version = ?2, status = 'draft' WHERE id = ?3`)
    .bind(payload.name, version, target.id)
    .run();
  await insertVersion(target.id, version);
  await writeAudit(db, {
    actor: opts.actor,
    action: "approve",
    targetType: "procedure",
    targetId: target.id,
    before: { status: target.status, current_version: target.current_version },
    after: { status: "draft", version, origin_trust: originTrust, proposal_id: row.id },
    reason: opts.reason,
  });
  return { procedure_id: target.id, version };
}
