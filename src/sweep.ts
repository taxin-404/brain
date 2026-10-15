import type { Env } from "./env";
import { readBudget } from "./budget";
import { EXTRACTION_CAPS, processExtractions, type ExtractionRun } from "./extract";
import { expireProposals } from "./proposals";

export interface SweepResult {
  pruned_tokens: number;
  expired_proposals: number;
  warn: boolean;
  breaker: boolean;
  extracted: ExtractionRun;
}

const EMPTY_RUN: ExtractionRun = {
  processed: 0,
  facts: 0,
  failed: 0,
  calls: 0,
  injection: 0,
  embedded: 0,
  embedFailed: 0,
};

/** Runs on the 30-minute cron: prune expired confirm tokens, retire lapsed
 *  proposals, run the capped extraction pass (failures are logged, never fatal),
 *  then re-read the budget and log a `[sweep]` warning when the 70k warn line
 *  or 80k breaker is crossed. */
export async function runSweep(env: Env, now: number = Date.now()): Promise<SweepResult> {
  const del = await env.BRAIN_DB.prepare(`DELETE FROM confirm_tokens WHERE expires_at < ?1`).bind(now).run();
  const pruned_tokens = del.meta.changes ?? 0;

  const expired_proposals = await expireProposals(env, now);

  let extracted: ExtractionRun;
  try {
    extracted = await processExtractions(env, { ...EXTRACTION_CAPS.sweep, now });
  } catch (err) {
    console.log(`[sweep] extraction failed: ${String(err)}`);
    extracted = { ...EMPTY_RUN };
  }

  const { used, warn, breaker } = await readBudget(env.BRAIN_DB, now);
  if (warn || breaker) {
    console.log(`[sweep] budget warning: ${used} rows today (warn=${warn} breaker=${breaker})`);
  }

  return { pruned_tokens, expired_proposals, warn, breaker, extracted };
}
