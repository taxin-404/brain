import { writeAudit } from "./audit";
import { BLOCK_KEYS } from "./blocks";
import type { Env, Scope } from "./env";
import { createFact, deleteFactVector, disputeFact, purgeFact, supersedeFact } from "./factstore";
import { normalizeObjectText } from "./facts";
import { closeFactEdges } from "./graph";
import { json } from "./http";
// Function-level cycle with proposals.ts (proposals imports applyProposal —
// runs post-load only; see the note in proposals.ts).
import { createProposal, ProposalError } from "./proposals";
import { consumeConfirmToken, PurgeError, purgeEventCore } from "./purge";
import { promoteProcedureProposal } from "./procedures";

/** The Phase-3 truth engine: reviewing a proposal applies it for real.
 *  Corrections supersede (soft, reversible via `undo`); forgets purge (fact =
 *  null object text, event = crypto-shred — irreversible by construction);
 *  disputes mark; block edits write blocks. Every apply writes an `approve`
 *  audit row carrying before/after so `undo` can reverse it. */

export type ReviewActor = "user" | "system";

export class ReviewError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "not_pending"
      | "not_applied"
      | "irreversible"
      | "invalid_token"
      | "conflict"
      | "unsupported"
      | "untrusted_origin",
    message: string,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

interface ProposalRow {
  id: string;
  kind: string;
  payload_json: string;
  target_type: string | null;
  target_id: string | null;
  evidence_event_id: string | null;
  sensitivity: string;
  review_mode: string;
  status: string;
  undone_at: number | null;
}

export async function loadProposal(env: Env, proposalId: string): Promise<ProposalRow> {
  const row = await env.BRAIN_DB.prepare(
    `SELECT id, kind, payload_json, target_type, target_id, evidence_event_id, sensitivity,
            review_mode, status, undone_at
     FROM proposals WHERE id = ?1`,
  )
    .bind(proposalId)
    .first<ProposalRow>();
  if (!row) throw new ReviewError("not_found", "proposal not found");
  return row;
}

function parsePayload(row: ProposalRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, unknown>;
  } catch {
    throw new ReviewError("conflict", "proposal payload is not valid JSON");
  }
}

/** Correction apply: build the replacement fact (user_stated 0.9, sensitivity
 *  inherited, evidence ?? old source), copy the old fact's source links, then
 *  supersede. Returns both ids for the approve audit row. */
export async function createFactFromCorrection(
  env: Env,
  proposalId: string,
  opts: { actor: ReviewActor; now?: number },
): Promise<{ newFactId: string; oldFactId: string }> {
  const row = await loadProposal(env, proposalId);
  const payload = parsePayload(row);
  const factId = row.target_id ?? (typeof payload.fact_id === "string" ? payload.fact_id : null);
  const correction = typeof payload.correction === "string" ? payload.correction : null;
  if (!factId || !correction || correction.trim() === "") {
    throw new ReviewError("conflict", "correction payload invalid");
  }

  const db = env.BRAIN_DB;
  const old = await db
    .prepare(
      `SELECT id, subject_id, predicate, status, sensitivity, source_event_id FROM facts WHERE id = ?1`,
    )
    .bind(factId)
    .first<{
      id: string;
      subject_id: string;
      predicate: string;
      status: string;
      sensitivity: string;
      source_event_id: string;
    }>();
  if (!old) throw new ReviewError("not_found", "target fact not found");
  if (old.status !== "active") throw new ReviewError("conflict", "target fact is not active");

  const subject = await db.prepare(`SELECT name FROM entities WHERE id = ?1`).bind(old.subject_id).first<{ name: string }>();
  const now = opts.now ?? Date.now();

  const newFactId = await createFact(env, {
    subjectId: old.subject_id,
    subjectName: subject?.name ?? old.subject_id,
    predicate: old.predicate,
    objectText: normalizeObjectText(correction),
    factKind: "user_stated",
    confidence: 0.9,
    sensitivity: old.sensitivity,
    sourceEventId: row.evidence_event_id ?? old.source_event_id,
    validAt: now,
    now,
  });

  // The old fact's evidence supports the corrected claim too.
  await db
    .prepare(`INSERT OR IGNORE INTO fact_sources (fact_id, event_id) SELECT ?1, event_id FROM fact_sources WHERE fact_id = ?2`)
    .bind(newFactId, old.id)
    .run();

  await supersedeFact(env, old.id, newFactId, now, opts.actor);
  return { newFactId, oldFactId: old.id };
}

export interface ApplyOptions {
  actor: ReviewActor;
  confirmToken?: string;
  reason?: string;
  now?: number;
}

/** Apply a pending proposal. Throws ReviewError for every refusal; the row is
 *  only flipped to `applied` after all writes succeed. */
export async function applyProposal(
  env: Env,
  proposalId: string,
  opts: ApplyOptions,
): Promise<{ applied: true; kind: string; procedure_id?: string; version?: number }> {
  const row = await loadProposal(env, proposalId);
  if (row.status !== "pending") throw new ReviewError("not_pending", "proposal is not pending");

  const db = env.BRAIN_DB;
  const now = opts.now ?? Date.now();
  const reason = opts.reason ?? "";
  let promoted: { procedure_id: string; version: number } | null = null;

  if (row.kind === "correction") {
    const { newFactId, oldFactId } = await createFactFromCorrection(env, proposalId, { actor: opts.actor, now });
    await writeAudit(db, {
      actor: opts.actor,
      action: "approve",
      targetType: "proposal",
      targetId: proposalId,
      before: { fact_id: oldFactId },
      after: { new_fact_id: newFactId },
      reason,
    });
  } else if (row.kind === "dispute") {
    const targetId = row.target_id;
    if (!targetId) throw new ReviewError("conflict", "dispute proposal has no target");
    const fact = await db.prepare(`SELECT status FROM facts WHERE id = ?1`).bind(targetId).first<{ status: string }>();
    if (!fact) throw new ReviewError("not_found", "target fact not found");
    if (fact.status !== "active") throw new ReviewError("conflict", "target fact is not active");
    await disputeFact(env, targetId, now);
    await writeAudit(db, {
      actor: opts.actor,
      action: "approve",
      targetType: "proposal",
      targetId: proposalId,
      before: { fact_id: targetId, status: "active" },
      after: { status: "disputed" },
      reason,
    });
  } else if (row.kind === "forget") {
    const targetType = row.target_type ?? "fact";
    const targetId = row.target_id;
    if (!targetId) throw new ReviewError("conflict", "forget proposal has no target");
    if (!opts.confirmToken) throw new ReviewError("invalid_token", "confirm_token required for forget");
    try {
      await consumeConfirmToken(env, `${targetType}:${targetId}`, opts.confirmToken);
    } catch (err) {
      if (err instanceof PurgeError) throw new ReviewError("invalid_token", err.message);
      throw err;
    }
    if (targetType === "fact") {
      const fact = await db.prepare(`SELECT id FROM facts WHERE id = ?1`).bind(targetId).first<{ id: string }>();
      if (!fact) throw new ReviewError("not_found", "target fact not found");
      await purgeFact(env, targetId, { actor: opts.actor, now });
    } else if (targetType === "event") {
      await purgeEventCore(env, targetId, reason || "forget proposal", opts.actor);
    } else {
      throw new ReviewError("conflict", `unsupported forget target: ${targetType}`);
    }
    await writeAudit(db, {
      actor: opts.actor,
      action: "approve",
      targetType: "proposal",
      targetId: proposalId,
      before: { target_type: targetType, target_id: targetId },
      after: { purged: true },
      reason,
    });
  } else if (row.kind === "block_edit") {
    const payload = parsePayload(row);
    const key = typeof payload.key === "string" ? payload.key : null;
    const value = typeof payload.value === "string" ? payload.value : null;
    if (!key || !(BLOCK_KEYS as readonly string[]).includes(key) || value === null || value.trim() === "") {
      throw new ReviewError("conflict", "block_edit payload invalid");
    }
    const before = await db.prepare(`SELECT value FROM blocks WHERE key = ?1`).bind(key).first<{ value: string }>();
    await db
      .prepare(
        `INSERT INTO blocks (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value, now)
      .run();
    await writeAudit(db, {
      actor: opts.actor,
      action: "approve",
      targetType: "proposal",
      targetId: proposalId,
      before: { key, value: before?.value ?? null },
      after: { key, value },
      reason,
    });
  } else if (row.kind === "procedure") {
    promoted = await promoteProcedureProposal(env, row, { now, actor: opts.actor, reason });
  } else {
    throw new ReviewError("conflict", `unknown proposal kind: ${row.kind}`);
  }

  await db
    .prepare(`UPDATE proposals SET status = 'applied', applied_at = ?1, applied_by = ?2 WHERE id = ?3`)
    .bind(now, opts.actor, proposalId)
    .run();
  return { applied: true, kind: row.kind, ...(promoted ? { procedure_id: promoted.procedure_id, version: promoted.version } : {}) };
}

/** Discard a pending proposal (nothing is written besides status + audit). */
export async function discardProposal(
  env: Env,
  proposalId: string,
  opts: { actor?: ReviewActor; reason?: string } = {},
): Promise<void> {
  const row = await loadProposal(env, proposalId);
  if (row.status !== "pending") throw new ReviewError("not_pending", "proposal is not pending");
  await env.BRAIN_DB.prepare(`UPDATE proposals SET status = 'discarded' WHERE id = ?1`).bind(proposalId).run();
  await writeAudit(env.BRAIN_DB, {
    actor: opts.actor ?? "user",
    action: "discard",
    targetType: "proposal",
    targetId: proposalId,
    reason: opts.reason ?? "",
  });
}

/** Undo an applied proposal. Corrections restore the old fact and archive the
 *  replacement; disputes restore active; block edits restore the recorded
 *  before value. Forgets are irreversible by construction (crypto-shred). */
export async function undoProposal(
  env: Env,
  proposalId: string,
  opts: { actor?: ReviewActor; now?: number } = {},
): Promise<void> {
  const row = await loadProposal(env, proposalId);
  if (row.status !== "applied" || row.undone_at !== null) {
    throw new ReviewError("not_applied", "proposal has not been applied");
  }
  if (row.kind === "forget") throw new ReviewError("irreversible", "purges cannot be undone");
  if (row.kind === "procedure") {
    throw new ReviewError("unsupported", "procedure promotion has no undo (versions are append-only)");
  }

  const db = env.BRAIN_DB;
  const now = opts.now ?? Date.now();

  if (row.kind === "correction") {
    const oldFactId = row.target_id;
    if (!oldFactId) throw new ReviewError("conflict", "correction proposal has no target");
    const old = await db
      .prepare(`SELECT subject_id, predicate, object_entity_id, superseded_by FROM facts WHERE id = ?1`)
      .bind(oldFactId)
      .first<{ subject_id: string; predicate: string; object_entity_id: string | null; superseded_by: string | null }>();
    const newFactId = old?.superseded_by ?? null;

    await db
      .prepare(`UPDATE facts SET status = 'active', superseded_by = NULL, invalid_at = NULL WHERE id = ?1 AND status = 'superseded'`)
      .bind(oldFactId)
      .run();

    if (newFactId) {
      const nf = await db
        .prepare(`SELECT subject_id, predicate, object_entity_id FROM facts WHERE id = ?1`)
        .bind(newFactId)
        .first<{ subject_id: string; predicate: string; object_entity_id: string | null }>();
      await db.prepare(`UPDATE facts SET status = 'archived' WHERE id = ?1`).bind(newFactId).run();
      if (nf?.object_entity_id) {
        await closeFactEdges(env, { subjectId: nf.subject_id, predicate: nf.predicate, objectEntityId: nf.object_entity_id }, now);
      }
      await deleteFactVector(env, newFactId);
    }
    if (old?.object_entity_id) {
      // reopen the relation supersession closed (edges carry no fact id, so
      // this targets the subject+predicate+object triple)
      await db
        .prepare(`UPDATE edges SET invalid_at = NULL WHERE src = ?1 AND dst = ?2 AND rel = ?3 AND invalid_at IS NOT NULL`)
        .bind(old.subject_id, old.object_entity_id, old.predicate)
        .run();
    }
  } else if (row.kind === "dispute") {
    if (row.target_id) {
      await db.prepare(`UPDATE facts SET status = 'active' WHERE id = ?1 AND status = 'disputed'`).bind(row.target_id).run();
    }
  } else if (row.kind === "block_edit") {
    const aud = await db
      .prepare(
        `SELECT before_json FROM audit_log WHERE target_type = 'proposal' AND target_id = ?1 AND action = 'approve'
         ORDER BY ts DESC, rowid DESC LIMIT 1`,
      )
      .bind(proposalId)
      .first<{ before_json: string | null }>();
    const before = aud?.before_json ? (JSON.parse(aud.before_json) as { key?: string; value?: string | null }) : null;
    if (before?.key) {
      if (before.value === null || before.value === undefined) {
        await db.prepare(`DELETE FROM blocks WHERE key = ?1`).bind(before.key).run();
      } else {
        await db
          .prepare(
            `INSERT INTO blocks (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind(before.key, before.value, now)
          .run();
      }
    }
  } else {
    throw new ReviewError("unsupported", `cannot undo kind: ${row.kind}`);
  }

  await db.prepare(`UPDATE proposals SET undone_at = ?1 WHERE id = ?2`).bind(now, proposalId).run();
  await writeAudit(db, {
    actor: opts.actor ?? "user",
    action: "undo",
    targetType: "proposal",
    targetId: proposalId,
    before: { kind: row.kind },
    after: { undone: true },
  });
}

/** ProposalError → HTTP, shared by the fact-review handlers. */
function proposalErrorResponse(err: ProposalError): Response {
  return json({ error: err.code, message: err.message }, err.code === "over_limit" ? 429 : 503);
}

/** POST /v1/facts/:id/{correct|dispute|purge} (admin) — each verb lands a
 *  proposal; the tier rules may have already applied it. */
export async function handleFactReview(
  request: Request,
  env: Env,
  scope: Scope,
  factId: string,
  verb: string,
): Promise<Response> {
  const fact = await env.BRAIN_DB.prepare(`SELECT sensitivity FROM facts WHERE id = ?1`)
    .bind(factId)
    .first<{ sensitivity: string }>();
  if (!fact) return json({ error: "not_found", message: "fact not found" }, 404);

  const body = (await request.json().catch(() => null)) as
    | { correction?: unknown; evidence_event_id?: unknown; reason?: unknown }
    | null;
  const reason = typeof body?.reason === "string" ? body.reason : undefined;
  const evidence = typeof body?.evidence_event_id === "string" ? body.evidence_event_id : undefined;

  try {
    let res;
    if (verb === "correct") {
      if (typeof body?.correction !== "string" || body.correction.trim() === "") {
        return json({ error: "bad_request", message: "correction required" }, 400);
      }
      res = await createProposal(env, scope, {
        kind: "correction",
        payload: { fact_id: factId, correction: body.correction, ...(reason ? { reason } : {}) },
        target_type: "fact",
        target_id: factId,
        evidence_event_id: evidence,
        sensitivity: fact.sensitivity,
      });
    } else if (verb === "dispute") {
      res = await createProposal(env, scope, {
        kind: "dispute",
        payload: { ...(reason ? { reason } : {}) },
        target_type: "fact",
        target_id: factId,
        sensitivity: fact.sensitivity,
      });
    } else if (verb === "purge") {
      res = await createProposal(env, scope, {
        kind: "forget",
        payload: { target_type: "fact", target_id: factId, ...(reason ? { reason } : {}) },
        target_type: "fact",
        target_id: factId,
        sensitivity: fact.sensitivity,
      });
    } else {
      return json({ error: "not_found", message: `unknown fact verb: ${verb}` }, 404);
    }
    return json(
      { proposal_id: res.id, review_mode: res.review_mode, applied: res.applied, ...(res.error ? { error: res.error } : {}) },
      201,
    );
  } catch (err) {
    if (err instanceof ProposalError) return proposalErrorResponse(err);
    throw err;
  }
}

/** POST /v1/proposals/:id/{apply|discard|undo} (admin). Forget applies need a
 *  confirm token minted for `fact:{id}` / `event:{id}`; purges are irreversible. */
export async function handleProposalReview(
  request: Request,
  env: Env,
  _scope: Scope,
  proposalId: string,
  verb: string,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { confirm_token?: unknown; reason?: unknown } | null;
  const reason = typeof body?.reason === "string" ? body.reason : undefined;
  const confirmToken = typeof body?.confirm_token === "string" ? body.confirm_token : undefined;
  try {
    if (verb === "apply") {
      return json(await applyProposal(env, proposalId, { actor: "user", confirmToken, reason }));
    }
    if (verb === "discard") {
      await discardProposal(env, proposalId, { actor: "user", reason });
      return json({ discarded: true });
    }
    if (verb === "undo") {
      await undoProposal(env, proposalId, { actor: "user" });
      return json({ undone: true });
    }
    return json({ error: "not_found", message: `unknown proposal verb: ${verb}` }, 404);
  } catch (err) {
    if (err instanceof ReviewError) {
      const status =
        err.code === "not_found" ? 404 : err.code === "irreversible" ? 409 : err.code === "unsupported" ? 501 : 400;
      return json({ error: err.code, message: err.message }, status);
    }
    throw err;
  }
}
