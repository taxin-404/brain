import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import handler, { routeCron } from "../src/index";
import { newEventId } from "../src/crypto";
import { resolveSubject } from "../src/entities";
import { createFact } from "../src/factstore";
import { installFakeVectorize } from "./helpers";
import { network } from "./server";

const GEN_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-3.5-flash-lite:generateContent";

let genCalls = 0;

const runScheduled = async (cron: string): Promise<void> => {
  const pending: Array<Promise<unknown>> = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
  } as unknown as ExecutionContext;
  await handler.scheduled!({ cron } as ScheduledController, env, ctx);
  await Promise.all(pending);
};

const countRows = async (table: string): Promise<number> => {
  const row = await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
};

describe("cron dispatch", () => {
  beforeAll(async () => {
    await network.enable();
  });
  beforeEach(() => {
    installFakeVectorize();
    genCalls = 0;
    network.use(
      http.post(GEN_URL, async () => {
        genCalls += 1;
        return HttpResponse.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ insights: [] }) }] } }],
          usageMetadata: {},
        });
      }),
    );
  });
  afterEach(() => {
    network.resetHandlers();
  });
  afterAll(async () => {
    await network.disable();
  });

  it("routes the four configured crons and ignores unknown trigger strings", () => {
    expect(routeCron("*/30 * * * *")).toBe("sweep");
    expect(routeCron("0 3 * * *")).toBe("consolidation");
    expect(routeCron("0 4 * * 1")).toBe("reflection_week");
    expect(routeCron("0 4 1 * *")).toBe("reflection_month");
    expect(routeCron("0 5 * * *")).toBeNull();
    expect(routeCron("")).toBeNull();
  });

  it("runs the sweep on the */30 trigger (expired confirm tokens pruned)", async () => {
    await env.BRAIN_DB.prepare(
      `INSERT INTO confirm_tokens (token, target, created_at, expires_at) VALUES ('tok-cron-test', 'fact:cron', 1, 2)`,
    ).run();
    await runScheduled("*/30 * * * *");
    const row = await env.BRAIN_DB.prepare(`SELECT token FROM confirm_tokens WHERE token = 'tok-cron-test'`).first();
    expect(row).toBeNull();
  });

  it("runs consolidation on the nightly trigger and records exactly one run", async () => {
    const before = await countRows("consolidation_runs");
    await runScheduled("0 3 * * *");
    const after = await countRows("consolidation_runs");
    expect(after).toBe(before + 1);
    expect(genCalls).toBe(0); // empty candidate set: nothing to ask the model
  });

  it("runs a weekly reflection on the Monday trigger", async () => {
    const now = Date.now();
    const subject = await resolveSubject(env.BRAIN_DB, "cron reflect subject", "Project");
    const eventId = newEventId();
    await env.BRAIN_DB.prepare(
      `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
       VALUES (?1, ?2, ?3, 'manual', 'user', 1.0, NULL, 'note', 'normal', 'cron reflection evidence', ?4)`,
    )
      .bind(eventId, now - 1000, now, `hmac-${eventId}`)
      .run();
    await createFact(env, {
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "uses",
      objectText: "cron weekly object",
      factKind: "user_stated",
      confidence: 0.9,
      sensitivity: "normal",
      sourceEventId: eventId,
      now: now - 1000,
    });
    network.use(
      http.post(GEN_URL, async () => {
        genCalls += 1;
        return HttpResponse.json({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ insights: [{ text: "cron insight", fact_ids: [] }] }) }] } }],
          usageMetadata: {},
        });
      }),
    );

    await runScheduled("0 4 * * 1");

    const row = await env.BRAIN_DB.prepare(
      `SELECT period FROM reflections ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).first<{ period: string }>();
    expect(row?.period).toBe("week");
    expect(genCalls).toBe(1);
  });

  it("runs a monthly reflection on the first-of-month trigger", async () => {
    await runScheduled("0 4 1 * *");
    const row = await env.BRAIN_DB.prepare(
      `SELECT period FROM reflections ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).first<{ period: string }>();
    expect(row?.period).toBe("month");
  });

  it("no-ops unknown triggers without recording anything or crashing", async () => {
    const runs = await countRows("consolidation_runs");
    const reflections = await countRows("reflections");
    const calls = genCalls;
    await runScheduled("0 5 * * *");
    expect(await countRows("consolidation_runs")).toBe(runs);
    expect(await countRows("reflections")).toBe(reflections);
    expect(genCalls).toBe(calls);
  });
});
