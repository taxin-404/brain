import { writeAudit } from "./audit";
import type { Env } from "./env";
import { resolveObjectEntity } from "./entities";
import { newFactId, type FactKind } from "./facts";
import { closeFactEdges, linkFactEdges } from "./graph";
import { embeddingSignature } from "./llm";

/** The single fact write path. Extraction, the review engine, and
 *  contradiction handling all funnel through here so a fact row, its FTS
 *  index row, its source link, and its audit entry are always written
 *  together. Vector lifecycle (embed on the sweep; delete on
 *  supersession/purge) lives here too. */

export interface CreateFactInput {
  subjectId: string;
  /** entity display name; recorded in the audit entry only */
  subjectName: string;
  predicate: string;
  objectText: string;
  factKind: FactKind;
  confidence: number;
  /** default "active"; contradiction handling may insert "disputed" */
  status?: "active" | "disputed";
  validAt?: number;
  expiresAt?: number;
  sensitivity: string;
  sourceEventId: string;
  now?: number;
}

/** Insert the fact row (vec_id NULL — the next embed pass picks it up),
 *  its facts_fts index row (external-content table: manual insert), the
 *  source link, and the `create` audit entry. Returns the new fact id. */
export async function createFact(env: Env, input: CreateFactInput): Promise<string> {
  const now = input.now ?? Date.now();
  const id = newFactId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO facts (id, subject_id, predicate, object_text, fact_kind, confidence, status,
                        valid_at, expires_at, learned_at, first_seen_at, last_confirmed_at,
                        sensitivity, source_event_id, embedding_model)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10, ?11, ?12, ?13)`,
  )
    .bind(
      id,
      input.subjectId,
      input.predicate,
      input.objectText,
      input.factKind,
      input.confidence,
      input.status ?? "active",
      input.validAt ?? null,
      input.expiresAt ?? null,
      now,
      input.sensitivity,
      input.sourceEventId,
      embeddingSignature(env),
    )
    .run();

  await env.BRAIN_DB.prepare(
    `INSERT INTO facts_fts(rowid, object_text) SELECT rowid, object_text FROM facts WHERE id = ?1`,
  )
    .bind(id)
    .run();

  await env.BRAIN_DB.prepare(`INSERT OR IGNORE INTO fact_sources (fact_id, event_id) VALUES (?1, ?2)`)
    .bind(id, input.sourceEventId)
    .run();

  // Graph (Phase 3): active facts link to a known object entity and land as
  // edges; disputed facts stay out of the graph (their relation is unverified).
  if ((input.status ?? "active") === "active") {
    const obj = await resolveObjectEntity(env.BRAIN_DB, input.objectText);
    if (obj) {
      await linkFactEdges(env, {
        id,
        subjectId: input.subjectId,
        predicate: input.predicate,
        objectEntityId: obj.id,
        confidence: input.confidence,
        validAt: input.validAt,
        sourceEventId: input.sourceEventId,
        now,
      });
    }
  }

  await writeAudit(env.BRAIN_DB, {
    actor: "system",
    action: "create",
    targetType: "fact",
    targetId: id,
    after: {
      subject: input.subjectName,
      predicate: input.predicate,
      object: input.objectText,
      fact_kind: input.factKind,
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      event_id: input.sourceEventId,
    },
  });

  return id;
}

/** Duplicate confirmation: bump last_confirmed_at and link the (possibly new)
 *  source event — idempotent per (fact, event). */
export async function confirmFact(env: Env, factId: string, eventId: string, now: number): Promise<void> {
  await env.BRAIN_DB.prepare(`UPDATE facts SET last_confirmed_at = ?1 WHERE id = ?2`).bind(now, factId).run();
  await env.BRAIN_DB.prepare(`INSERT OR IGNORE INTO fact_sources (fact_id, event_id) VALUES (?1, ?2)`)
    .bind(factId, eventId)
    .run();
}

/** Remove a fact's vector from the index (supersession/purge/undo paths).
 *  Best-effort: a stale vector is harmless (search re-checks D1 status), so a
 *  Vectorize failure only logs — vec_id stays set and a later run can retry. */
export async function deleteFactVector(env: Env, factId: string): Promise<void> {
  try {
    await env.VECTORIZE.deleteByIds([factId]);
    await env.BRAIN_DB.prepare(`UPDATE facts SET vec_id = NULL WHERE id = ?1`).bind(factId).run();
  } catch (err) {
    console.log(`[factstore] vector delete failed for ${factId}: ${String(err)}`);
  }
}

/** Soft-supersede a fact (design §4: supersession never deletes): the old row
 *  keeps its object text and FTS entry for `why`, loses its vector, closes its
 *  edge, and points at the replacement via `superseded_by` + `invalid_at`. */
export async function supersedeFact(
  env: Env,
  oldFactId: string,
  newFactId: string,
  now: number,
  actor: "user" | "system" = "system",
): Promise<void> {
  const db = env.BRAIN_DB;
  const old = await db
    .prepare(`SELECT subject_id, predicate, object_entity_id, object_text, status FROM facts WHERE id = ?1`)
    .bind(oldFactId)
    .first<{
      subject_id: string;
      predicate: string;
      object_entity_id: string | null;
      object_text: string | null;
      status: string;
    }>();
  if (!old) throw new Error(`supersedeFact: fact not found: ${oldFactId}`);
  if (old.status !== "active") throw new Error(`supersedeFact: fact not active: ${oldFactId} (${old.status})`);

  await db
    .prepare(`UPDATE facts SET status = 'superseded', invalid_at = ?1, superseded_by = ?2 WHERE id = ?3`)
    .bind(now, newFactId, oldFactId)
    .run();
  await closeFactEdges(env, { subjectId: old.subject_id, predicate: old.predicate, objectEntityId: old.object_entity_id }, now);
  await deleteFactVector(env, oldFactId);

  await writeAudit(db, {
    actor,
    action: "supersede",
    targetType: "fact",
    targetId: oldFactId,
    before: { status: "active", object: old.object_text },
    after: { status: "superseded", superseded_by: newFactId },
  });
}

/** Retire a lapsed fact (Phase 4 consolidation): soft archive — the row keeps
 *  its text and FTS entry for `why`, loses its vector (dimension pruning),
 *  closes its edge, and marks `expired_at`. Only active facts can lapse. */
export async function expireFact(
  env: Env,
  factId: string,
  opts: { now?: number; actor?: "user" | "system" } = {},
): Promise<void> {
  const db = env.BRAIN_DB;
  const now = opts.now ?? Date.now();
  const row = await db
    .prepare(`SELECT subject_id, predicate, object_entity_id, status, expires_at FROM facts WHERE id = ?1`)
    .bind(factId)
    .first<{
      subject_id: string;
      predicate: string;
      object_entity_id: string | null;
      status: string;
      expires_at: number | null;
    }>();
  if (!row) throw new Error(`expireFact: fact not found: ${factId}`);
  if (row.status !== "active") throw new Error(`expireFact: fact not active: ${factId} (${row.status})`);

  await db.prepare(`UPDATE facts SET status = 'archived', expired_at = ?1 WHERE id = ?2`).bind(now, factId).run();
  await closeFactEdges(
    env,
    { subjectId: row.subject_id, predicate: row.predicate, objectEntityId: row.object_entity_id },
    now,
  );
  await deleteFactVector(env, factId);

  await writeAudit(db, {
    actor: opts.actor ?? "system",
    action: "expire",
    targetType: "fact",
    targetId: factId,
    before: { status: "active", expires_at: row.expires_at },
    after: { status: "archived", expired_at: now },
  });
}

/** Merge a near-duplicate victim into a survivor (Phase 4 consolidation):
 *  union the provenance, aggregate the timestamps, set the merged confidence
 *  (the caller owns evidence-unit knowledge and computes the noisy-OR, capped
 *  here at 0.85 as a last defense), then soft-supersede the victim so the
 *  pair collapses into one active fact with full history intact. */
export async function mergeFacts(
  env: Env,
  survivorId: string,
  victimId: string,
  opts: { now: number; confidence: number },
): Promise<void> {
  const db = env.BRAIN_DB;
  const rows = await db
    .prepare(
      `SELECT id, subject_id, predicate, status, confidence, first_seen_at, last_confirmed_at
       FROM facts WHERE id IN (?1, ?2)`,
    )
    .bind(survivorId, victimId)
    .all<{
      id: string;
      subject_id: string;
      predicate: string;
      status: string;
      confidence: number;
      first_seen_at: number | null;
      last_confirmed_at: number;
    }>();
  const survivor = rows.results.find((r) => r.id === survivorId);
  const victim = rows.results.find((r) => r.id === victimId);
  if (!survivor) throw new Error(`mergeFacts: survivor not found: ${survivorId}`);
  if (!victim) throw new Error(`mergeFacts: victim not found: ${victimId}`);
  if (survivor.status !== "active") throw new Error(`mergeFacts: survivor not active: ${survivorId} (${survivor.status})`);
  if (victim.status !== "active") throw new Error(`mergeFacts: victim not active: ${victimId} (${victim.status})`);
  if (survivor.subject_id !== victim.subject_id || survivor.predicate !== victim.predicate) {
    throw new Error(`mergeFacts: subject/predicate mismatch: ${survivorId} vs ${victimId}`);
  }

  await db
    .prepare(`INSERT OR IGNORE INTO fact_sources (fact_id, event_id) SELECT ?1, event_id FROM fact_sources WHERE fact_id = ?2`)
    .bind(survivorId, victimId)
    .run();

  const confidence = Math.min(0.85, opts.confidence);
  const firstSeen = Math.min(
    survivor.first_seen_at ?? survivor.last_confirmed_at,
    victim.first_seen_at ?? victim.last_confirmed_at,
  );
  const lastConfirmed = Math.max(survivor.last_confirmed_at, victim.last_confirmed_at);
  await db
    .prepare(`UPDATE facts SET confidence = ?1, first_seen_at = ?2, last_confirmed_at = ?3 WHERE id = ?4`)
    .bind(confidence, firstSeen, lastConfirmed, survivorId)
    .run();

  await supersedeFact(env, victimId, survivorId, opts.now, "system");

  await writeAudit(db, {
    actor: "system",
    action: "merge",
    targetType: "fact",
    targetId: survivorId,
    before: { confidence: survivor.confidence, first_seen_at: survivor.first_seen_at },
    after: { confidence, first_seen_at: firstSeen, last_confirmed_at: lastConfirmed },
    reason: `merged ${victimId}`,
  });
}

/** Mark a fact disputed (an applied dispute proposal). Only active facts can
 *  become disputed; callers surface the review-tier errors. */
export async function disputeFact(env: Env, factId: string, now: number): Promise<void> {
  const db = env.BRAIN_DB;
  const row = await db.prepare(`SELECT status FROM facts WHERE id = ?1`).bind(factId).first<{ status: string }>();
  if (!row) throw new Error(`disputeFact: fact not found: ${factId}`);
  if (row.status !== "active") throw new Error(`disputeFact: fact not active: ${factId} (${row.status})`);

  await db.prepare(`UPDATE facts SET status = 'disputed' WHERE id = ?1`).bind(factId).run();
  await writeAudit(db, {
    actor: "system",
    action: "dispute",
    targetType: "fact",
    targetId: factId,
    before: { status: "active" },
    after: { status: "disputed" },
  });
}

/** Hard purge of a fact (design §4: "hard purge nulls object_text"): FTS
 *  `'delete'` with the old text (skipped when already NULL — re-runs are
 *  idempotent), object_text NULL, status deleted, vector removed, edges
 *  closed, audit before/after. `fact_sources` rows are kept (they hold no
 *  text — they are provenance ids). */
export async function purgeFact(
  env: Env,
  factId: string,
  opts: { actor?: "user" | "system"; now?: number } = {},
): Promise<void> {
  const db = env.BRAIN_DB;
  const now = opts.now ?? Date.now();
  const row = await db
    .prepare(`SELECT rowid, subject_id, predicate, object_entity_id, object_text, status FROM facts WHERE id = ?1`)
    .bind(factId)
    .first<{
      rowid: number;
      subject_id: string;
      predicate: string;
      object_entity_id: string | null;
      object_text: string | null;
      status: string;
    }>();
  if (!row) throw new Error(`purgeFact: fact not found: ${factId}`);

  if (row.object_text !== null) {
    // FTS5 external-content delete must be handed the OLD values
    await db
      .prepare(`INSERT INTO facts_fts(facts_fts, rowid, object_text) VALUES ('delete', ?1, ?2)`)
      .bind(row.rowid, row.object_text)
      .run();
    await db.prepare(`UPDATE facts SET object_text = NULL WHERE id = ?1`).bind(factId).run();
  }
  await db.prepare(`UPDATE facts SET status = 'deleted' WHERE id = ?1 AND status != 'deleted'`).bind(factId).run();
  await closeFactEdges(env, { subjectId: row.subject_id, predicate: row.predicate, objectEntityId: row.object_entity_id }, now);
  await deleteFactVector(env, factId);

  await writeAudit(db, {
    actor: opts.actor ?? "user",
    action: "purge",
    targetType: "fact",
    targetId: factId,
    before: { object: row.object_text, status: row.status },
    after: { object: null, status: "deleted" },
  });
}
