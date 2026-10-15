import type { Scope } from "./env";

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

async function usedFor(db: D1Database, scope: string, day: string): Promise<number> {
  const row = await db
    .prepare(`SELECT rows_written FROM rate_budgets WHERE scope = ?1 AND day = ?2`)
    .bind(scope, day)
    .first<{ rows_written: number }>();
  return row?.rows_written ?? 0;
}

export async function readBudget(db: D1Database, now: number = Date.now()): Promise<BudgetState> {
  const used = await usedFor(db, "__global__", dayKey(now));
  return { used, warn: used >= WARN_AT, breaker: used >= BREAKER_AT };
}

/** Charge `rows` written rows to a scope + the global budget.
 *  Non-ADMIN: reject with "over_limit" past the scope cap (checked first),
 *  then "breaker_open" past the global breaker; rejected charges write nothing.
 *  ADMIN always passes. Checks are read-then-write (best-effort under
 *  concurrency — accepted for a single-owner brain). */
export async function charge(
  db: D1Database,
  scope: Scope,
  rows: number,
  now: number = Date.now(),
): Promise<"ok" | "over_limit" | "breaker_open"> {
  const day = dayKey(now);
  if (scope !== "ADMIN") {
    if ((await usedFor(db, scope, day)) + rows > PROPOSE_CAP) return "over_limit";
    if ((await usedFor(db, "__global__", day)) + rows > BREAKER_AT) return "breaker_open";
  }
  const stmt = db.prepare(
    `INSERT INTO rate_budgets (scope, day, rows_written) VALUES (?1, ?2, ?3)
     ON CONFLICT(scope, day) DO UPDATE SET rows_written = rows_written + excluded.rows_written`,
  );
  await db.batch([stmt.bind(scope, day, rows), stmt.bind("__global__", day, rows)]);
  return "ok";
}
