import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { resolveSubject } from "../src/entities";
import { confirmFact, createFact, purgeFact } from "../src/factstore";
import { runConsolidation } from "../src/consolidate";
import { bearer, call, installFakeVectorize } from "./helpers";
import { network } from "./server";

const GEN_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-3.5-flash-lite:generateContent";
const DAY = 86_400_000;
const T1 = 1_820_000_000_000; // day A
const T2 = T1 + DAY + 3_600_000; // day B

let lastGenBody = "";
let genCalls = 0;

const seedEvent = async (session: string | null, ts: number): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'tool', 1.0, ?4, 'note', 'normal', 'consolidation evidence', ?5)`,
  )
    .bind(id, ts, Date.now(), session, `hmac-${id}`)
    .run();
  return id;
};

const seedInferred = async (opts: {
  subjectId: string;
  subjectName: string;
  predicate: string;
  object: string;
  confidence?: number;
  sensitivity?: string;
  events: Array<{ session: string | null; ts: number }>;
}): Promise<string> => {
  const [first, ...rest] = opts.events;
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
  for (const e of rest) await confirmFact(env, id, await seedEvent(e.session, e.ts), e.ts);
  return id;
};

const handleGen = (result: unknown | (() => unknown)) => {
  network.use(
    http.post(GEN_URL, async ({ request }) => {
      const body = (await request.json()) as { contents: Array<{ parts: Array<{ text: string }> }> };
      lastGenBody = body.contents[0].parts[0].text;
      genCalls += 1;
      const out = typeof result === "function" ? result() : result;
      if (out === "http400") return HttpResponse.text("bad request", { status: 400 });
      return HttpResponse.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      });
    }),
  );
};

describe("runConsolidation", () => {
  beforeAll(async () => {
    await network.enable();
  });
  beforeEach(() => {
    installFakeVectorize();
    lastGenBody = "";
    genCalls = 0;
  });
  afterEach(() => {
    network.resetHandlers();
  });
  afterAll(async () => {
    await network.disable();
  });

  it("retires expired temporary facts and records the run", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "consol expired subject", "Project");
    const expiredId = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "has_status",
      object: "temporarily active",
      events: [{ session: "sx", ts: T1 }],
    });
    await env.BRAIN_DB.prepare(`UPDATE facts SET fact_kind = 'temporary', expires_at = ?1 WHERE id = ?2`)
      .bind(T1 + 1000, expiredId)
      .run();

    const run = await runConsolidation(env, { now: T2 });

    expect(run).toMatchObject({ pruned: 1, merged: 0, superseded: 0, conflicts: 0, degraded: false, new_facts: 0 });
    expect(genCalls).toBe(0); // nothing to ask about
    const row = await env.BRAIN_DB.prepare(`SELECT status, expired_at FROM facts WHERE id = ?1`)
      .bind(expiredId)
      .first<{ status: string; expired_at: number | null }>();
    expect(row).toMatchObject({ status: "archived", expired_at: T2 });

    const runRow = await env.BRAIN_DB.prepare(
      `SELECT new_facts, merged, superseded, conflicts, pruned, report, started_at, finished_at FROM consolidation_runs WHERE id = ?1`,
    )
      .bind(run.id)
      .first<Record<string, unknown>>();
    expect(runRow).toMatchObject({ new_facts: 0, merged: 0, superseded: 0, conflicts: 0, pruned: 1 });
    expect(JSON.parse(String(runRow?.report))).toMatchObject({ degraded: false, expired: [expiredId] });
    const audit = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'consolidate' AND target_id = ?1`,
    )
      .bind(run.id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("applies a cross-unit merge with noisy-OR confidence and points the victim at the survivor", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "consol merge subject", "Project");
    const f1 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      object: "alpha one",
      confidence: 0.6,
      events: [{ session: "s1", ts: T1 }],
    });
    const f2 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      object: "alpha one v2",
      confidence: 0.5,
      events: [{ session: "s2", ts: T2 }],
    });
    handleGen({ merges: [{ survivor_id: f1, victim_id: f2, reason: "same belief" }], supersedes: [], conflicts: [] });

    const run = await runConsolidation(env, { now: T2 + 1000 });

    expect(run).toMatchObject({ merged: 1, superseded: 0, conflicts: 0, degraded: false });
    expect(genCalls).toBe(1);
    expect(lastGenBody).toContain(f1);
    expect(lastGenBody).toContain(f2);
    expect(lastGenBody).toContain("alpha one");

    const survivor = await env.BRAIN_DB.prepare(`SELECT status, confidence FROM facts WHERE id = ?1`)
      .bind(f1)
      .first<{ status: string; confidence: number }>();
    expect(survivor?.status).toBe("active");
    expect(survivor?.confidence).toBeCloseTo(0.8, 5); // 1 - (1-0.6)(1-0.5)

    const victim = await env.BRAIN_DB.prepare(`SELECT status, superseded_by FROM facts WHERE id = ?1`)
      .bind(f2)
      .first<{ status: string; superseded_by: string | null }>();
    expect(victim).toMatchObject({ status: "superseded", superseded_by: f1 });

    const sources = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM fact_sources WHERE fact_id = ?1`)
      .bind(f1)
      .first<{ n: number }>();
    expect(sources?.n).toBe(2);

    expect(run.report.groups_sent).toBe(1);
    expect(run.report.merges).toHaveLength(1);
    expect(run.report.merges[0]).toMatchObject({ survivor: f1, victim: f2 });
    expect(run.report.merges[0].confidence).toBeCloseTo(0.8, 5);
  });

  it("skips merges whose victim adds no new evidence unit", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "consol unit subject", "Project");
    const f1 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      object: "unit alpha",
      events: [{ session: "sa", ts: T1 }],
    });
    const f2 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      object: "unit beta",
      events: [{ session: "sb", ts: T2 }],
    });
    const f3 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      object: "unit gamma",
      events: [{ session: "sa", ts: T1 + 1000 }], // same unit as f1
    });
    handleGen({
      merges: [
        { survivor_id: f1, victim_id: f2 }, // adds unit B -> applied
        { survivor_id: f1, victim_id: f3 }, // only unit A -> skipped
      ],
      supersedes: [],
      conflicts: [],
    });

    const run = await runConsolidation(env, { now: T2 + 1000 });

    expect(run.merged).toBe(1);
    const f3row = await env.BRAIN_DB.prepare(`SELECT status FROM facts WHERE id = ?1`)
      .bind(f3)
      .first<{ status: string }>();
    expect(f3row?.status).toBe("active");
    expect(run.report.skipped).toHaveLength(1);
    expect(run.report.skipped[0]).toMatchObject({ survivor: f1, victim: f3 });
  });

  it("never sends deleted or restricted material, and never resurrects it", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "consol tombstone subject", "Project");
    const deleted = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      object: "zombie codeword",
      events: [{ session: "sz", ts: T1 }],
    });
    await purgeFact(env, deleted, { now: T1 + 2000 });
    const restricted = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "works_on",
      object: "classified codeword",
      sensitivity: "restricted",
      events: [{ session: "sr", ts: T1 }],
    });
    // a normal cross-unit pair so a prompt is actually built
    const f1 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      object: "normal one",
      events: [{ session: "n1", ts: T1 }],
    });
    const f2 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      object: "normal two",
      events: [{ session: "n2", ts: T2 }],
    });
    handleGen({ merges: [{ survivor_id: f1, victim_id: f2 }], supersedes: [], conflicts: [] });

    const run = await runConsolidation(env, { now: T2 + 1000 });

    expect(genCalls).toBe(1);
    expect(lastGenBody).not.toContain("zombie codeword");
    expect(lastGenBody).not.toContain("classified codeword");
    expect(lastGenBody).not.toContain(restricted);

    const deletedRow = await env.BRAIN_DB.prepare(`SELECT status, object_text FROM facts WHERE id = ?1`)
      .bind(deleted)
      .first<{ status: string; object_text: string | null }>();
    expect(deletedRow).toMatchObject({ status: "deleted", object_text: null });
    const fts = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM facts_fts WHERE facts_fts MATCH '"zombie"'`)
      .first<{ n: number }>();
    expect(fts?.n).toBe(0);
    expect(run.merged).toBe(1); // only the normal pair moved
  });

  it("counts conflicts without applying anything and reports them", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "consol conflict subject", "Project");
    const f1 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "has_status",
      object: "status one",
      events: [{ session: "c1", ts: T1 }],
    });
    const f2 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "has_status",
      object: "status two",
      events: [{ session: "c2", ts: T2 }],
    });
    handleGen({
      merges: [],
      supersedes: [],
      conflicts: [{ fact_ids: [f1, f2], reason: "mutually exclusive" }],
    });

    const run = await runConsolidation(env, { now: T2 + 1000 });

    expect(run).toMatchObject({ merged: 0, superseded: 0, conflicts: 1 });
    expect(run.report.conflicts[0]).toMatchObject({ fact_ids: [f1, f2] });
    const rows = await env.BRAIN_DB.prepare(`SELECT status FROM facts WHERE id IN (?1, ?2)`)
      .bind(f1, f2)
      .all<{ status: string }>();
    expect(rows.results.map((r) => r.status)).toEqual(["active", "active"]);
  });

  it("degrades safely when the model call fails: expiry still applied, run still recorded", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "consol degrade subject", "Project");
    const expiredId = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "has_status",
      object: "degrade expired",
      events: [{ session: "d1", ts: T1 }],
    });
    await env.BRAIN_DB.prepare(`UPDATE facts SET fact_kind = 'temporary', expires_at = ?1 WHERE id = ?2`)
      .bind(T1 + 500, expiredId)
      .run();
    const f1 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      object: "degrade one",
      events: [{ session: "d2", ts: T1 }],
    });
    await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      object: "degrade two",
      events: [{ session: "d3", ts: T2 }],
    });
    handleGen("http400");

    const run = await runConsolidation(env, { now: T2 + 1000 });

    expect(run).toMatchObject({ degraded: true, merged: 0, pruned: 1 });
    expect(genCalls).toBe(1);
    const row = await env.BRAIN_DB.prepare(`SELECT status FROM facts WHERE id = ?1`)
      .bind(expiredId)
      .first<{ status: string }>();
    expect(row?.status).toBe("archived");
    const runRow = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM consolidation_runs WHERE id = ?1`)
      .bind(run.id)
      .first<{ n: number }>();
    expect(runRow?.n).toBe(1);
  });

  it("is idempotent: a second run finds nothing to merge and makes no model call", async () => {
    const subject = await resolveSubject(env.BRAIN_DB, "consol idem subject", "Project");
    const f1 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      object: "idem one",
      events: [{ session: "i1", ts: T1 }],
    });
    const f2 = await seedInferred({
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "is_called",
      object: "idem two",
      events: [{ session: "i2", ts: T2 }],
    });
    handleGen({ merges: [{ survivor_id: f1, victim_id: f2 }], supersedes: [], conflicts: [] });

    const first = await runConsolidation(env, { now: T2 + 1000 });
    expect(first.merged).toBe(1);

    const second = await runConsolidation(env, { now: T2 + 2000 });
    expect(second).toMatchObject({ merged: 0, superseded: 0 });
    expect(second.report.merges).toHaveLength(0); // the pair cannot merge twice
    const victimRow = await env.BRAIN_DB.prepare(`SELECT status, superseded_by FROM facts WHERE id = ?1`)
      .bind(f2)
      .first<{ status: string; superseded_by: string | null }>();
    expect(victimRow).toMatchObject({ status: "superseded", superseded_by: f1 });
  });

  it("exposes POST /v1/consolidate to admin only", async () => {
    const res = await call("POST", "/v1/consolidate", undefined, bearer(env, "ADMIN"));
    expect(res.status).toBe(200);
    const body = await res.json<{ id: string; merged: number; degraded: boolean }>();
    expect(typeof body.id).toBe("string");
    expect(body.merged).toBe(0);

    const denied = await call("POST", "/v1/consolidate", undefined, bearer(env, "MCP_READ"));
    expect(denied.status).toBe(403);
  });
});
