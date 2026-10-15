import { newEventId } from "./crypto";
import type { Env, Scope } from "./env";
import { json } from "./http";

/** The temporal graph (Phase 3): facts with entity-resolved objects also land
 *  as edges (`subject --predicate--> object`), so the entity view can show
 *  structure and supersession can close relations with `invalid_at`. */

export interface FactEdgeRef {
  id: string;
  subjectId: string;
  predicate: string;
  objectEntityId: string | null;
  confidence: number;
  validAt?: number;
  sourceEventId: string;
  now: number;
}

/** Link a fact to its object entity and write the corresponding edge. */
export async function linkFactEdges(env: Env, fact: FactEdgeRef): Promise<void> {
  if (!fact.objectEntityId) return;
  await env.BRAIN_DB.prepare(`UPDATE facts SET object_entity_id = ?1 WHERE id = ?2`)
    .bind(fact.objectEntityId, fact.id)
    .run();
  await env.BRAIN_DB.prepare(
    `INSERT INTO edges (id, src, dst, rel, confidence, valid_at, learned_at, source_event_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      newEventId(),
      fact.subjectId,
      fact.objectEntityId,
      fact.predicate,
      fact.confidence,
      fact.validAt ?? fact.now,
      fact.now,
      fact.sourceEventId,
    )
    .run();
}

/** Close the open edge a superseded/purged fact represented. */
export async function closeFactEdges(
  env: Env,
  fact: { subjectId: string; predicate: string; objectEntityId: string | null },
  now: number,
): Promise<void> {
  if (!fact.objectEntityId) return;
  await env.BRAIN_DB.prepare(
    `UPDATE edges SET invalid_at = ?1 WHERE src = ?2 AND dst = ?3 AND rel = ?4 AND invalid_at IS NULL`,
  )
    .bind(now, fact.subjectId, fact.objectEntityId, fact.predicate)
    .run();
}

interface EntityRow {
  id: string;
  type: string;
  name: string;
  norm_name: string;
  summary: string | null;
  first_seen_at: number | null;
  last_seen_at: number | null;
}

interface EdgeRow {
  rel: string;
  confidence: number;
  valid_at: number | null;
  invalid_at: number | null;
  other_id: string;
  other_name: string;
  other_type: string;
}

/** GET /v1/entities/:id — entity + aliases + active facts + open edges.
 *  Restricted facts are hidden from non-admin scopes. */
export async function handleGetEntity(env: Env, scope: Scope, id: string): Promise<Response> {
  const db = env.BRAIN_DB;
  const entity = await db
    .prepare(`SELECT id, type, name, norm_name, summary, first_seen_at, last_seen_at FROM entities WHERE id = ?1`)
    .bind(id)
    .first<EntityRow>();
  if (!entity) return json({ error: "not_found" }, 404);
  const allowRestricted = scope === "ADMIN" ? 1 : 0;

  const [aliasRes, factRes, outRes, inRes] = await Promise.all([
    db
      .prepare(`SELECT alias FROM entity_aliases WHERE entity_id = ?1 ORDER BY alias LIMIT 200`)
      .bind(id)
      .all<{ alias: string }>(),
    db
      .prepare(
        `SELECT id, predicate, object_text AS object, fact_kind, confidence, status, sensitivity,
                valid_at, invalid_at, learned_at
         FROM facts WHERE subject_id = ?1 AND status = 'active'
           AND (sensitivity != 'restricted' OR ?2 = 1)
         ORDER BY learned_at DESC LIMIT 100`,
      )
      .bind(id, allowRestricted)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT e.rel, e.confidence, e.valid_at, e.invalid_at,
                d.id AS other_id, d.name AS other_name, d.type AS other_type
         FROM edges e JOIN entities d ON d.id = e.dst
         WHERE e.src = ?1 AND e.invalid_at IS NULL
         ORDER BY e.learned_at DESC LIMIT 100`,
      )
      .bind(id)
      .all<EdgeRow>(),
    db
      .prepare(
        `SELECT e.rel, e.confidence, e.valid_at, e.invalid_at,
                s.id AS other_id, s.name AS other_name, s.type AS other_type
         FROM edges e JOIN entities s ON s.id = e.src
         WHERE e.dst = ?1 AND e.invalid_at IS NULL
         ORDER BY e.learned_at DESC LIMIT 100`,
      )
      .bind(id)
      .all<EdgeRow>(),
  ]);

  const outEdge = (r: EdgeRow) => ({
    rel: r.rel,
    confidence: r.confidence,
    valid_at: r.valid_at,
    invalid_at: r.invalid_at,
    dst: { id: r.other_id, name: r.other_name, type: r.other_type },
  });
  const inEdge = (r: EdgeRow) => ({
    rel: r.rel,
    confidence: r.confidence,
    valid_at: r.valid_at,
    invalid_at: r.invalid_at,
    src: { id: r.other_id, name: r.other_name, type: r.other_type },
  });

  return json({
    entity,
    aliases: aliasRes.results.map((r) => ({ alias: r.alias })),
    facts: factRes.results,
    edges: { out: outRes.results.map(outEdge), in: inRes.results.map(inEdge) },
  });
}
