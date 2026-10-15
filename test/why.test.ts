import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "../src/crypto";
import { resolveSubject } from "../src/entities";
import { createFact } from "../src/factstore";
import { bearer, call, installFakeVectorize } from "./helpers";

let seq = 1_786_000_000_000;

const seedUserEvent = async (
  opts: { privacy?: string; excerpt?: string } = {},
): Promise<string> => {
  const id = newEventId();
  await env.BRAIN_DB.prepare(
    `INSERT INTO events (id, ts, ingested_at, source, actor, trust, session_id, kind, privacy, excerpt, content_hmac)
     VALUES (?1, ?2, ?3, 'manual', 'user', 1.0, NULL, 'note', ?4, ?5, ?6)`,
  )
    .bind(id, (seq += 1000), Date.now(), opts.privacy ?? "normal", opts.excerpt ?? "why evidence", `hmac-${id}`)
    .run();
  return id;
};

const seedActiveFact = async (objectText: string, opts: { sensitivity?: string } = {}) => {
  const eventId = await seedUserEvent();
  const subject = await resolveSubject(env.BRAIN_DB, `Why Subject ${newEventId().slice(-5)}`, "Project");
  const factId = await createFact(env, {
    subjectId: subject.id,
    subjectName: subject.name,
    predicate: "is_called",
    objectText,
    factKind: "user_stated",
    confidence: 0.9,
    sensitivity: opts.sensitivity ?? "normal",
    sourceEventId: eventId,
  });
  return { factId, eventId };
};

interface WhyBody {
  fact: { id: string; sensitivity: string };
  versions: Array<{
    id: string;
    object: string | null;
    status: string;
    fact_kind: string;
    confidence: number;
    valid_at: number | null;
    invalid_at: number | null;
    learned_at: number;
    superseded_by: string | null;
    current: boolean;
    deleted: boolean;
  }>;
  sources: Array<{
    event_id: string;
    ts: number;
    kind: string;
    actor: string;
    purged: boolean;
    excerpt: string | null;
    restricted?: boolean;
  }>;
}

describe("GET /v1/why/:fact_id", () => {
  beforeEach(() => {
    installFakeVectorize();
  });

  it("shows both versions of a supersession chain, flagged from either end", async () => {
    const old = await seedActiveFact("old belief");
    const corr = await call(
      "POST",
      `/v1/facts/${old.factId}/correct`,
      { correction: "New Belief", evidence_event_id: old.eventId },
      bearer(env, "ADMIN"),
    );
    expect(corr.status).toBe(201);
    expect((await corr.json<{ applied: boolean }>()).applied).toBe(true);

    const whyOld = await call("GET", `/v1/why/${old.factId}`, undefined, bearer(env, "ADMIN"));
    expect(whyOld.status).toBe(200);
    const body = await whyOld.json<WhyBody>();
    expect(body.fact.id).toBe(old.factId);
    expect(body.versions).toHaveLength(2);
    expect(body.versions.map((v) => v.id)).toContain(old.factId);

    const oldV = body.versions.find((v) => v.id === old.factId)!;
    expect(oldV).toMatchObject({ status: "superseded", current: false, object: "old belief", deleted: false });
    const newV = body.versions.find((v) => v.current)!;
    expect(newV.id).not.toBe(old.factId);
    expect(newV).toMatchObject({
      status: "active",
      object: "new belief",
      superseded_by: null,
      deleted: false,
      fact_kind: "user_stated",
    });
    expect(oldV.superseded_by).toBe(newV.id);
    expect(oldV.invalid_at).not.toBeNull();

    // the old fact's evidence event is listed (not purged)
    expect(body.sources.some((s) => s.event_id === old.eventId && s.purged === false)).toBe(true);

    // asking from the new end returns the same chain with the same flags
    const whyNew = await call("GET", `/v1/why/${newV.id}`, undefined, bearer(env, "ADMIN"));
    expect(whyNew.status).toBe(200);
    const body2 = await whyNew.json<WhyBody>();
    expect(body2.versions.map((v) => v.id).sort()).toEqual(body.versions.map((v) => v.id).sort());
    expect(body2.versions.find((v) => v.current)?.id).toBe(newV.id);
    expect(body2.versions.find((v) => v.id === old.factId)).toMatchObject({ current: false, status: "superseded" });
  });

  it("marks a purged source event and strips its excerpt", async () => {
    const f = await seedActiveFact("purge source fact");
    const mint = await call("POST", "/v1/confirm/token", { target: `event:${f.eventId}` }, bearer(env, "ADMIN"));
    const { token } = await mint.json<{ token: string }>();
    const purge = await call(
      "POST",
      `/v1/events/${f.eventId}/purge`,
      { confirm_token: token, reason: "why test" },
      bearer(env, "ADMIN"),
    );
    expect(purge.status).toBe(200);

    const why = await call("GET", `/v1/why/${f.factId}`, undefined, bearer(env, "ADMIN"));
    expect(why.status).toBe(200);
    const body = await why.json<WhyBody>();
    const src = body.sources.find((s) => s.event_id === f.eventId);
    expect(src?.purged).toBe(true);
    expect(src?.excerpt).toBeNull();
  });

  it("404s restricted facts for read scope but serves them to admin", async () => {
    const restricted = await seedActiveFact("restricted fact", { sensitivity: "restricted" });
    const read = await call("GET", `/v1/why/${restricted.factId}`, undefined, bearer(env, "MCP_READ"));
    expect(read.status).toBe(404);

    const admin = await call("GET", `/v1/why/${restricted.factId}`, undefined, bearer(env, "ADMIN"));
    expect(admin.status).toBe(200);
    const body = await admin.json<WhyBody>();
    expect(body.fact.id).toBe(restricted.factId);
  });

  it("masks excerpts of privacy=restricted events from non-admin callers", async () => {
    const eventId = await seedUserEvent({ privacy: "restricted", excerpt: "secret words" });
    const subject = await resolveSubject(env.BRAIN_DB, `Why Privacy ${newEventId().slice(-5)}`, "Project");
    const factId = await createFact(env, {
      subjectId: subject.id,
      subjectName: subject.name,
      predicate: "mentions",
      objectText: "something normal",
      factKind: "observed",
      confidence: 0.5,
      sensitivity: "normal",
      sourceEventId: eventId,
    });

    const read = await call("GET", `/v1/why/${factId}`, undefined, bearer(env, "MCP_READ"));
    expect(read.status).toBe(200);
    const readSrc = (await read.json<WhyBody>()).sources.find((s) => s.event_id === eventId);
    expect(readSrc).toMatchObject({ excerpt: null, restricted: true, purged: false });

    const admin = await call("GET", `/v1/why/${factId}`, undefined, bearer(env, "ADMIN"));
    const adminSrc = (await admin.json<WhyBody>()).sources.find((s) => s.event_id === eventId);
    expect(adminSrc?.excerpt).toBe("secret words");
    expect(adminSrc?.restricted).toBeUndefined();
  });

  it("404s unknown ids and requires a token", async () => {
    const res = await call("GET", "/v1/why/01NOPEUNKNOWN", undefined, bearer(env, "ADMIN"));
    expect(res.status).toBe(404);
    const noAuth = await call("GET", "/v1/why/01NOPEUNKNOWN");
    expect(noAuth.status).toBe(401);
  });
});
