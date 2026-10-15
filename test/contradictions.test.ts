import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { processExtractions } from "../src/extract";
import { installFakeVectorize } from "./helpers";
import { network } from "./server";

const GEN_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-3.5-flash-lite:generateContent";
const EMB_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-embedding-001:batchEmbedContents";

let nextTs = 1_810_000_000_000;

const seedEvent = async (actor: "user" | "tool" | "assistant", excerpt: string): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', ?4, 1.0, NULL, 'note', 'normal', ?5, ?6)`,
  )
    .bind(id, (nextTs += 1000), Date.now(), actor, excerpt, `hmac-${id}`)
    .run();
  return id;
};

const reply = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
});

interface GenLine {
  event_id: string;
  actor: string;
}

const handleGen = (fn: (lines: GenLine[]) => string) =>
  network.use(
    http.post(GEN_URL, async ({ request }) => {
      const body = (await request.json()) as { contents: Array<{ parts: Array<{ text: string }> }> };
      const lines = JSON.parse(body.contents[0].parts[0].text) as GenLine[];
      return HttpResponse.json(reply(fn(lines)));
    }),
  );

/** Embedding is not part of these tests: answer 400 so the embed pass fails fast. */
const failEmbed = () =>
  network.use(http.post(EMB_URL, () => HttpResponse.text("embedding not part of this test", { status: 400 })));

const oneFact = (subject: string, predicate: string, object: string, factKind: string, confidence: number) => (lines: GenLine[]) =>
  JSON.stringify([{ subject, predicate, object, fact_kind: factKind, confidence, event_id: lines[0].event_id }]);

const factRow = async (eventId: string) =>
  env.BRAIN_DB.prepare(`SELECT id, status, object_text, superseded_by, vec_id FROM facts WHERE source_event_id = ?1`)
    .bind(eventId)
    .first<{ id: string; status: string; object_text: string | null; superseded_by: string | null; vec_id: string | null }>();

describe("contradiction handling in extraction", () => {
  beforeAll(async () => {
    await network.enable();
  });
  beforeEach(() => {
    installFakeVectorize();
  });
  afterEach(() => {
    network.resetHandlers();
  });
  afterAll(async () => {
    await network.disable();
  });

  it("user-stated new supersedes non-user old; newest user-stated wins; old keeps its text", async () => {
    let now = 1_811_000_000_000;
    failEmbed();

    const e1 = await seedEvent("tool", "scanner output calls it old name");
    handleGen(oneFact("Contra One", "is_called", "old name", "observed", 0.5));
    const r1 = await processExtractions(env, { maxEvents: 10, maxCalls: 2, now });
    expect(r1).toMatchObject({ facts: 1, superseded: 0, disputed: 0 });
    const oldId = (await factRow(e1))!.id;

    const e2 = await seedEvent("user", "actually it is called new name");
    handleGen(oneFact("Contra One", "is_called", "new name", "user_stated", 0.9));
    const r2 = await processExtractions(env, { maxEvents: 10, maxCalls: 2, now: (now += 1000) });
    expect(r2).toMatchObject({ facts: 1, superseded: 1, disputed: 0 });

    const oldRow = (await factRow(e1))!;
    expect(oldRow.status).toBe("superseded");
    expect(oldRow.object_text).toBe("old name"); // kept for why/the version chain
    const newRow = (await factRow(e2))!;
    expect(newRow.status).toBe("active");
    expect(oldRow.superseded_by).toBe(newRow.id);
    expect(r2.facts).toBe(1);

    // both user-stated: the newest wins, the middle version is superseded too
    const e3 = await seedEvent("user", "no, it is called newest name");
    handleGen(oneFact("Contra One", "is_called", "newest name", "user_stated", 0.9));
    const r3 = await processExtractions(env, { maxEvents: 10, maxCalls: 2, now: (now += 1000) });
    expect(r3).toMatchObject({ facts: 1, superseded: 1, disputed: 0 });
    expect((await factRow(e2))!.status).toBe("superseded");
    expect((await factRow(e3))!.status).toBe("active");
  });

  it("non-user new vs user-stated old → inserted disputed, old untouched and still active", async () => {
    let now = 1_812_000_000_000;
    failEmbed();

    const e1 = await seedEvent("user", "i work at acme");
    handleGen(oneFact("Contra Two", "works_at", "acme", "user_stated", 0.9));
    await processExtractions(env, { maxEvents: 10, maxCalls: 2, now });

    const e2 = await seedEvent("tool", "crm export says globex");
    handleGen(oneFact("Contra Two", "works_at", "globex", "observed", 0.5));
    const r2 = await processExtractions(env, { maxEvents: 10, maxCalls: 2, now: (now += 1000) });
    expect(r2).toMatchObject({ facts: 1, superseded: 0, disputed: 1 });

    const oldRow = (await factRow(e1))!;
    expect(oldRow).toMatchObject({ status: "active", object_text: "acme" });
    const newRow = (await factRow(e2))!;
    expect(newRow.status).toBe("disputed");
    expect(newRow.vec_id).toBeNull(); // disputed facts are never embedded
  });

  it("non-user vs non-user on an exclusive predicate → inserted disputed", async () => {
    let now = 1_813_000_000_000;
    failEmbed();

    const e1 = await seedEvent("tool", "status page says active");
    handleGen(oneFact("Contra Three", "has_status", "active", "observed", 0.5));
    await processExtractions(env, { maxEvents: 10, maxCalls: 2, now });

    const e2 = await seedEvent("assistant", "notes say it was retired");
    handleGen(oneFact("Contra Three", "has_status", "retired", "inferred", 0.4));
    const r2 = await processExtractions(env, { maxEvents: 10, maxCalls: 2, now: (now += 1000) });
    expect(r2).toMatchObject({ facts: 1, superseded: 0, disputed: 1 });
    expect((await factRow(e2))!.status).toBe("disputed");
    expect((await factRow(e1))!.status).toBe("active");
  });

  it("multivalued predicate → no conflict, both stay active", async () => {
    let now = 1_814_000_000_000;
    failEmbed();

    const e1 = await seedEvent("tool", "stack scan: prisma");
    handleGen(oneFact("Contra Four", "uses", "prisma", "observed", 0.5));
    await processExtractions(env, { maxEvents: 10, maxCalls: 2, now });

    const e2 = await seedEvent("tool", "stack scan: drizzle");
    handleGen(oneFact("Contra Four", "uses", "drizzle", "observed", 0.5));
    const r2 = await processExtractions(env, { maxEvents: 10, maxCalls: 2, now: (now += 1000) });
    expect(r2).toMatchObject({ facts: 1, superseded: 0, disputed: 0 });
    expect((await factRow(e1))!.status).toBe("active");
    expect((await factRow(e2))!.status).toBe("active");
  });

  it("unknown predicate, both non-user → both stay active (no guessing)", async () => {
    let now = 1_815_000_000_000;
    failEmbed();

    const e1 = await seedEvent("assistant", "maybe related to alpha");
    handleGen(oneFact("Contra Five", "relates_to", "alpha", "inferred", 0.4));
    await processExtractions(env, { maxEvents: 10, maxCalls: 2, now });

    const e2 = await seedEvent("assistant", "maybe related to beta");
    handleGen(oneFact("Contra Five", "relates_to", "beta", "inferred", 0.4));
    const r2 = await processExtractions(env, { maxEvents: 10, maxCalls: 2, now: (now += 1000) });
    expect(r2).toMatchObject({ facts: 1, superseded: 0, disputed: 0 });
    expect((await factRow(e1))!.status).toBe("active");
    expect((await factRow(e2))!.status).toBe("active");
  });

  it("exact same object is still a confirmation (no conflict path)", async () => {
    let now = 1_816_000_000_000;
    failEmbed();

    const e1 = await seedEvent("user", "i live in berlin");
    handleGen(oneFact("Contra Six", "lives_in", "berlin", "user_stated", 0.9));
    await processExtractions(env, { maxEvents: 10, maxCalls: 2, now });
    const first = (await factRow(e1))!;

    const e2 = await seedEvent("user", "still live in berlin");
    handleGen(oneFact("Contra Six", "lives_in", "Berlin", "user_stated", 0.9));
    const r2 = await processExtractions(env, { maxEvents: 10, maxCalls: 2, now: (now += 1000) });
    expect(r2).toMatchObject({ facts: 0, superseded: 0, disputed: 0 });
    expect((await factRow(e1))!.status).toBe("active");
    expect(await factRow(e2)).toBeNull(); // confirmed, not re-inserted
    const confirmed = await env.BRAIN_DB.prepare(`SELECT last_confirmed_at FROM facts WHERE id = ?1`)
      .bind(first.id)
      .first<{ last_confirmed_at: number }>();
    expect(confirmed?.last_confirmed_at).toBe(now);
  });
});
