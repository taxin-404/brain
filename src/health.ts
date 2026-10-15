import type { Env } from "./env";
import { readBudget, type BudgetState } from "./budget";

export interface HealthReport {
  events: number;
  budget: BudgetState;
  purges: number;
  pending_proposals: number;
  extractions: { pending: number; running: number; failed: number; done: number };
}

export async function healthReport(env: Env): Promise<HealthReport> {
  const db = env.BRAIN_DB;
  const [ev, pg, pp, ex] = await db.batch<{ status?: string; n?: number }>([
    db.prepare(`SELECT count(*) AS n FROM events`),
    db.prepare(`SELECT count(*) AS n FROM events WHERE kind = 'purge_tombstone'`),
    db.prepare(`SELECT count(*) AS n FROM proposals WHERE status = 'pending'`),
    db.prepare(`SELECT status, count(*) AS n FROM extractions GROUP BY status`),
  ]);
  const n = (r: D1Result<{ n?: number }>): number => r.results?.[0]?.n ?? 0;
  const exCounts: Record<string, number> = {};
  for (const row of ex.results ?? []) {
    if (row.status) exCounts[row.status] = (exCounts[row.status] ?? 0) + (row.n ?? 0);
  }
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
  };
}
