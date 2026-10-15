import { writeAudit } from "./audit";
import type { Env } from "./env";
import { resolveObjectEntity } from "./entities";
import { newFactId, type FactKind } from "./facts";
import { linkFactEdges } from "./graph";
import { EMBEDDING_MODEL } from "./llm";

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
      EMBEDDING_MODEL,
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
