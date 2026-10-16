import type { Env } from "./env";
import { readBudget, type BudgetState } from "./budget";
import { chatConfig, embedConfig } from "./llm";

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
  ai: AiHealth;
}

export type AiHealthChat =
  | { mode: "native" | "compat"; model: string; fallback_model?: string }
  | { error: string };

export type AiHealthEmbed =
  | {
      mode: "native" | "compat";
      model: string;
      dims: number;
      signature: string;
      index_dims: number | null;
      matches_index: boolean;
    }
  | { error: string };

export interface AiHealth {
  chat: AiHealthChat;
  embed: AiHealthEmbed;
  reembed_backlog: number;
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
    ai: await aiHealth(env),
  };
}

/** Config self-check for the health route: resolves the AI wiring the worker
 *  would actually use and never throws — a broken config shows up as `error`
 *  while the rest of the report still serves. */
async function aiHealth(env: Env): Promise<AiHealth> {
  let chat: AiHealthChat;
  try {
    const cfg = chatConfig(env);
    chat = { mode: cfg.mode, model: cfg.model, ...(cfg.fallback ? { fallback_model: cfg.fallback } : {}) };
  } catch (err) {
    chat = { error: err instanceof Error ? err.message : String(err) };
  }

  let embed: AiHealthEmbed;
  let reembed_backlog = 0;
  try {
    const cfg = embedConfig(env);
    let indexDims: number | null = null;
    try {
      const info = await env.VECTORIZE.describe();
      indexDims = "dimensions" in info.config ? info.config.dimensions : null;
    } catch {
      indexDims = null; // local dev / unavailable index: report unknown, not broken
    }
    embed = {
      mode: cfg.mode,
      model: cfg.model,
      dims: cfg.dims,
      signature: cfg.signature,
      index_dims: indexDims,
      matches_index: indexDims === cfg.dims,
    };
    const row = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM facts
       WHERE (vec_id IS NULL OR (embedding_model IS NOT ?1 AND embedding_model IS NOT ?2))
         AND sensitivity != 'restricted' AND status = 'active'`,
    )
      .bind(cfg.model, cfg.signature)
      .first<{ n?: number }>();
    reembed_backlog = row?.n ?? 0;
  } catch (err) {
    embed = { error: err instanceof Error ? err.message : String(err) };
  }

  return { chat, embed, reembed_backlog };
}
