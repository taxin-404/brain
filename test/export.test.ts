import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { contentHmac, decryptPayload } from "../src/crypto";
import { ingestEvents, type EventInput } from "../src/ingest";
import { runSweep } from "../src/sweep";
import { bearer, call } from "./helpers";

const seedEvent = async (excerpt: string, payload: unknown): Promise<string> => {
  const res = await ingestEvents(env, "ADMIN", [{ source: "manual", actor: "user", kind: "note", excerpt, payload }]);
  return res.results[0].id;
};

const listParts = (job: string) => env.BRAIN_RAW.list({ prefix: `exports/${job}/` });

describe("export — backup profile", () => {
  it("writes a chunked NDJSON job to R2, decryptable with the KEK alone, served via the signed link, audited", async () => {
    const eventId = await seedEvent("export me", { hello: "world" });

    const res = await call("GET", "/v1/export?profile=backup", undefined, bearer(env, "ADMIN"));
    expect(res.status).toBe(200);
    const body = await res.json<{ job: string; profile: string; url: string; expires_at: number; parts: number }>();
    expect(body.profile).toBe("backup");
    expect(body.expires_at).toBeGreaterThan(Date.now());
    expect(body.url).toContain(`/v1/export/${body.job}/download?exp=`);

    const parts = await listParts(body.job);
    expect(parts.objects.length).toBeGreaterThan(0);
    const meta = await (await env.BRAIN_RAW.get(`exports/${body.job}/meta.json`))!.json<{ profile: string; exp: number }>();
    expect(meta.profile).toBe("backup");
    expect(meta.exp).toBe(body.expires_at);

    const text = await (await env.BRAIN_RAW.get(parts.objects.filter((o) => o.key.endsWith(".ndjson"))[0].key))!.text();
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: "header", format: "brain-export", version: 1, profile: "backup" });
    expect(lines[0].tables).toContain("events");
    expect(lines[0].tables).toContain("event_keys");

    const eventChunk = lines.find((l) => l.table === "events");
    expect(eventChunk.rows.some((r: { id: string }) => r.id === eventId)).toBe(true);

    // Wrapped keys ship (backup), and the payload blob decrypts with the KEK alone.
    const keysChunk = lines.find((l) => l.table === "event_keys");
    const wrappedKey = keysChunk.rows.find((r: { event_id: string }) => r.event_id === eventId)?.wrapped_key as string;
    expect(typeof wrappedKey).toBe("string");
    const payloadChunk = lines.find((l) => l.table === "r2_payloads");
    const b64 = payloadChunk.rows.find((r: { key: string }) => r.key === `payloads/${eventId}`)?.b64 as string;
    expect(typeof b64).toBe("string");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const decrypted = await decryptPayload(env.PAYLOAD_KEK, wrappedKey, bytes.buffer);
    expect(decrypted).toContain("hello");

    // The signed link needs no bearer token and returns the NDJSON.
    const dl = await call("GET", body.url);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toContain("ndjson");
    expect(dl.headers.get("content-disposition")).toContain(body.job);
    const dlText = await dl.text();
    expect(dlText).toContain(`"id":"${eventId}"`);

    const audit = await env.BRAIN_DB.prepare(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'export' AND target_id = ?1`,
    )
      .bind(body.job)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("splits large jobs into multiple parts and the link concatenates them", async () => {
    const big = "x".repeat(900_000);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedEvent(`big ${i}`, { blob: big, i }));

    const res = await call("GET", "/v1/export", undefined, bearer(env, "ADMIN")); // default profile = backup
    const body = await res.json<{ job: string; url: string; parts: number }>();
    expect(body.parts).toBeGreaterThan(1);

    const parts = await listParts(body.job);
    expect(parts.objects.filter((o) => o.key.endsWith(".ndjson")).length).toBeGreaterThan(1);

    const dl = await call("GET", body.url);
    expect(dl.status).toBe(200);
    const dlText = await dl.text();
    for (const id of ids) expect(dlText).toContain(`"id":"${id}"`);
  });

  it("refuses tampered, expired, and missing links", async () => {
    const res = await call("GET", "/v1/export?profile=backup", undefined, bearer(env, "ADMIN"));
    const body = await res.json<{ job: string; expires_at: number }>();
    const job = body.job;

    expect((await call("GET", `/v1/export/${job}/download`)).status).toBe(403);
    expect((await call("GET", `/v1/export/${job}/download?exp=${body.expires_at}&token=deadbeef`)).status).toBe(403);

    const past = Date.now() - 1000;
    const expiredToken = await contentHmac(env.CONTENT_HMAC_KEY, `export:${job}:${past}`);
    expect((await call("GET", `/v1/export/${job}/download?exp=${past}&token=${expiredToken}`)).status).toBe(403);

    expect((await call("GET", `/v1/export/${job}/download?exp=${body.expires_at}&token=nope`)).status).toBe(403);
  });

  it("is admin-only and validates the profile", async () => {
    for (const scope of ["MCP_READ", "MCP_PROPOSE"] as const) {
      expect((await call("GET", "/v1/export?profile=backup", undefined, bearer(env, scope))).status).toBe(403);
    }
    expect((await call("GET", "/v1/export?profile=evil", undefined, bearer(env, "ADMIN"))).status).toBe(400);
  });
});

const mintExportToken = async (): Promise<string> => {
  const mint = await call("POST", "/v1/confirm/token", { target: "export:portable" }, bearer(env, "ADMIN"));
  expect(mint.status).toBe(201);
  return (await mint.json<{ token: string }>()).token;
};

describe("export — portable profile + retention", () => {
  it("requires a single-use confirm token", async () => {
    expect((await call("GET", "/v1/export?profile=portable", undefined, bearer(env, "ADMIN"))).status).toBe(403);
    expect(
      (await call("GET", "/v1/export?profile=portable&confirm_token=nope", undefined, bearer(env, "ADMIN"))).status,
    ).toBe(403);

    const token = await mintExportToken();
    const res = await call(
      "GET",
      `/v1/export?profile=portable&confirm_token=${token}`,
      undefined,
      bearer(env, "ADMIN"),
    );
    expect(res.status).toBe(200);
    expect((await res.json<{ profile: string }>()).profile).toBe("portable");

    // Single-use: the same token can never mint a second portable export.
    expect(
      (await call("GET", `/v1/export?profile=portable&confirm_token=${token}`, undefined, bearer(env, "ADMIN"))).status,
    ).toBe(403);
  });

  it("decrypts payloads, ships no wrapped keys, and deletes R2 after one download", async () => {
    const eventId = await seedEvent("portable me", { portable: "portable-world" });
    const token = await mintExportToken();
    const res = await call(
      "GET",
      `/v1/export?profile=portable&confirm_token=${token}`,
      undefined,
      bearer(env, "ADMIN"),
    );
    const body = await res.json<{ job: string; url: string }>();

    const meta = await (await env.BRAIN_RAW.get(`exports/${body.job}/meta.json`))!.json<{ profile: string }>();
    expect(meta.profile).toBe("portable");

    const partKeys = (await listParts(body.job)).objects
      .filter((o) => o.key.endsWith(".ndjson"))
      .map((o) => o.key)
      .sort();
    const lines: any[] = [];
    for (const k of partKeys) {
      const partText = await (await env.BRAIN_RAW.get(k))!.text();
      lines.push(...partText.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    }

    // Decrypted plaintext, no wrapped keys anywhere in a portable artifact.
    const payloadRows = lines.filter((l) => l.table === "r2_payloads").flatMap((l) => l.rows);
    expect(payloadRows.find((r: { key: string }) => r.key === `payloads/${eventId}`)?.text).toContain(
      "portable-world",
    );
    expect(lines.find((l) => l.table === "event_keys")).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain("wrapped_key");

    // Download once: bytes intact, then the whole job is gone from R2.
    const dl = await call("GET", body.url);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toContain("portable-world");
    expect((await listParts(body.job)).objects.length).toBe(0);
    expect((await call("GET", body.url)).status).toBe(404);
  });

  it("deletes meta first so failed part deletes can never serve a fragment", async () => {
    const eventId = await seedEvent("delete order", { v: 1 });
    const token = await mintExportToken();
    const res = await call(
      "GET",
      `/v1/export?profile=portable&confirm_token=${token}`,
      undefined,
      bearer(env, "ADMIN"),
    );
    const body = await res.json<{ job: string; url: string }>();

    // Meta deletes succeed; every part delete fails (transient R2 error).
    const original = env.BRAIN_RAW.delete.bind(env.BRAIN_RAW);
    const calls: string[] = [];
    const spy = vi.spyOn(env.BRAIN_RAW, "delete").mockImplementation(async (keys: string | string[]) => {
      const key = Array.isArray(keys) ? keys.join(",") : keys;
      calls.push(key);
      if (key.endsWith("meta.json")) return original(key);
      throw new Error("r2 transient");
    });
    try {
      // The client still receives the full artifact.
      const dl = await call("GET", body.url);
      expect(dl.status).toBe(200);
      expect(await dl.text()).toContain(`payloads/${eventId}`);
    } finally {
      spy.mockRestore();
    }

    // Meta went first — no fragment can ever be served again…
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].endsWith("meta.json")).toBe(true);
    expect(await env.BRAIN_RAW.get(`exports/${body.job}/meta.json`)).toBeNull();
    expect((await call("GET", body.url)).status).toBe(404);
    // …stranded parts are the sweep's job, not the download's.
    const left = (await listParts(body.job)).objects;
    expect(left.length).toBeGreaterThan(0);
    for (const o of left) await env.BRAIN_RAW.delete(o.key);
    expect((await listParts(body.job)).objects.length).toBe(0);
  });

  it("sweep prunes expired export objects and keeps fresh ones", async () => {
    const now = Date.now();
    await env.BRAIN_RAW.put("exports/oldjob000/000.ndjson", "x");
    await env.BRAIN_RAW.put("exports/oldjob000/meta.json", JSON.stringify({ profile: "backup", exp: now - 10 * 60_000 }));
    await env.BRAIN_RAW.put("exports/newjob000/000.ndjson", "y");
    await env.BRAIN_RAW.put("exports/newjob000/meta.json", JSON.stringify({ profile: "backup", exp: now + 10 * 60_000 }));

    await runSweep(env, now);

    expect((await env.BRAIN_RAW.list({ prefix: "exports/oldjob000/" })).objects.length).toBe(0);
    expect((await env.BRAIN_RAW.list({ prefix: "exports/newjob000/" })).objects.length).toBe(2);
  });
});

describe("export — resumable jobs (free-plan subrequest ceiling)", () => {
  // The Workers Free plan caps Cloudflare-service subrequests per invocation
  // (1,000). Prod has ~1.3k payload objects, so the walk must page across
  // invocations: one bounded R2 list page per call, cursor persisted in
  // meta.json; the admin repeats `GET /v1/export?job=…` until `done:true`.
  it("walks in slices, resumes with ?job=, refuses download while running", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await seedEvent(`resume ${i}`, { i }));

    const first = await call("GET", "/v1/export?profile=backup&limit=2", undefined, bearer(env, "ADMIN"));
    expect(first.status).toBe(200);
    const b1 = await first.json<{ job: string; state: string; done: boolean; url: string; parts: number }>();
    expect(b1.state).toBe("running");
    expect(b1.done).toBe(false);

    // A running job's link answers 409 — never a partial artifact.
    expect((await call("GET", b1.url)).status).toBe(409);
    // Restore of a running job refuses too.
    expect((await call("POST", "/v1/restore", { job: b1.job }, bearer(env, "ADMIN"))).status).toBe(409);

    let view = b1;
    let calls = 1;
    for (let i = 0; i < 40 && !view.done; i += 1) {
      const res = await call("GET", `/v1/export?job=${b1.job}&limit=2`, undefined, bearer(env, "ADMIN"));
      expect(res.status).toBe(200);
      view = await res.json();
      calls += 1;
    }
    expect(view.done).toBe(true);
    expect(calls).toBeGreaterThan(1);

    // Finished artifact: exactly one header, every payload key exactly once.
    const dl = await call("GET", b1.url);
    expect(dl.status).toBe(200);
    const lines = (await dl.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l.kind === "header").length).toBe(1);
    const rows = lines
      .filter((l) => l.table === "r2_payloads")
      .flatMap((l) => l.rows as Array<{ key: string }>);
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
    for (const n of counts.values()) expect(n).toBe(1);
    for (const id of ids) expect(counts.get(`payloads/${id}`)).toBe(1);

    // Resuming a finished job is a no-op.
    const again = await call("GET", `/v1/export?job=${b1.job}`, undefined, bearer(env, "ADMIN"));
    const b4 = await again.json<{ done: boolean; parts: number }>();
    expect(b4.done).toBe(true);
    expect(b4.parts).toBe(view.parts);
  });

  it("validates ?job= and keeps portable gated on start", async () => {
    expect((await call("GET", "/v1/export?job=..%2Fetc", undefined, bearer(env, "ADMIN"))).status).toBe(400);
    expect((await call("GET", "/v1/export?job=doesnotexist", undefined, bearer(env, "ADMIN"))).status).toBe(404);
    // Resuming needs no new confirm token; starting portable still does.
    expect((await call("GET", "/v1/export?profile=portable", undefined, bearer(env, "ADMIN"))).status).toBe(403);
  });

  it("pages the table walk across invocations (CPU ceiling)", async () => {
    // >400 event rows: 10 ms CPU/invocation cannot stringify whole tables.
    const batch: EventInput[] = Array.from({ length: 405 }, (_, i) => ({
      source: "manual",
      actor: "user",
      kind: "note",
      excerpt: `bulk ${i}`,
      payload: { i },
    }));
    const ingested = await ingestEvents(env, "ADMIN", batch);
    const seeded = new Set(ingested.results.map((r) => r.id));

    const first = await call("GET", "/v1/export?profile=backup", undefined, bearer(env, "ADMIN"));
    const b1 = await first.json<{ job: string; done: boolean; url: string }>();
    expect(b1.done).toBe(false);

    // The parts written so far hold at most one 400-row slice of events.
    const partKeys = (await listParts(b1.job)).objects
      .filter((o) => o.key.endsWith(".ndjson"))
      .map((o) => o.key)
      .sort();
    const firstLines: any[] = [];
    for (const k of partKeys) {
      const t = await (await env.BRAIN_RAW.get(k))!.text();
      firstLines.push(...t.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    }
    const rowsSoFar = firstLines.filter((l) => l.table === "events").flatMap((l) => l.rows);
    expect(rowsSoFar.length).toBeGreaterThan(0);
    expect(rowsSoFar.length).toBeLessThanOrEqual(400);
    expect(firstLines.filter((l) => l.kind === "header").length).toBe(1);

    // Resume to done, bounded.
    let view = b1;
    let calls = 0;
    while (!view.done && calls < 30) {
      const res = await call("GET", `/v1/export?job=${b1.job}`, undefined, bearer(env, "ADMIN"));
      expect(res.status).toBe(200);
      view = await res.json();
      calls += 1;
    }
    expect(view.done).toBe(true);
    expect(calls).toBeGreaterThan(1);

    // Every seeded event lands in the artifact exactly once.
    const dl = await call("GET", b1.url);
    expect(dl.status).toBe(200);
    const lines = (await dl.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // Exactly one header even though the walk spanned several calls.
    expect(lines.filter((l) => l.kind === "header").length).toBe(1);
    const ids = lines
      .filter((l) => l.table === "events")
      .flatMap((l) => l.rows as Array<{ id: string }>)
      .map((r) => r.id);
    const seen = new Map<string, number>();
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
    for (const id of seeded) expect(seen.get(id)).toBe(1);
    for (const n of seen.values()) expect(n).toBe(1);
  });
});
