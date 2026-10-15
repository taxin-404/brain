import type { Env } from "./env";
import { readBudget, type BudgetState } from "./budget";

export interface ConsolidationSummary {
  id: string;
  finished_at: number;
  merged: number;
  superseded: number;
  conflicts: number;
  pruned: number;
}

export interface HealthReport {
  events: number;
  budget: BudgetState;
  purges: number;
  pending_proposals: number;
  extractions: { pending: number; running: number; failed: number; done: number };
  consolidation: { last_run: ConsolidationSummary | null };
  reflections: number;
}

export async function healthReport(env: Env): Promise<HealthReport> {
  const db = env.BRAIN_DB;
  const [ev, pg, pp, ex, cr, rf] = await db.batch<{
    status?: string;
    n?: number;
    id?: string;
    finished_at?: number;
    merged?: number;
    superseded?: number;
    conflicts?: number;
    pruned?: number;
  }>([
    db.prepare(`SELECT count(*) AS n FROM events`),
    db.prepare(`SELECT count(*) AS n FROM events WHERE kind = 'purge_tombstone'`),
    db.prepare(`SELECT count(*) AS n FROM proposals WHERE status = 'pending'`),
    db.prepare(`SELECT status, count(*) AS n FROM extractions GROUP BY status`),
    db.prepare(
      `SELECT id, finished_at, merged, superseded, conflicts, pruned FROM consolidation_runs
       ORDER BY finished_at DESC, id DESC LIMIT 1`,
    ),
    db.prepare(`SELECT count(*) AS n FROM reflections`),
  ]);
  const n = (r: D1Result<{ n?: number }>): number => r.results?.[0]?.n ?? 0;
  const exCounts: Record<string, number> = {};
  for (const row of ex.results ?? []) {
    if (row.status) exCounts[row.status] = (exCounts[row.status] ?? 0) + (row.n ?? 0);
  }
  const lastRun = cr.results?.[0];
  return {
    events: n(ev),
    budget: await readBudget(db),
    purges: n(pg),
    pending_proposals: n(pp),
    extractions: {
      pending: exCounts.pending ?? 0,
      running: exCounts.running ?? 0,
      failed: exCounts.failed ?? 0,
      done: exCounts.done ?? 0,
    },
    consolidation: {
      last_run:
        lastRun?.id !== undefined
          ? {
              id: lastRun.id,
              finished_at: lastRun.finished_at ?? 0,
              merged: lastRun.merged ?? 0,
              superseded: lastRun.superseded ?? 0,
              conflicts: lastRun.conflicts ?? 0,
              pruned: lastRun.pruned ?? 0,
            }
          : null,
    },
    reflections: n(rf),
  };
}
