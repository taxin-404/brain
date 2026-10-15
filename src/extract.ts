import type { Env } from "./env";
import { writeAudit } from "./audit";
import { embedPendingFacts } from "./embed";
import { resolveSubject } from "./entities";
import { newFactId, normalizeCandidates, type SourceActor, type SourceContext } from "./facts";
import { json } from "./http";
import { EXTRACTION_MODEL, geminiJson, LlmError } from "./llm";
import { FACT_EXTRACTION_PROMPT } from "./prompts";

export interface ExtractionRun {
  processed: number;
  facts: number;
  failed: number;
  calls: number;
  injection: number;
  /** facts embedded + upserted into Vectorize by the run's trailing embed pass */
  embedded: number;
  /** embedding passes that failed (retried on a later sweep) */
  embedFailed: number;
}

export const EXTRACTION_CAPS = {
  sweep: { maxEvents: 40, maxCalls: 4 },
  manual: { maxEvents: 100, maxCalls: 10 },
} as const;

const CHUNK = 10;
const MAX_ATTEMPTS = 3;
const ERROR_MAX = 300;

interface PendingRow {
  id: string;
  attempts: number;
  actor: string;
  trust: number;
  ts: number;
  session_id: string | null;
  excerpt: string | null;
}

const chunked = <T>(xs: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
};

const inMarks = (ids: string[], offset: number): string =>
  ids.map((_, i) => `?${i + offset}`).join(", ");

/** Queue + extract durable facts from pending events, per the plan's R1 ruling:
 *  the 30-minute sweep and the admin kick call this; ingest never does.
 *  Counters: `processed` = events marked done (incl. injection-marked),
 *  `failed` = events that hit their third attempt, `facts` = newly created rows
 *  (dedupe confirmations are not counted), `calls` = gateway calls made,
 *  `injection` = injected events detected. Retryable errors return the chunk to
 *  `pending` and are not counted as processed/failed. */
export async function processExtractions(
  env: Env,
  opts: { maxEvents?: number; maxCalls?: number; now?: number } = {},
): Promise<ExtractionRun> {
  const now = opts.now ?? Date.now();
  const maxEvents = opts.maxEvents ?? EXTRACTION_CAPS.sweep.maxEvents;
  const maxCalls = opts.maxCalls ?? EXTRACTION_CAPS.sweep.maxCalls;
  const db = env.BRAIN_DB;
  const run: ExtractionRun = { processed: 0, facts: 0, failed: 0, calls: 0, injection: 0, embedded: 0, embedFailed: 0 };

  // 1. queue extractable events that have no row yet (restricted and purged
  //    events never queue; tombstones are system bookkeeping, not content)
  await db
    .prepare(
      `INSERT OR IGNORE INTO extractions (event_id, status, created_at, updated_at)
       SELECT e.id, 'pending', ?1, ?1 FROM events e
       LEFT JOIN extractions x ON x.event_id = e.id
       WHERE x.event_id IS NULL AND e.privacy != 'restricted' AND e.redacted = 0 AND e.kind != 'purge_tombstone'
       ORDER BY e.ts ASC LIMIT ?2`,
    )
    .bind(now, maxEvents)
    .run();

  // 2. take the oldest pending batch
  const { results: rows } = await db
    .prepare(
      `SELECT x.event_id AS id, x.attempts AS attempts, e.actor AS actor, e.trust AS trust, e.ts AS ts,
              e.session_id AS session_id, e.excerpt AS excerpt
       FROM extractions x JOIN events e ON e.id = x.event_id
       WHERE x.status = 'pending' AND e.privacy != 'restricted' AND e.redacted = 0
       ORDER BY e.ts ASC LIMIT ?1`,
    )
    .bind(maxEvents)
    .all<PendingRow>();

  // 3. sequential chunks of ≤10 excerpts, one gateway call per chunk
  for (const chunk of chunked(rows, CHUNK)) {
    if (run.calls >= maxCalls) break;
    run.calls += 1;

    const ids = chunk.map((r) => r.id);
    await db
      .prepare(
        `UPDATE extractions SET status = 'running', attempts = attempts + 1, updated_at = ?1
         WHERE event_id IN (${inMarks(ids, 2)})`,
      )
      .bind(now, ...ids)
      .run();

    const ctx = new Map<string, SourceContext>(
      chunk.map((r) => [r.id, { actor: r.actor as SourceActor, trust: r.trust }]),
    );
    const lines = chunk.map((r) => ({ event_id: r.id, actor: r.actor, trust: r.trust, excerpt: r.excerpt ?? "" }));

    try {
      const { value, tokensIn, tokensOut } = await geminiJson(
        env,
        { system: FACT_EXTRACTION_PROMPT, user: JSON.stringify(lines) },
        (v) => normalizeCandidates(v, ctx),
      );

      // 4. subject → entity, then insert-or-confirm each fact
      const perEvent = new Map<string, number>();
      for (const fact of value.facts) {
        const subject = await resolveSubject(db, fact.subject, fact.subjectType, now);
        const existing = await db
          .prepare(
            `SELECT id FROM facts WHERE subject_id = ?1 AND predicate = ?2 AND object_text = ?3
             AND status = 'active' LIMIT 1`,
          )
          .bind(subject.id, fact.predicate, fact.objectText)
          .first<{ id: string }>();
        if (existing) {
          await db.prepare(`UPDATE facts SET last_confirmed_at = ?1 WHERE id = ?2`).bind(now, existing.id).run();
          await db
            .prepare(`INSERT OR IGNORE INTO fact_sources (fact_id, event_id) VALUES (?1, ?2)`)
            .bind(existing.id, fact.eventId)
            .run();
        } else {
          const factId = newFactId();
          await db
            .prepare(
              `INSERT INTO facts (id, subject_id, predicate, object_text, fact_kind, confidence, status,
                                  valid_at, expires_at, learned_at, first_seen_at, last_confirmed_at,
                                  sensitivity, source_event_id, embedding_model)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?9, ?9, ?9, ?10, ?11, 'gemini-embedding-001')`,
            )
            .bind(
              factId,
              subject.id,
              fact.predicate,
              fact.objectText,
              fact.factKind,
              fact.confidence,
              fact.validAt ?? null,
              fact.expiresAt ?? null,
              now,
              fact.sensitivity,
              fact.eventId,
            )
            .run();
          // facts_fts is external-content with no triggers (0002): index manually
          await db
            .prepare(`INSERT INTO facts_fts(rowid, object_text) SELECT rowid, object_text FROM facts WHERE id = ?1`)
            .bind(factId)
            .run();
          await db
            .prepare(`INSERT OR IGNORE INTO fact_sources (fact_id, event_id) VALUES (?1, ?2)`)
            .bind(factId, fact.eventId)
            .run();
          await writeAudit(db, {
            actor: "system",
            action: "create",
            targetType: "fact",
            targetId: factId,
            after: {
              subject: fact.subject,
              predicate: fact.predicate,
              object: fact.objectText,
              fact_kind: fact.factKind,
              confidence: fact.confidence,
              sensitivity: fact.sensitivity,
              event_id: fact.eventId,
            },
          });
          run.facts += 1;
          perEvent.set(fact.eventId, (perEvent.get(fact.eventId) ?? 0) + 1);
        }
      }

      // 5. mark the chunk done; the chunk's token totals land on the first row
      for (let i = 0; i < chunk.length; i += 1) {
        const r = chunk[i];
        await db
          .prepare(
            `UPDATE extractions SET status = 'done', facts_created = ?1, tokens_in = ?2, tokens_out = ?3,
                                    model = ?4, updated_at = ?5 WHERE event_id = ?6`,
          )
          .bind(perEvent.get(r.id) ?? 0, i === 0 ? tokensIn : 0, i === 0 ? tokensOut : 0, EXTRACTION_MODEL, now, r.id)
          .run();
      }

      if (value.injectionEvents.length > 0) {
        await db
          .prepare(
            `UPDATE extractions SET injection_suspected = 1, facts_created = 0, updated_at = ?1
             WHERE event_id IN (${inMarks(value.injectionEvents, 2)})`,
          )
          .bind(now, ...value.injectionEvents)
          .run();
        run.injection += value.injectionEvents.length;
      }
      run.processed += chunk.length;
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      const newAttempts = Math.max(...chunk.map((r) => r.attempts)) + 1;
      const status = newAttempts < MAX_ATTEMPTS ? "pending" : "failed";
      await db
        .prepare(
          `UPDATE extractions SET status = ?1, error = ?2, updated_at = ?3
           WHERE event_id IN (${inMarks(ids, 4)})`,
        )
        .bind(status, err.message.slice(0, ERROR_MAX), now, ...ids)
        .run();
      if (status === "failed") run.failed += chunk.length;
    }
  }

  // 6. embed newly created facts (best-effort; failures retry next sweep)
  const embs = await embedPendingFacts(env);
  run.embedded = embs.embedded;
  run.embedFailed = embs.failed;

  return run;
}

/** Admin manual kick (POST /v1/extract): the same pipeline as the sweep,
 *  clamped to the manual caps. Body: { max_events?, max_calls? } (optional). */
export async function handleExtract(request: Request, env: Env): Promise<Response> {
  let body: { max_events?: number; max_calls?: number } = {};
  try {
    body = (await request.json()) as { max_events?: number; max_calls?: number };
  } catch {
    body = {}; // empty or invalid body: manual defaults
  }
  const clamp = (v: number | undefined, cap: number) =>
    Number.isFinite(v) ? Math.max(1, Math.min(cap, Math.trunc(v as number))) : cap;
  const run = await processExtractions(env, {
    maxEvents: clamp(body.max_events, EXTRACTION_CAPS.manual.maxEvents),
    maxCalls: clamp(body.max_calls, EXTRACTION_CAPS.manual.maxCalls),
  });
  return json(run);
}
