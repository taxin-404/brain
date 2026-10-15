import { writeAudit } from "./audit";
import { BLOCK_KEYS } from "./blocks";
import type { Env } from "./env";
import { createFact, deleteFactVector, disputeFact, purgeFact, supersedeFact } from "./factstore";
import { normalizeObjectText } from "./facts";
import { closeFactEdges } from "./graph";
import { consumeConfirmToken, PurgeError, purgeEventCore } from "./purge";

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
      | "unsupported",
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
): Promise<{ applied: true; kind: string }> {
  const row = await loadProposal(env, proposalId);
  if (row.status !== "pending") throw new ReviewError("not_pending", "proposal is not pending");

  const db = env.BRAIN_DB;
  const now = opts.now ?? Date.now();
  const reason = opts.reason ?? "";

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
    throw new ReviewError("unsupported", "procedure proposals arrive in Phase 5");
  } else {
    throw new ReviewError("conflict", `unknown proposal kind: ${row.kind}`);
  }

  await db
    .prepare(`UPDATE proposals SET status = 'applied', applied_at = ?1, applied_by = ?2 WHERE id = ?3`)
    .bind(now, opts.actor, proposalId)
    .run();
  return { applied: true, kind: row.kind };
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
