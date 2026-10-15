import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { resolveSubject } from "../src/entities";
import { confirmFact, createFact, purgeFact } from "../src/factstore";
import { runConsolidation } from "../src/consolidate";
import { fakeVec, installFakeVectorize, type StoredVector } from "./helpers";
import { network } from "./server";

/** Consolidation mini-eval (design §8 phase 4 "done when"): a nightly run must
 *  merge cross-unit duplicates only, honor tombstones (nothing deleted or
 *  restricted leaks into or out of the run), and prune. This scripted scenario
 *  pins that end to end. */

const GEN_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-3.5-flash-lite:generateContent";
const DAY = 86_400_000;
const T1 = 1_830_000_000_000; // day A
const T2 = T1 + DAY + 3_600_000; // day B

let lastGenBody = "";
let genCalls = 0;

const seedEvent = async (session: string | null, ts: number): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'tool', 1.0, ?4, 'note', 'normal', 'eval evidence', ?5)`,
  )
    .bind(id, ts, Date.now(), session, `hmac-${id}`)
    .run();
  return id;
};

const seedFact = async (opts: {
  subjectId: string;
  subjectName: string;
  predicate: string;
  object: string;
  confidence?: number;
  sensitivity?: string;
  sources: Array<{ session: string | null; ts: number }>;
}): Promise<string> => {
  const [first, ...rest] = opts.sources;
  const id = await createFact(env, {
    subjectId: opts.subjectId,
    subjectName: opts.subjectName,
    predicate: opts.predicate,
    objectText: opts.object,
    factKind: "inferred",
    confidence: opts.confidence ?? 0.5,
    sensitivity: opts.sensitivity ?? "normal",
    sourceEventId: await seedEvent(first.session, first.ts),
  });
  for (const s of rest) await confirmFact(env, id, await seedEvent(s.session, s.ts), s.ts);
  return id;
};

describe("eval: consolidation", () => {
  let store: Map<string, StoredVector>;
  beforeAll(async () => {
    await network.enable();
  });
  beforeEach(() => {
    store = installFakeVectorize();
    lastGenBody = "";
    genCalls = 0;
  });
  afterEach(() => {
    network.resetHandlers();
  });
  afterAll(async () => {
    await network.disable();
  });

  it("merges cross-unit duplicates only, honors tombstones and prunes vectors", async () => {
    // Cross-unit duplicates: two sessions, two days, same belief.
    const dupSubject = await resolveSubject(env.BRAIN_DB, "eval dup subject", "Project");
    const f1 = await seedFact({
      subjectId: dupSubject.id,
      subjectName: dupSubject.name,
      predicate: "completed_on_time",
      object: "alpha completed in one day",
      confidence: 0.5,
      sources: [{ session: "sess-a", ts: T1 }],
    });
    const f2 = await seedFact({
      subjectId: dupSubject.id,
      subjectName: dupSubject.name,
      predicate: "completed_on_time",
      object: "alpha done within a day",
      confidence: 0.4,
      sources: [{ session: "sess-b", ts: T2 }],
    });

    // Same-unit pair: same session and UTC day -> must never be sent or merged.
    const unitSubject = await resolveSubject(env.BRAIN_DB, "eval unit subject", "Project");
    const g1 = await seedFact({
      subjectId: unitSubject.id,
      subjectName: unitSubject.name,
      predicate: "completed_on_time",
      object: "same unit one",
      sources: [{ session: "sess-same", ts: T1 + 1000 }],
    });
    const g2 = await seedFact({
      subjectId: unitSubject.id,
      subjectName: unitSubject.name,
      predicate: "completed_on_time",
      object: "same unit two",
      sources: [{ session: "sess-same", ts: T1 + 2000 }],
    });

    // Expired temporary fact (with a vector -> pruning source #1).
    const expired = await seedFact({
      subjectId: dupSubject.id,
      subjectName: dupSubject.name,
      predicate: "has_status",
      object: "eval expired belief",
      sources: [{ session: "sess-x", ts: T1 }],
    });
    await env.BRAIN_DB.prepare(`UPDATE facts SET fact_kind = 'temporary', expires_at = ?1 WHERE id = ?2`)
      .bind(T2 - 1000, expired)
      .run();
    store.set(expired, { id: expired, values: fakeVec("eval expired belief"), metadata: {} });

    // Deleted fact: text purged, must not resurrect anywhere.
    const deleted = await seedFact({
      subjectId: dupSubject.id,
      subjectName: dupSubject.name,
      predicate: "uses",
      object: "zombie eval codeword",
      sources: [{ session: "sess-z", ts: T1 }],
    });
    await purgeFact(env, deleted, { now: T1 + 500 });

    // Restricted fact: never serialized to the model.
    const restricted = await seedFact({
      subjectId: dupSubject.id,
      subjectName: dupSubject.name,
      predicate: "works_on",
      object: "classified eval codeword",
      sensitivity: "restricted",
      sources: [{ session: "sess-r", ts: T1 }],
    });

    // The victim's vector (pruning source #2).
    store.set(f2, { id: f2, values: fakeVec("alpha done within a day"), metadata: {} });
    const vectorsBefore = store.size;

    network.use(
      http.post(GEN_URL, async ({ request }) => {
        const body = (await request.json()) as { contents: Array<{ parts: Array<{ text: string }> }> };
        lastGenBody = body.contents[0].parts[0].text;
        genCalls += 1;
        return HttpResponse.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      merges: [{ survivor_id: f1, victim_id: f2, reason: "same belief across days" }],
                      supersedes: [],
                      conflicts: [],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
        });
      }),
    );

    const run = await runConsolidation(env, { now: T2 + 1000 });

    // One bounded model call; tombstones and restricted material never serialized.
    expect(genCalls).toBe(1);
    expect(lastGenBody).toContain(f1);
    expect(lastGenBody).toContain(f2);
    expect(lastGenBody).not.toContain(restricted);
    expect(lastGenBody).not.toContain("classified eval codeword");
    expect(lastGenBody).not.toContain(deleted);
    expect(lastGenBody).not.toContain("zombie eval codeword");
    expect(lastGenBody).not.toContain(g1);
    expect(lastGenBody).not.toContain(g2);
    expect(lastGenBody).not.toContain("same unit one");

    // Cross-unit merge applied with noisy-OR (1 - (1-0.5)(1-0.4) = 0.7).
    expect(run).toMatchObject({ merged: 1, superseded: 0, conflicts: 0, pruned: 1, degraded: false, new_facts: 0 });
    const survivor = await env.BRAIN_DB.prepare(`SELECT status, confidence FROM facts WHERE id = ?1`)
      .bind(f1)
      .first<{ status: string; confidence: number }>();
    expect(survivor?.status).toBe("active");
    expect(survivor?.confidence).toBeCloseTo(0.7, 5);
    const victim = await env.BRAIN_DB.prepare(`SELECT status, superseded_by FROM facts WHERE id = ?1`)
      .bind(f2)
      .first<{ status: string; superseded_by: string | null }>();
    expect(victim).toMatchObject({ status: "superseded", superseded_by: f1 });

    // Same-unit pair untouched and both still active.
    const unitRows = await env.BRAIN_DB.prepare(`SELECT id, status FROM facts WHERE id IN (?1, ?2)`)
      .bind(g1, g2)
      .all<{ id: string; status: string }>();
    expect(unitRows.results.map((r) => r.status)).toEqual(["active", "active"]);

    // Expired retired; deleted stays tombstoned; restricted stays untouched.
    const expiredRow = await env.BRAIN_DB.prepare(`SELECT status, expired_at FROM facts WHERE id = ?1`)
      .bind(expired)
      .first<{ status: string; expired_at: number | null }>();
    expect(expiredRow).toMatchObject({ status: "archived", expired_at: T2 + 1000 });
    const deletedRow = await env.BRAIN_DB.prepare(`SELECT status, object_text FROM facts WHERE id = ?1`)
      .bind(deleted)
      .first<{ status: string; object_text: string | null }>();
    expect(deletedRow).toMatchObject({ status: "deleted", object_text: null });
    const fts = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM facts_fts WHERE facts_fts MATCH '"zombie"'`)
      .first<{ n: number }>();
    expect(fts?.n).toBe(0);
    const restrictedRow = await env.BRAIN_DB.prepare(`SELECT status FROM facts WHERE id = ?1`)
      .bind(restricted)
      .first<{ status: string }>();
    expect(restrictedRow?.status).toBe("active");

    // Pruning demonstrably reduced the vector store.
    expect(store.size).toBeLessThan(vectorsBefore);
    expect(store.has(f2)).toBe(false);
    expect(store.has(expired)).toBe(false);

    // Run recorded with a parseable report.
    const runRow = await env.BRAIN_DB.prepare(
      `SELECT new_facts, merged, superseded, conflicts, pruned, report FROM consolidation_runs WHERE id = ?1`,
    )
      .bind(run.id)
      .first<Record<string, unknown>>();
    expect(runRow).toMatchObject({ new_facts: 0, merged: 1, superseded: 0, conflicts: 0, pruned: 1 });
    const report = JSON.parse(String(runRow?.report)) as { expired: string[]; groups_sent: number; merges: unknown[] };
    expect(report.expired).toEqual([expired]);
    expect(report.groups_sent).toBe(1);
    expect(report.merges).toHaveLength(1);
  });
});
