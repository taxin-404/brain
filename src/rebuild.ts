import type { Env } from "./env";

/** Single entry point for re-deriving read projections from content tables
 *  (used by restore and the rebuild route).
 *
 *  FTS5 external-content `'rebuild'` wipes the index and re-reads the content
 *  table. Purged events (excerpt NULL) are therefore indexed with no tokens —
 *  purged text cannot resurrect (the plan's Review Focus 4). `facts_fts` is
 *  manual-insert at write time (factstore) and manual-delete on purge, so a
 *  rebuild must re-derive it too — found by the Phase-6 clean-account eval.
 *
 *  `fts_rows` counts the events index only (callers assert on it historically). */
export async function rebuildProjections(env: Env): Promise<{ fts_rows: number }> {
  const db = env.BRAIN_DB;
  await db.prepare(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`).run();
  await db.prepare(`INSERT INTO facts_fts(facts_fts) VALUES('rebuild')`).run();
  const row = await db.prepare(`SELECT count(*) AS n FROM events_fts`).first<{ n: number }>();
  return { fts_rows: row?.n ?? 0 };
}
