import { z } from "zod";
import { writeAudit } from "./audit";
import { newEventId } from "./crypto";
import type { Env } from "./env";
import { expireFact, mergeFacts, supersedeFact } from "./factstore";
import { MULTIVALUED_PREDICATES } from "./facts";
import { json } from "./http";
import { llmJson, LlmError } from "./llm";
import { CONSOLIDATION_PROMPT } from "./prompts";

/** Nightly consolidation (design §8 phase 4): retire lapsed `temporary` facts,
 *  then merge near-duplicate `inferred` facts — only across distinct evidence
 *  units (`session_id` + UTC calendar day) — with one bounded model call per
 *  run. Conflicts are reported, never resolved; failures degrade the run but
 *  never fail the cron. Tombstoned material (deleted facts, restricted rows)
 *  never reaches the prompt. */

export interface ConsolidationReport {
  degraded: boolean;
  expired: string[];
  groups_sent: number;
  merges: Array<{ survivor: string; victim: string; confidence: number }>;
  supersedes: Array<{ old: string; new: string }>;
  conflicts: Array<{ fact_ids: string[]; reason: string }>;
  skipped: Array<{ survivor?: string; victim?: string; why: string }>;
}

export interface ConsolidationRun {
  id: string;
  started_at: number;
  finished_at: number;
  new_facts: number;
  merged: number;
  superseded: number;
  conflicts: number;
  pruned: number;
  degraded: boolean;
  report: ConsolidationReport;
}

const MAX_EXPIRED = 100;
const DEFAULT_MAX_FACTS = 200;
const DEFAULT_MAX_GROUPS = 20;
const MAX_FACTS_PER_GROUP = 6;
const CHAR_CAP = 8000;
const DAY_MS = 86_400_000;

const consolidationResultSchema = z.object({
  merges: z
    .array(z.object({ survivor_id: z.string(), victim_id: z.string(), reason: z.string().optional() }))
    .default([]),
  supersedes: z
    .array(z.object({ old_id: z.string(), new_id: z.string(), reason: z.string().optional() }))
    .default([]),
  conflicts: z.array(z.object({ fact_ids: z.array(z.string()), reason: z.string().optional() })).default([]),
});
type ConsolidationResult = z.infer<typeof consolidationResultSchema>;

interface CandidateFact {
  id: string;
  subject_id: string;
  predicate: string;
  object_text: string;
  confidence: number;
  units: Set<string>;
}

interface CandidateGroup {
  subject: string;
  predicate: string;
  facts: CandidateFact[];
}

/** Group active inferred facts by (subject, predicate), attach evidence units
 *  (`session_id:utcDay`), and keep only groups worth asking about: ≥2 rows,
 *  ≥2 distinct units across the group, predicate not multivalued. */
async function loadCandidateGroups(env: Env, maxFacts: number): Promise<Map<string, CandidateGroup>> {
  const db = env.BRAIN_DB;
  const { results: rows } = await db
    .prepare(
      `SELECT f.id, f.subject_id, f.predicate, f.object_text, f.confidence, e.name AS subject
       FROM facts f JOIN entities e ON e.id = f.subject_id
       WHERE f.status = 'active' AND f.fact_kind = 'inferred' AND f.object_text IS NOT NULL
         AND f.sensitivity != 'restricted'
       ORDER BY f.last_confirmed_at DESC
       LIMIT ?1`,
    )
    .bind(maxFacts)
    .all<{ id: string; subject_id: string; predicate: string; object_text: string; confidence: number; subject: string }>();

  const byId = new Map<string, CandidateFact & { subject: string }>();
  for (const r of rows) byId.set(r.id, { ...r, units: new Set<string>() });

  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(", ");
    const { results: sources } = await db
      .prepare(
        `SELECT fs.fact_id, ev.session_id, ev.ts
         FROM fact_sources fs JOIN events ev ON ev.id = fs.event_id
         WHERE fs.fact_id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<{ fact_id: string; session_id: string | null; ts: number }>();
    for (const s of sources) {
      const f = byId.get(s.fact_id);
      if (!f) continue;
      f.units.add(`${s.session_id ?? "none"}:${Math.floor(s.ts / DAY_MS)}`);
    }
  }

  const grouped = new Map<string, CandidateGroup>();
  for (const f of byId.values()) {
    if (MULTIVALUED_PREDICATES.has(f.predicate)) continue;
    const key = `${f.subject_id}|${f.predicate}`;
    const g = grouped.get(key) ?? { subject: f.subject, predicate: f.predicate, facts: [] };
    g.facts.push({
      id: f.id,
      subject_id: f.subject_id,
      predicate: f.predicate,
      object_text: f.object_text,
      confidence: f.confidence,
      units: f.units,
    });
    grouped.set(key, g);
  }

  const keep = new Map<string, CandidateGroup>();
  for (const [key, g] of grouped) {
    if (g.facts.length < 2) continue;
    const units = new Set<string>();
    for (const f of g.facts) for (const u of f.units) units.add(u);
    if (units.size < 2) continue; // repeats inside one unit: nothing to consolidate
    keep.set(key, g);
  }
  return keep;
}

/** Noisy-OR over distinct units with each unit taking the max row confidence. */
function noisyOr(survivor: CandidateFact, victim: CandidateFact): number {
  const unitConf = new Map<string, number>();
  for (const u of survivor.units) unitConf.set(u, Math.max(unitConf.get(u) ?? 0, survivor.confidence));
  for (const u of victim.units) unitConf.set(u, Math.max(unitConf.get(u) ?? 0, victim.confidence));
  let remain = 1;
  for (const c of unitConf.values()) remain *= 1 - c;
  return Math.min(0.85, 1 - remain);
}

const isSubset = (a: Set<string>, b: Set<string>): boolean => {
  for (const u of a) if (!b.has(u)) return false;
  return true;
};

export async function runConsolidation(
  env: Env,
  opts: { now?: number; maxGroups?: number; maxFacts?: number } = {},
): Promise<ConsolidationRun> {
  const db = env.BRAIN_DB;
  const now = opts.now ?? Date.now();
  const startedAt = now;
  const id = newEventId();
  const report: ConsolidationReport = {
    degraded: false,
    expired: [],
    groups_sent: 0,
    merges: [],
    supersedes: [],
    conflicts: [],
    skipped: [],
  };
  let merged = 0;
  let superseded = 0;
  let pruned = 0;

  // 1) Retire lapsed temporary facts (bounded; the next run continues).
  const { results: lapsed } = await db
    .prepare(
      `SELECT id FROM facts
       WHERE status = 'active' AND fact_kind = 'temporary' AND expires_at IS NOT NULL AND expires_at <= ?1
       LIMIT ?2`,
    )
    .bind(now, MAX_EXPIRED)
    .all<{ id: string }>();
  for (const row of lapsed) {
    try {
      await expireFact(env, row.id, { now });
      report.expired.push(row.id);
      pruned += 1;
    } catch (err) {
      console.log(`[consolidate] expire skipped for ${row.id}: ${String(err)}`);
    }
  }

  // 2) Build the bounded prompt payload (≤ groups / facts / chars).
  const groups = await loadCandidateGroups(env, opts.maxFacts ?? DEFAULT_MAX_FACTS);
  const maxGroups = opts.maxGroups ?? DEFAULT_MAX_GROUPS;
  const payload: Array<{ subject: string; predicate: string; facts: Array<Record<string, unknown>> }> = [];
  const sentById = new Map<string, CandidateFact>();
  let chars = 0;
  for (const g of groups.values()) {
    if (payload.length >= maxGroups) break;
    const facts = g.facts.slice(0, MAX_FACTS_PER_GROUP);
    const piece = JSON.stringify({ subject: g.subject, predicate: g.predicate, facts });
    if (chars + piece.length > CHAR_CAP) break;
    chars += piece.length;
    payload.push({
      subject: g.subject,
      predicate: g.predicate,
      facts: facts.map((f) => ({
        id: f.id,
        object: f.object_text,
        confidence: f.confidence,
        fact_kind: "inferred",
        units: f.units.size,
      })),
    });
    for (const f of facts) sentById.set(f.id, f);
  }

  // 3) One model call (only when there is something to ask about).
  let result: ConsolidationResult | null = null;
  if (payload.length > 0) {
    report.groups_sent = payload.length;
    try {
      const res = await llmJson(env, { system: CONSOLIDATION_PROMPT, user: JSON.stringify({ groups: payload }) }, (v) =>
        consolidationResultSchema.parse(v),
      );
      result = res.value;
    } catch (err) {
      if (err instanceof LlmError) {
        report.degraded = true;
        console.log(`[consolidate] degraded: ${String(err)}`);
      } else {
        throw err;
      }
    }
  }

  // 4) Apply merges under deterministic guards; supersedes; count conflicts.
  let conflicts = 0;
  if (result) {
    const mergedVictims = new Set<string>();
    for (const m of result.merges) {
      const s = sentById.get(m.survivor_id);
      const v = sentById.get(m.victim_id);
      const why =
        !s || !v
          ? "unknown id"
          : s.id === v.id
            ? "self merge"
            : s.subject_id !== v.subject_id || s.predicate !== v.predicate
              ? "group mismatch"
              : mergedVictims.has(v.id)
                ? "victim already merged"
                : isSubset(v.units, s.units)
                  ? "victim adds no evidence unit"
                  : null;
      if (why !== null || !s || !v) {
        report.skipped.push({ survivor: m.survivor_id, victim: m.victim_id, why: why ?? "unknown id" });
        continue;
      }
      const confidence = noisyOr(s, v);
      try {
        await mergeFacts(env, s.id, v.id, { now, confidence });
        mergedVictims.add(v.id);
        merged += 1;
        report.merges.push({ survivor: s.id, victim: v.id, confidence });
      } catch (err) {
        report.skipped.push({ survivor: s.id, victim: v.id, why: `merge failed: ${String(err)}` });
      }
    }

    for (const sp of result.supersedes) {
      const o = sentById.get(sp.old_id);
      const n = sentById.get(sp.new_id);
      if (!o || !n || o.id === n.id || o.subject_id !== n.subject_id || o.predicate !== n.predicate) {
        report.skipped.push({ survivor: sp.old_id, victim: sp.new_id, why: "supersede guard" });
        continue;
      }
      try {
        await supersedeFact(env, o.id, n.id, now);
        superseded += 1;
        report.supersedes.push({ old: o.id, new: n.id });
      } catch (err) {
        report.skipped.push({ survivor: o.id, victim: n.id, why: `supersede failed: ${String(err)}` });
      }
    }

    for (const c of result.conflicts) {
      conflicts += 1;
      report.conflicts.push({ fact_ids: c.fact_ids, reason: c.reason ?? "" });
    }
  }

  // 5) Record the run (one row + one audit entry, always).
  const finishedAt = Date.now();
  await db
    .prepare(
      `INSERT INTO consolidation_runs (id, started_at, finished_at, new_facts, merged, superseded, conflicts, pruned, report)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(id, startedAt, finishedAt, 0, merged, superseded, conflicts, pruned, JSON.stringify(report))
    .run();
  await writeAudit(db, {
    actor: "system",
    action: "consolidate",
    targetType: "consolidation_run",
    targetId: id,
    after: { merged, superseded, conflicts, pruned, degraded: report.degraded, groups_sent: report.groups_sent },
  });

  return {
    id,
    started_at: startedAt,
    finished_at: finishedAt,
    new_facts: 0,
    merged,
    superseded,
    conflicts,
    pruned,
    degraded: report.degraded,
    report,
  };
}

/** POST /v1/consolidate — admin ops kick for the nightly run (single-shot). */
export async function handleConsolidate(env: Env): Promise<Response> {
  return json(await runConsolidation(env));
}
