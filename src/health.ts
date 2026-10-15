import type { Env } from "./env";
import { readBudget, type BudgetState } from "./budget";

export interface HealthReport {
  events: number;
  budget: BudgetState;
  purges: number;
  pending_proposals: number;
}

export async function healthReport(env: Env): Promise<HealthReport> {
  const db = env.BRAIN_DB;
  const [ev, pg, pp] = await db.batch<{ n: number }>([
    db.prepare(`SELECT count(*) AS n FROM events`),
    db.prepare(`SELECT count(*) AS n FROM events WHERE kind = 'purge_tombstone'`),
    db.prepare(`SELECT count(*) AS n FROM proposals WHERE status = 'pending'`),
  ]);
  const n = (r: D1Result<{ n: number }>): number => r.results?.[0]?.n ?? 0;
  return {
    events: n(ev),
    budget: await readBudget(db),
    purges: n(pg),
    pending_proposals: n(pp),
  };
}
