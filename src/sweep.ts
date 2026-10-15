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
  superseded: 0,
  disputed: 0,
};

/** Runs on the 30-minute cron: prune expired confirm tokens, retire lapsed
 *  proposals, run the capped extraction pass (failures are logged, never fatal),
 *  then re-read the budget and log a `[sweep]` warning when the 70k warn line
 *  or 80k breaker is crossed. */
/** Retention for export jobs: past `exp` (+5 min grace) the signed link is
 *  dead by design, so the sweep reclaims the R2 objects. Portable jobs
 *  normally self-delete on first download; this is the enforced TTL fallback
 *  for never-downloaded ones, and the janitor for expired backups. Capped at
 *  100 object deletes per run. A prefix without a meta.json (crash mid-job)
 *  has no exp to trust and is skipped — it is unreachable without a link. */
export async function pruneExportObjects(env: Env, now: number): Promise<number> {
  const grace = 5 * 60_000;
  let pruned = 0;
  const jobs = await env.BRAIN_RAW.list({ prefix: "exports/", delimiter: "/", limit: 200 });
  for (const jobPrefix of jobs.delimitedPrefixes) {
    if (pruned >= 100) break;
    const metaObj = await env.BRAIN_RAW.get(`${jobPrefix}meta.json`);
    if (!metaObj) continue;
    let exp = Number.NaN;
    try {
      exp = Number(((await metaObj.json()) as { exp?: number }).exp);
    } catch {
      exp = Number.NaN;
    }
    if (!Number.isFinite(exp) || exp + grace >= now) continue;
    const objs = await env.BRAIN_RAW.list({ prefix: jobPrefix, limit: 1000 });
    for (const o of objs.objects) {
      if (pruned >= 100) break;
      await env.BRAIN_RAW.delete(o.key);
      pruned += 1;
    }
  }
  return pruned;
}

export async function runSweep(env: Env, now: number = Date.now()): Promise<SweepResult> {
  const del = await env.BRAIN_DB.prepare(`DELETE FROM confirm_tokens WHERE expires_at < ?1`).bind(now).run();
  const pruned_tokens = del.meta.changes ?? 0;

  const pruned_exports = await pruneExportObjects(env, now);
  if (pruned_exports > 0) console.log(`[sweep] export objects pruned: ${pruned_exports}`);

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
