import { newEventId } from "./crypto";
import { normalizeSubjectText } from "./facts";

// R3 (minimal entities): only what Phase 2 needs for fact subjects. Aliases,
// edges and contradiction handling are Phase 3.
const SELF_ALIASES = new Set(["user", "taxin", "taxin-404", "taxin404", "owner", "taxin 404"]);

export interface SubjectResolution {
  id: string;
  name: string;
  norm: string;
  created: boolean;
}

/** Record a mention that resolved to an entity as an alias when it is not the
 *  entity's canonical form (SELF aliases like `taxin 404` → user; display
 *  variants like `graph api` for `Graph API`). Exact repeats are skipped and
 *  INSERT OR IGNORE dedupes by norm, so repeat mentions cost nothing. */
async function learnAlias(
  db: D1Database,
  entityId: string,
  entityNorm: string,
  entityName: string,
  raw: string,
  norm: string,
): Promise<void> {
  if (norm === entityNorm && raw === entityName) return;
  await db
    .prepare(`INSERT OR IGNORE INTO entity_aliases (entity_id, alias, norm_alias) VALUES (?1, ?2, ?3)`)
    .bind(entityId, raw, norm)
    .run();
}

/** Match an object text against known entities for edge linking (Phase 3):
 *  same normalization entities use (`normalizeSubjectText`), most recently
 *  seen first, any type. Never creates entities — unknown objects simply do
 *  not participate in the graph. */
export async function resolveObjectEntity(db: D1Database, objectText: string): Promise<{ id: string } | null> {
  const norm = normalizeSubjectText(objectText);
  if (!norm) return null;
  const row = await db
    .prepare(`SELECT id FROM entities WHERE norm_name = ?1 ORDER BY COALESCE(last_seen_at, 0) DESC, id ASC LIMIT 1`)
    .bind(norm)
    .first<{ id: string }>();
  return row ?? null;
}

/** Resolve a fact subject to an entity row:
 *  SELF aliases → the Person "user"; else exact (type, norm_name); else any-type
 *  norm_name (most recently seen); else create with hint type ?? "Project".
 *  Matches bump last_seen_at; creates set first_seen_at. */
export async function resolveSubject(
  db: D1Database,
  subject: string,
  type?: string,
  now: number = Date.now(),
): Promise<SubjectResolution> {
  const norm = normalizeSubjectText(subject);
  const rawLower = subject.trim().toLowerCase();

  if (SELF_ALIASES.has(rawLower) || SELF_ALIASES.has(norm)) {
    const existing = await db
      .prepare(`SELECT id, name FROM entities WHERE type = 'Person' AND norm_name = 'user'`)
      .first<{ id: string; name: string }>();
    if (existing) {
      await db.prepare(`UPDATE entities SET last_seen_at = ?1 WHERE id = ?2`).bind(now, existing.id).run();
      await learnAlias(db, existing.id, "user", existing.name, subject.trim(), norm);
      return { id: existing.id, name: existing.name, norm: "user", created: false };
    }
    const id = newEventId();
    await db
      .prepare(
        `INSERT INTO entities (id, type, name, norm_name, first_seen_at, last_seen_at)
         VALUES (?1, 'Person', 'user', 'user', ?2, ?2)`,
      )
      .bind(id, now)
      .run();
    await learnAlias(db, id, "user", "user", subject.trim(), norm);
    return { id, name: "user", norm: "user", created: true };
  }

  if (type) {
    const exact = await db
      .prepare(`SELECT id, name FROM entities WHERE type = ?1 AND norm_name = ?2`)
      .bind(type, norm)
      .first<{ id: string; name: string }>();
    if (exact) {
      await db.prepare(`UPDATE entities SET last_seen_at = ?1 WHERE id = ?2`).bind(now, exact.id).run();
      await learnAlias(db, exact.id, norm, exact.name, subject.trim(), norm);
      return { id: exact.id, name: exact.name, norm, created: false };
    }
  }

  const anyType = await db
    .prepare(
      `SELECT id, name FROM entities WHERE norm_name = ?1 ORDER BY COALESCE(last_seen_at, 0) DESC, id ASC LIMIT 1`,
    )
    .bind(norm)
    .first<{ id: string; name: string }>();
  if (anyType) {
    await db.prepare(`UPDATE entities SET last_seen_at = ?1 WHERE id = ?2`).bind(now, anyType.id).run();
    await learnAlias(db, anyType.id, norm, anyType.name, subject.trim(), norm);
    return { id: anyType.id, name: anyType.name, norm, created: false };
  }

  // Phase 3: match against stored aliases (same type when a hint is given) —
  // this is how `taxin 404`-style cross-norm names reconnect to their entity.
  const aliasSql = type
    ? `SELECT en.id AS id, en.name AS name FROM entity_aliases ea JOIN entities en ON en.id = ea.entity_id
       WHERE ea.norm_alias = ?1 AND en.type = ?2 ORDER BY COALESCE(en.last_seen_at, 0) DESC, en.id ASC LIMIT 1`
    : `SELECT en.id AS id, en.name AS name FROM entity_aliases ea JOIN entities en ON en.id = ea.entity_id
       WHERE ea.norm_alias = ?1 ORDER BY COALESCE(en.last_seen_at, 0) DESC, en.id ASC LIMIT 1`;
  const aliasHit = await (type ? db.prepare(aliasSql).bind(norm, type) : db.prepare(aliasSql).bind(norm)).first<{
    id: string;
    name: string;
  }>();
  if (aliasHit) {
    await db.prepare(`UPDATE entities SET last_seen_at = ?1 WHERE id = ?2`).bind(now, aliasHit.id).run();
    return { id: aliasHit.id, name: aliasHit.name, norm, created: false };
  }

  const id = newEventId();
  const name = subject.trim();
  await db
    .prepare(
      `INSERT INTO entities (id, type, name, norm_name, first_seen_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
    .bind(id, type ?? "Project", name, norm, now)
    .run();
  return { id, name, norm, created: true };
}
