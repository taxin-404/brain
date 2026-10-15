import type { Env, Scope } from "./env";
import { json } from "./http";

export interface SearchHit {
  id: string;
  ts: number;
  kind: string;
  excerpt: string;
  privacy: string;
}

/** Pinned sanitization: split on whitespace, wrap each term as an FTS5 phrase
 *  (doubling internal quotes), join with AND. Metacharacters become literals. */
export function sanitizeQuery(q: string): string {
  return q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" AND ");
}

export async function searchEvents(
  env: Env,
  q: string,
  limit: number,
  opts: { includeRestricted: boolean },
): Promise<SearchHit[]> {
  const match = sanitizeQuery(q);
  if (match === "") return [];
  const { results } = await env.BRAIN_DB.prepare(
    `SELECT e.id, e.ts, e.kind, e.excerpt, e.privacy
     FROM events_fts
     JOIN events e ON e.rowid = events_fts.rowid
     WHERE events_fts MATCH ?1
       AND e.redacted = 0
       AND (e.privacy != 'restricted' OR ?2 = 1)
     ORDER BY rank
     LIMIT ?3`,
  )
    .bind(match, opts.includeRestricted ? 1 : 0, limit)
    .all<SearchHit>();
  return results;
}

export async function handleSearch(request: Request, env: Env, scope: Scope): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q === "") return json({ error: "bad_request", message: "q required" }, 400);

  const limitRaw = url.searchParams.get("limit");
  let limit = limitRaw === null ? 8 : Number(limitRaw);
  if (!Number.isFinite(limit)) limit = 8;
  limit = Math.max(1, Math.min(50, Math.trunc(limit)));

  const includeRestricted = url.searchParams.get("include_restricted") === "true";
  if (includeRestricted && scope !== "ADMIN") return json({ error: "forbidden" }, 403);

  return json({ results: await searchEvents(env, q, limit, { includeRestricted }) });
}
