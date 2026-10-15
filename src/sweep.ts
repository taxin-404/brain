import type { Env } from "./env";
import { readBudget } from "./budget";

export interface SweepResult {
  pruned_tokens: number;
  warn: boolean;
  breaker: boolean;
}

/** Runs on the 30-minute cron: prune expired confirm tokens, re-read the
 *  budget and log a `[sweep]` warning when the 70k warn line or 80k breaker
 *  is crossed. */
export async function runSweep(env: Env, now: number = Date.now()): Promise<SweepResult> {
  const del = await env.BRAIN_DB.prepare(`DELETE FROM confirm_tokens WHERE expires_at < ?1`).bind(now).run();
  const pruned_tokens = del.meta.changes ?? 0;

  const { used, warn, breaker } = await readBudget(env.BRAIN_DB, now);
  if (warn || breaker) {
    console.log(`[sweep] budget warning: ${used} rows today (warn=${warn} breaker=${breaker})`);
  }

  return { pruned_tokens, warn, breaker };
}
