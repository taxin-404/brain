export const PROPOSE_CAP = 10_000;
export const WARN_AT = 70_000;
export const BREAKER_AT = 80_000;

export interface BudgetState {
  used: number;
  warn: boolean;
  breaker: boolean;
}

export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function readBudget(db: D1Database, now: number = Date.now()): Promise<BudgetState> {
  const row = await db
    .prepare(`SELECT rows_written FROM rate_budgets WHERE scope = '__global__' AND day = ?1`)
    .bind(dayKey(now))
    .first<{ rows_written: number }>();
  const used = row?.rows_written ?? 0;
  return { used, warn: used >= WARN_AT, breaker: used >= BREAKER_AT };
}
