import type { Env } from "./env";

/** Single entry point for re-deriving read projections from the `events` table
 *  (Phase 2 appends fact/vector rebuild steps here).
 *
 *  FTS5 external-content `'rebuild'` wipes the index and re-reads the content
 *  table. Purged events (excerpt NULL) are therefore indexed with no tokens —
 *  purged text cannot resurrect (the plan's Review Focus 4). */
export async function rebuildProjections(env: Env): Promise<{ fts_rows: number }> {
  const db = env.BRAIN_DB;
  await db.prepare(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`).run();
  const row = await db.prepare(`SELECT count(*) AS n FROM events_fts`).first<{ n: number }>();
  return { fts_rows: row?.n ?? 0 };
}
