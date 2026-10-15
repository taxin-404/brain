import type { Env, Scope } from "./env";
import { json } from "./http";
import { embedTexts } from "./llm";

export interface SearchHit {
  id: string;
  ts: number;
  kind: string;
  excerpt: string;
  privacy: string;
}

export interface FactHit {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  fact_kind: string;
  confidence: number;
  status: string;
  learned_at: number;
  score: number;
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

/** Pinned blend (facts section): candidates are active facts; two ranked lists
 *  (Vectorize top-20, FTS5 top-20 over facts_fts) combined with
 *  `1/(60+rank_vec) + 1/(60+rank_kw) + 0.10*exp(-ageDays/30) + 0.05*clamp01(confidence)`
 *  where ageDays comes from coalesce(last_confirmed_at, learned_at); a missing
 *  list omits its term; ties break by id ASC. Sensitivity is re-checked in code
 *  after the vector query (metadata may lag). Embedding failure → keyword-only
 *  list + degraded flag; the search still answers. */
export async function searchFacts(
  env: Env,
  q: string,
  limit: number,
  opts: { includeRestricted: boolean },
): Promise<{ facts: FactHit[]; degraded: boolean }> {
  const allowRestricted = opts.includeRestricted ? 1 : 0;
  let degraded = false;
  const vecIds: string[] = [];

  try {
    const [vec] = await embedTexts(env, [q]);
    const res = await env.VECTORIZE.query(vec, {
      topK: 20,
      filter: { status: { $eq: "active" } },
      returnMetadata: "all",
    });
    for (const m of res.matches ?? []) {
      const md = (m.metadata ?? {}) as { fact_id?: string; sensitivity?: string };
      if (!opts.includeRestricted && md.sensitivity === "restricted") continue;
      vecIds.push(md.fact_id ?? m.id);
    }
  } catch {
    degraded = true; // embedding/gateway failure: keyword-only
  }

  const match = sanitizeQuery(q);
  const kwIds =
    match === ""
      ? []
      : (
          await env.BRAIN_DB.prepare(
            `SELECT f.id FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid
             WHERE facts_fts MATCH ?1 AND f.status = 'active'
               AND (f.sensitivity != 'restricted' OR ?2 = 1)
             ORDER BY rank LIMIT 20`,
          )
            .bind(match, allowRestricted)
            .all<{ id: string }>()
        ).results.map((r) => r.id);

  const ids = [...new Set([...vecIds, ...kwIds])];
  if (ids.length === 0) return { facts: [], degraded };

  const marks = ids.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await env.BRAIN_DB.prepare(
    `SELECT f.id, e.name AS subject, f.predicate, f.object_text, f.fact_kind, f.confidence, f.status,
            f.learned_at, f.last_confirmed_at, f.sensitivity
     FROM facts f JOIN entities e ON e.id = f.subject_id
     WHERE f.id IN (${marks})`,
  )
    .bind(...ids)
    .all<{
      id: string;
      subject: string;
      predicate: string | null;
      object_text: string | null;
      fact_kind: string;
      confidence: number;
      status: string;
      learned_at: number;
      last_confirmed_at: number | null;
      sensitivity: string;
    }>();

  const now = Date.now();
  const byId = new Map(results.map((r) => [r.id, r]));
  const hits: FactHit[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.status !== "active") continue;
    if (r.sensitivity === "restricted" && !opts.includeRestricted) continue;
    const rankVec = vecIds.indexOf(id);
    const rankKw = kwIds.indexOf(id);
    const ageDays = (now - (r.last_confirmed_at ?? r.learned_at)) / 86_400_000;
    const score =
      (rankVec >= 0 ? 1 / (60 + rankVec + 1) : 0) +
      (rankKw >= 0 ? 1 / (60 + rankKw + 1) : 0) +
      0.1 * Math.exp(-ageDays / 30) +
      0.05 * Math.min(1, Math.max(0, r.confidence));
    hits.push({
      id: r.id,
      subject: r.subject,
      predicate: r.predicate ?? "",
      object: r.object_text ?? "",
      fact_kind: r.fact_kind,
      confidence: r.confidence,
      status: r.status,
      learned_at: r.learned_at,
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { facts: hits.slice(0, limit), degraded };
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

  const [results, factsResult] = await Promise.all([
    searchEvents(env, q, limit, { includeRestricted }),
    searchFacts(env, q, limit, { includeRestricted }),
  ]);
  return json({
    results,
    facts: factsResult.facts,
    ...(factsResult.degraded ? { degraded: true } : {}),
  });
}
