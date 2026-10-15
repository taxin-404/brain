import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { resolveSubject } from "../src/entities";
import { EXTRACTION_CAPS, processExtractions } from "../src/extract";
import { network } from "./server";

const GEN_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-3.5-flash-lite:generateContent";

interface Line {
  event_id: string;
  actor: string;
  trust: number;
  excerpt: string;
}

let nextTs = 1_700_000_000_000;

const seedEvent = async (
  over: Partial<{ actor: "user" | "assistant" | "tool" | "external"; trust: number; privacy: string; excerpt: string }> = {},
) => {
  const id = newEventId();
  const ts = (nextTs += 1000);
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', ?4, ?5, ?6, 'note', ?7, ?8, ?9)`,
  )
    .bind(
      id,
      ts,
      Date.now(),
      over.actor ?? "user",
      over.trust ?? 1.0,
      `extract-${id}`,
      over.privacy ?? "normal",
      over.excerpt ?? `note ${id}`,
      `hmac-${id}`,
    )
    .run();
  return id;
};

const reply = (text: string, tokensIn = 42, tokensOut = 7) => ({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: tokensIn, candidatesTokenCount: tokensOut },
});

const handleGen = (fn: (lines: Line[]) => string) =>
  network.use(
    http.post(GEN_URL, async ({ request }) => {
      const body = (await request.json()) as { contents: Array<{ parts: Array<{ text: string }> }> };
      const lines = JSON.parse(body.contents[0].parts[0].text) as Line[];
      return HttpResponse.json(reply(fn(lines)));
    }),
  );

describe("resolveSubject", () => {
  it("maps SELF aliases to the Person 'user' entity and reuses it", async () => {
    const a = await resolveSubject(env.BRAIN_DB, "Taxin-404", undefined, 111);
    expect(a).toMatchObject({ name: "user", norm: "user", created: true });
    const b = await resolveSubject(env.BRAIN_DB, "owner", undefined, 222);
    expect(b).toMatchObject({ id: a.id, created: false });
    const row = await env.BRAIN_DB.prepare(`SELECT type, last_seen_at FROM entities WHERE id = ?1`)
      .bind(a.id)
      .first<{ type: string; last_seen_at: number }>();
    expect(row).toMatchObject({ type: "Person", last_seen_at: 222 });
  });

  it("resolves by exact type, then any-type norm, else creates a Project", async () => {
    const created = await resolveSubject(env.BRAIN_DB, "Brain Repo", "Project", 333);
    expect(created).toMatchObject({ name: "Brain Repo", norm: "brain repo", created: true });
    const exact = await resolveSubject(env.BRAIN_DB, "brain repo", "Project", 444);
    expect(exact).toMatchObject({ id: created.id, created: false });
    const anyType = await resolveSubject(env.BRAIN_DB, "brain-repo", undefined, 555);
    expect(anyType).toMatchObject({ id: created.id, created: false });
    const row = await env.BRAIN_DB.prepare(`SELECT type, last_seen_at FROM entities WHERE id = ?1`)
      .bind(created.id)
      .first<{ type: string; last_seen_at: number }>();
    expect(row).toMatchObject({ type: "Project", last_seen_at: 555 });

    const fallback = await resolveSubject(env.BRAIN_DB, "Some New Thing", undefined, 666);
    expect(fallback).toMatchObject({ name: "Some New Thing", norm: "some new thing", created: true });
    const fallbackRow = await env.BRAIN_DB.prepare(`SELECT type FROM entities WHERE id = ?1`)
      .bind(fallback.id)
      .first<{ type: string }>();
    expect(fallbackRow?.type).toBe("Project");
  });
});

describe("processExtractions", () => {
  beforeAll(async () => {
    await network.enable();
  });
  afterEach(() => {
    network.resetHandlers();
  });
  afterAll(async () => {
    await network.disable();
  });

  it("stores facts, entities and bookkeeping for a successful chunk", async () => {
    const a = await seedEvent({ excerpt: "I prefer Neovim as my editor" });
    const b = await seedEvent({ excerpt: "I live in Berlin" });
    const now = 1_800_000_000_000;
    handleGen((lines) =>
      JSON.stringify(
        lines.map((l) => ({
          subject: "user",
          subject_type: "Person",
          predicate: l.excerpt.includes("Neovim") ? "prefers editor" : "lives in",
          object: l.excerpt.includes("Neovim") ? "Neovim" : "Berlin",
          fact_kind: "user_stated",
          confidence: 0.9,
          event_id: l.event_id,
        })),
      ),
    );

    const run = await processExtractions(env, { now });
    expect(run).toMatchObject({ processed: 2, facts: 2, failed: 0, calls: 1, injection: 0 });

    const facts = await env.BRAIN_DB.prepare(
      `SELECT f.predicate, f.object_text, f.fact_kind, f.confidence, f.sensitivity, f.learned_at,
              f.embedding_model, f.vec_id, e.type AS subject_type, e.norm_name
       FROM facts f JOIN entities e ON e.id = f.subject_id
       WHERE f.source_event_id IN (?1, ?2) ORDER BY f.predicate`,
    )
      .bind(a, b)
      .all();
    expect(facts.results).toHaveLength(2);
    expect(facts.results[0]).toMatchObject({
      predicate: "lives_in",
      object_text: "berlin",
      fact_kind: "user_stated",
      confidence: 0.9,
      sensitivity: "normal",
      learned_at: now,
      embedding_model: "gemini-embedding-001",
      vec_id: null,
      subject_type: "Person",
      norm_name: "user",
    });

    const entity = await env.BRAIN_DB.prepare(`SELECT last_seen_at FROM entities WHERE type = 'Person' AND norm_name = 'user'`).first<{
      last_seen_at: number;
    }>();
    expect(entity?.last_seen_at).toBe(now);

    const fts = await env.BRAIN_DB.prepare(`SELECT COUNT(*) AS c FROM facts_fts WHERE facts_fts MATCH 'neovim'`).first<{ c: number }>();
    expect(fts?.c).toBe(1);

    const sources = await env.BRAIN_DB.prepare(`SELECT COUNT(*) AS c FROM fact_sources WHERE event_id IN (?1, ?2)`)
      .bind(a, b)
      .first<{ c: number }>();
    expect(sources?.c).toBe(2);

    const audits = await env.BRAIN_DB.prepare(
      `SELECT COUNT(*) AS c FROM audit_log WHERE actor = 'system' AND action = 'create' AND target_type = 'fact'
       AND target_id IN (SELECT id FROM facts WHERE source_event_id IN (?1, ?2))`,
    )
      .bind(a, b)
      .first<{ c: number }>();
    expect(audits?.c).toBe(2);

    const rows = await env.BRAIN_DB.prepare(
      `SELECT status, facts_created, tokens_in, tokens_out, model FROM extractions WHERE event_id IN (?1, ?2)`,
    )
      .bind(a, b)
      .all();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results as Array<Record<string, unknown>>) {
      expect(row.status).toBe("done");
      expect(row.model).toBe("gemini-3.5-flash-lite");
    }
    const total = (rows.results as Array<{ tokens_in: number; tokens_out: number; facts_created: number }>).reduce(
      (acc, r) => ({
        tokensIn: acc.tokensIn + r.tokens_in,
        tokensOut: acc.tokensOut + r.tokens_out,
        facts: acc.facts + r.facts_created,
      }),
      { tokensIn: 0, tokensOut: 0, facts: 0 },
    );
    expect(total).toEqual({ tokensIn: 42, tokensOut: 7, facts: 2 });
  });

  it("dedupes across runs and bumps last_confirmed_at", async () => {
    await seedEvent({ excerpt: "My editor of choice is Neovim" });
    handleGen((lines) =>
      JSON.stringify(
        lines.map((l) => ({
          subject: "user",
          predicate: "uses editor",
          object: "Neovim",
          fact_kind: "user_stated",
          confidence: 0.9,
          event_id: l.event_id,
        })),
      ),
    );
    const run1 = await processExtractions(env, { now: 2000 });
    expect(run1.facts).toBe(1);
    const created = await env.BRAIN_DB.prepare(
      `SELECT id, last_confirmed_at FROM facts WHERE predicate = 'uses_editor' AND object_text = 'neovim'`,
    ).first<{ id: string; last_confirmed_at: number }>();
    expect(created?.last_confirmed_at).toBe(2000);

    const b = await seedEvent({ excerpt: "Reminder: I use Neovim" });
    void b;
    const run2 = await processExtractions(env, { now: 3000 });
    expect(run2.facts).toBe(0);

    const rows = await env.BRAIN_DB.prepare(
      `SELECT id, last_confirmed_at FROM facts WHERE predicate = 'uses_editor' AND object_text = 'neovim'`,
    ).all();
    expect(rows.results).toHaveLength(1);
    expect((rows.results[0] as { last_confirmed_at: number }).last_confirmed_at).toBe(3000);

    const sources = await env.BRAIN_DB.prepare(`SELECT COUNT(*) AS c FROM fact_sources WHERE fact_id = ?1`)
      .bind(created?.id)
      .first<{ c: number }>();
    expect(sources?.c).toBe(2);
  });

  it("never queues or sends restricted events", async () => {
    const restricted = await seedEvent({ privacy: "restricted", excerpt: "restricted zebra launch code" });
    await seedEvent({ excerpt: "normal zebra documentation note" });
    const bodies: string[] = [];
    network.use(
      http.post(GEN_URL, async ({ request }) => {
        bodies.push(await request.text());
        return HttpResponse.json(reply("[]"));
      }),
    );

    const run = await processExtractions(env, {});
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain("restricted zebra launch code");
    expect(bodies[0]).toContain("normal zebra documentation note");
    const row = await env.BRAIN_DB.prepare(`SELECT COUNT(*) AS c FROM extractions WHERE event_id = ?1`)
      .bind(restricted)
      .first<{ c: number }>();
    expect(row?.c).toBe(0);
    expect(run.processed).toBe(1);
  });

  it("retries a failing chunk twice, then marks it failed", async () => {
    const e = await seedEvent({ excerpt: "this one keeps failing" });
    network.use(http.post(GEN_URL, () => HttpResponse.text("nope", { status: 400 })));

    await processExtractions(env, {});
    let row = await env.BRAIN_DB.prepare(`SELECT status, attempts, error FROM extractions WHERE event_id = ?1`)
      .bind(e)
      .first<{ status: string; attempts: number; error: string | null }>();
    expect(row).toMatchObject({ status: "pending", attempts: 1 });

    await processExtractions(env, {});
    row = await env.BRAIN_DB.prepare(`SELECT status, attempts, error FROM extractions WHERE event_id = ?1`)
      .bind(e)
      .first<{ status: string; attempts: number; error: string | null }>();
    expect(row).toMatchObject({ status: "pending", attempts: 2 });

    const run3 = await processExtractions(env, {});
    expect(run3.failed).toBe(1);
    row = await env.BRAIN_DB.prepare(`SELECT status, attempts, error FROM extractions WHERE event_id = ?1`)
      .bind(e)
      .first<{ status: string; attempts: number; error: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(3);
    expect(row?.error).toContain("400");
  });

  it("keeps sweep caps and leaves the remainder unqueued", async () => {
    const boundary = nextTs;
    for (let i = 0; i < 50; i += 1) await seedEvent({ excerpt: `bulk note ${i}` });
    let calls = 0;
    network.use(
      http.post(GEN_URL, () => {
        calls += 1;
        return HttpResponse.json(reply("[]"));
      }),
    );

    const run = await processExtractions(env, {
      maxEvents: EXTRACTION_CAPS.sweep.maxEvents,
      maxCalls: EXTRACTION_CAPS.sweep.maxCalls,
    });
    expect(run.calls).toBe(4);
    expect(run.processed).toBe(40);
    expect(calls).toBe(4);

    const queued = await env.BRAIN_DB.prepare(
      `SELECT COUNT(*) AS c FROM extractions x JOIN events e ON e.id = x.event_id WHERE e.ts > ?1`,
    )
      .bind(boundary)
      .first<{ c: number }>();
    expect(queued?.c).toBe(40);
    const done = await env.BRAIN_DB.prepare(
      `SELECT COUNT(*) AS c FROM extractions x JOIN events e ON e.id = x.event_id WHERE e.ts > ?1 AND x.status = 'done'`,
    )
      .bind(boundary)
      .first<{ c: number }>();
    expect(done?.c).toBe(40);

    // the next sweep picks up the remainder
    await processExtractions(env, { maxEvents: 40, maxCalls: 4 });
    const doneAfter = await env.BRAIN_DB.prepare(
      `SELECT COUNT(*) AS c FROM extractions x JOIN events e ON e.id = x.event_id WHERE e.ts > ?1 AND x.status = 'done'`,
    )
      .bind(boundary)
      .first<{ c: number }>();
    expect(doneAfter?.c).toBe(50);
  });
});
