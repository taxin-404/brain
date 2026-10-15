### Task 7: Encrypted single/batch ingest

**Files:**
- Create: `src/ingest.ts`, `test/ingest.test.ts`
- Modify: `src/index.ts` (2 routes)

**Interfaces:**
- Produces:

```ts
export interface EventInput {
  id?: string; ts?: number;
  source: "opencode" | "file" | "github" | "manual";
  actor: "user" | "assistant" | "tool" | "external";
  kind: string; session_id?: string;
  privacy?: "normal" | "sensitive" | "restricted";
  excerpt?: string; payload: unknown;
}
export interface IngestResult { results: Array<{ id: string; status: "stored" | "duplicate" }>; stored: number; charged: number; }
export class IngestError extends Error { constructor(readonly code: "too_many" | "too_large" | "bad_request" | "over_limit" | "breaker_open", message: string) }
export async function ingestEvents(env: Env, scope: Scope, entries: EventInput[]): Promise<IngestResult>;
export function handleEvents(request: Request, env: Env, scope: Scope): Promise<Response>;
```

- Routes: `POST /^\/v1\/events$/` and `POST /^\/v1\/events\/batch$/`, both `need: "propose"`. `/v1/events` takes one object; `/v1/events/batch` takes a raw JSON array. Success → `201` + `IngestResult`; `too_many|bad_request` → 400, `too_large` → 413, `over_limit` → 429, `breaker_open` → 503.
- Pinned pipeline order (dedupe **before** charging — Review Focus 5): validate → redact → hmac → excerpt → size check → dedupe (by id, by `(session_id, content_hmac)`, and within-batch) → encrypt + R2 `put(payloads/{id})` **for new rows only** → `charge(env.BRAIN_DB, scope, newRows.length)` → one D1 batch (event rows via spec §4 columns + `event_keys`). Privacy final: requested `restricted` stays `restricted`; else redaction `sensitive` wins; else requested or `normal`. `ts` normalized `ts < 1e12 ? ts*1000 : ts`, default `Date.now()`. Orphaned R2 objects on a post-write failure are accepted (documented in a comment).

- [ ] **Step 1: Write the failing ingest test** — `test/ingest.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decryptPayload } from "../src/crypto";
import { readBudget } from "../src/budget";
import type { EventInput } from "../src/ingest";
import { bearer, call } from "./helpers";

const ev = (over: Partial<EventInput> = {}): EventInput => ({
  source: "opencode", actor: "user", kind: "message", session_id: "sess-1",
  payload: { text: "uses postgres" }, ...over,
});
const post = (body: unknown, scope: "MCP_PROPOSE" | "MCP_READ" = "MCP_PROPOSE") =>
  call("POST", Array.isArray(body) ? "/v1/events/batch" : "/v1/events", body, bearer(env, scope));

describe("ingest", () => {
  it("stores encrypted payloads, records trust/excerpt, feeds FTS", async () => {
    const res = await post(ev());
    expect(res.status).toBe(201);
    const body = await res.json<{ results: Array<{ id: string; status: string }>; stored: number }>();
    const id = body.results[0].id;
    const row = await env.BRAIN_DB.prepare(`SELECT trust, excerpt, redacted FROM events WHERE id = ?1`).bind(id).first<{ trust: number; excerpt: string; redacted: number }>();
    expect(row).toMatchObject({ trust: 1.0, redacted: 0 });
    expect(row!.excerpt).toContain("uses postgres");
    const key = await env.BRAIN_DB.prepare(`SELECT wrapped_key FROM event_keys WHERE event_id = ?1`).bind(id).first<{ wrapped_key: string }>();
    const obj = await env.BRAIN_RAW.get(`payloads/${id}`);
    expect(await decryptPayload(env.PAYLOAD_KEK, key!.wrapped_key, await obj!.arrayBuffer())).toBe(JSON.stringify({ text: "uses postgres" }));
    expect((await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH '"postgres"'`).first<{ n: number }>())!.n).toBe(1);
  });

  it("never stores planted secrets raw and flags sensitive", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuv12345678";
    const res = await post(ev({ payload: { text: `token: ${secret}` } }));
    const id = (await res.json<{ results: Array<{ id: string }> }>()).results[0].id;
    const key = await env.BRAIN_DB.prepare(`SELECT wrapped_key FROM event_keys WHERE event_id = ?1`).bind(id).first<{ wrapped_key: string }>();
    const plain = await decryptPayload(env.PAYLOAD_KEK, key!.wrapped_key, await (await env.BRAIN_RAW.get(`payloads/${id}`))!.arrayBuffer());
    expect(plain).not.toContain(secret);
    expect(plain).toContain("[REDACTED]");
    const row = await env.BRAIN_DB.prepare(`SELECT privacy, excerpt FROM events WHERE id = ?1`).bind(id).first<{ privacy: string; excerpt: string }>();
    expect(row!.privacy).toBe("sensitive");
    expect(row!.excerpt).not.toContain(secret);
  });

  it("is idempotent by id and by session+hmac, and charges the budget once", async () => {
    const batch = [ev({ id: "fixed-1" }), ev({ id: "fixed-2", payload: { text: "uses redis" } })];
    expect((await post(batch)).status).toBe(201);
    const again = await post(batch);
    const body = await again.json<{ results: Array<{ status: string }>; stored: number; charged: number }>();
    expect(body.stored).toBe(0);
    expect(body.charged).toBe(0);
    expect(body.results.every((r) => r.status === "duplicate")).toBe(true);
    expect((await readBudget(env.BRAIN_DB)).used).toBe(2);
    const sameSession = await post([ev({ id: "fixed-3" }), ev({ id: "fixed-4" })]); // same session + payload -> second is duplicate
    const b2 = await sameSession.json<{ results: Array<{ status: string }> }>();
    expect(b2.results.map((r) => r.status)).toEqual(["stored", "duplicate"]);
  });

  it("enforces batch and size limits", async () => {
    expect((await post(Array.from({ length: 501 }, (_, i) => ev({ id: `bulk-${i}` })))).status).toBe(400);
    expect((await post(ev({ payload: { text: "x".repeat(1_100_000) } }))).status).toBe(413);
  });

  it("maps actors to trust tiers", async () => {
    await post(["user", "assistant", "tool", "external"].map((actor, i) => ev({ id: `trust-${i}`, actor: actor as EventInput["actor"], session_id: `trust-sess-${i}` })));
    const { results } = await env.BRAIN_DB.prepare(`SELECT actor, trust FROM events WHERE id LIKE 'trust-%' ORDER BY actor`).all<{ actor: string; trust: number }>();
    expect(Object.fromEntries(results.map((r) => [r.actor, r.trust]))).toEqual({ assistant: 0.9, external: 0.4, tool: 0.7, user: 1.0 });
  });

  it("stores restricted events with restricted privacy", async () => {
    const res = await post(ev({ id: "res-1", privacy: "restricted", session_id: "sess-r" }));
    const id = (await res.json<{ results: Array<{ id: string }> }>()).results[0].id;
    expect((await env.BRAIN_DB.prepare(`SELECT privacy FROM events WHERE id = ?1`).bind(id).first<{ privacy: string }>())!.privacy).toBe("restricted");
  });

  it("requires propose scope", async () => {
    expect((await call("POST", "/v1/events", ev())).status).toBe(401);
    expect((await post(ev(), "MCP_READ")).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** → FAIL (no `src/ingest.ts`).

- [ ] **Step 3: Implement `src/ingest.ts` + routes** (pipeline per the Interfaces block; one D1 `batch()` for all inserts).

- [ ] **Step 4: Run it, verify it passes** → PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: encrypted idempotent single/batch ingest"
```

---

