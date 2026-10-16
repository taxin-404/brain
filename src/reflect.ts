import { z } from "zod";
import { writeAudit } from "./audit";
import { newEventId } from "./crypto";
import type { Env } from "./env";
import { json } from "./http";
import { llmJson, LlmError } from "./llm";
import { REFLECTION_PROMPT } from "./prompts";

/** Weekly/monthly reflection (design §8 phase 4): 3-5 durable insights over the
 *  period's facts + events, stored with their fact evidence. Restricted and
 *  purged material is filtered before the prompt and the model's fact ids are
 *  re-intersected with what was actually sent — nothing can leak in or out. */

export interface ReflectionInsight {
  text: string;
  fact_ids: string[];
}

export interface ReflectionRun {
  id: string | null;
  period: "week" | "month";
  period_start: number;
  period_end: number;
  insights: ReflectionInsight[];
  degraded: boolean;
  skipped: boolean;
}

const DAY_MS = 86_400_000;
const MAX_FACTS = 300;
const MAX_EVENTS = 80;
const EXCERPT_CHARS = 200;
const MAX_INSIGHTS = 5;

const reflectionResultSchema = z.object({
  insights: z.array(z.object({ text: z.string(), fact_ids: z.array(z.string()).default([]) })).default([]),
});

export async function runReflection(
  env: Env,
  opts: { period: "week" | "month"; now?: number },
): Promise<ReflectionRun> {
  const db = env.BRAIN_DB;
  const now = opts.now ?? Date.now();
  const start = now - (opts.period === "week" ? 7 : 30) * DAY_MS;

  const { results: facts } = await db
    .prepare(
      `SELECT f.id, e.name AS subject, f.predicate, f.object_text AS object
       FROM facts f JOIN entities e ON e.id = f.subject_id
       WHERE f.status = 'active' AND f.object_text IS NOT NULL AND f.sensitivity != 'restricted'
         AND f.learned_at >= ?1 AND f.learned_at <= ?2
       ORDER BY f.last_confirmed_at DESC
       LIMIT ?3`,
    )
    .bind(start, now, MAX_FACTS)
    .all<{ id: string; subject: string; predicate: string; object: string }>();

  if (facts.length === 0) {
    return { id: null, period: opts.period, period_start: start, period_end: now, insights: [], degraded: false, skipped: true };
  }

  const { results: events } = await db
    .prepare(
      `SELECT ts, excerpt FROM events
       WHERE redacted = 0 AND privacy = 'normal' AND ts >= ?1 AND ts <= ?2
       ORDER BY ts DESC
       LIMIT ?3`,
    )
    .bind(start, now, MAX_EVENTS)
    .all<{ ts: number; excerpt: string | null }>();

  const sentIds = new Set(facts.map((f) => f.id));
  let degraded = false;
  let insights: ReflectionInsight[] = [];
  try {
    const res = await llmJson(
      env,
      {
        system: REFLECTION_PROMPT,
        user: JSON.stringify({
          period: opts.period,
          facts: facts.map((f) => ({ id: f.id, subject: f.subject, predicate: f.predicate, object: f.object })),
          events: events.map((e) => ({ ts: e.ts, excerpt: (e.excerpt ?? "").slice(0, EXCERPT_CHARS) })),
        }),
      },
      (v) => reflectionResultSchema.parse(v),
    );
    insights = res.value.insights
      .map((i) => {
        const ids = [...new Set(i.fact_ids.filter((id) => sentIds.has(id)))];
        return { text: i.text.trim(), fact_ids: ids };
      })
      .filter((i) => i.text.length > 0 && i.fact_ids.length > 0)
      .slice(0, MAX_INSIGHTS);
    if (insights.length === 0) degraded = true; // model produced nothing usable
  } catch (err) {
    if (err instanceof LlmError) {
      degraded = true;
      console.log(`[reflect] degraded: ${String(err)}`);
    } else {
      throw err;
    }
  }

  const id = newEventId();
  await db
    .prepare(
      `INSERT INTO reflections (id, period, period_start, period_end, text, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(id, opts.period, start, now, JSON.stringify(insights), now)
    .run();
  const evidence = [...new Set(insights.flatMap((i) => i.fact_ids))];
  for (const factId of evidence) {
    await db
      .prepare(`INSERT INTO reflection_sources (reflection_id, fact_id, event_id) VALUES (?1, ?2, NULL)`)
      .bind(id, factId)
      .run();
  }
  await writeAudit(db, {
    actor: "system",
    action: "reflect",
    targetType: "reflection",
    targetId: id,
    after: { period: opts.period, insights: insights.length, evidence: evidence.length, degraded },
  });

  return { id, period: opts.period, period_start: start, period_end: now, insights, degraded, skipped: false };
}

/** GET /v1/reflections/latest (read) — newest reflection with its evidence. */
export async function handleReflectionsLatest(env: Env): Promise<Response> {
  const row = await env.BRAIN_DB.prepare(
    `SELECT id, period, period_start, period_end, text, created_at FROM reflections
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).first<{ id: string; period: string; period_start: number; period_end: number; text: string; created_at: number }>();
  if (!row) return json({ error: "not_found" }, 404);
  const { results } = await env.BRAIN_DB.prepare(`SELECT fact_id FROM reflection_sources WHERE reflection_id = ?1`)
    .bind(row.id)
    .all<{ fact_id: string }>();
  let insights: ReflectionInsight[] = [];
  try {
    insights = JSON.parse(row.text) as ReflectionInsight[];
  } catch {
    insights = [];
  }
  return json({
    reflection: {
      id: row.id,
      period: row.period,
      period_start: row.period_start,
      period_end: row.period_end,
      created_at: row.created_at,
      insights,
    },
    fact_ids: results.map((r) => r.fact_id),
  });
}

/** POST /v1/reflect — admin ops kick (single-shot), body {period}. */
export async function handleReflect(request: Request, env: Env): Promise<Response> {
  let body: { period?: string };
  try {
    body = (await request.json()) as { period?: string };
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (body.period !== "week" && body.period !== "month") return json({ error: "bad_period" }, 400);
  return json(await runReflection(env, { period: body.period }));
}
