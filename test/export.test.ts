import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { contentHmac, decryptPayload } from "../src/crypto";
import { ingestEvents } from "../src/ingest";
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
