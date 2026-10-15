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
    return { id, name: "user", norm: "user", created: true };
  }

  if (type) {
    const exact = await db
      .prepare(`SELECT id, name FROM entities WHERE type = ?1 AND norm_name = ?2`)
      .bind(type, norm)
      .first<{ id: string; name: string }>();
    if (exact) {
      await db.prepare(`UPDATE entities SET last_seen_at = ?1 WHERE id = ?2`).bind(now, exact.id).run();
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
    return { id: anyType.id, name: anyType.name, norm, created: false };
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
