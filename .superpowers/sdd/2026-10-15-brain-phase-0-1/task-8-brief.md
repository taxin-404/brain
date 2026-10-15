### Task 8: Confirm tokens + crypto-shred purge

**Files:**
- Create: `src/audit.ts`, `src/purge.ts`, `test/purge.test.ts`
- Modify: `src/index.ts` (2 routes)

**Interfaces:**
- Produces: `writeAudit(db, { actor: "user" | "agent" | "system"; action: string; targetType: string; targetId: string; before?: unknown; after?: unknown; reason?: string }): Promise<void>` (row id = `newEventId()`, ts = now); `CONFIRM_TTL_MS = 300_000`; `mintConfirmToken(env, target): Promise<{ token: string; expires_at: number }>` (`crypto.randomUUID()`, plain INSERT); `purgeEvent(env, eventId, confirmToken, reason): Promise<{ purged: boolean }>` throwing `PurgeError("invalid_token" | "not_found")` (handlers map to 400 / 404); `handleMintToken`, `handlePurge`.
- Routes: `POST /^\/v1\/confirm\/token$/` admin (body `{ target }` → 201 `{ token, expires_at }`; target format used by purge: `event:{eventId}`); `POST /^\/v1\/events\/([A-Za-z0-9_-]+)\/purge$/` admin (body `{ confirm_token, reason }` → 200 `{ purged }`).
- Pinned purge sequence (spec §4, exact order): verify token (exists, unused, unexpired, target matches) → **consume it** (`UPDATE … SET used_at = ? WHERE token = ? AND used_at IS NULL`, reject when 0 rows change) → load event row `rowid, excerpt, session_id` (`not_found`; if already `redacted=1` return `{ purged: false }`, idempotent) → FTS `'delete'` with the old excerpt → `BRAIN_RAW.delete("payloads/{id}")` → `DELETE FROM event_keys` → whitelisted `UPDATE events SET redacted = 1, excerpt = NULL` → append `purge_tombstone` via `ingestEvents(env, "ADMIN", …)` (`payload: { purged_event_id, reason }`, session carried over) → `writeAudit({ actor: "user", action: "purge", … })`.

- [ ] **Step 1: Write the failing purge test** — `test/purge.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decryptPayload } from "../src/crypto";
import type { EventInput } from "../src/ingest";
import { bearer, call } from "./helpers";

const ev = (over: Partial<EventInput> = {}): EventInput => ({
  source: "opencode", actor: "user", kind: "message", session_id: "purge-sess", payload: { text: "alpha-secret-term" }, ...over,
});
async function seed(over: Partial<EventInput> = {}) {
  const res = await call("POST", "/v1/events", ev(over), bearer(env, "MCP_PROPOSE"));
  const id = (await res.json<{ results: Array<{ id: string }> }>()).results[0].id;
  return id;
}
async function mint(target: string) {
  const res = await call("POST", "/v1/confirm/token", { target }, bearer(env, "ADMIN"));
  expect(res.status).toBe(201);
  return (await res.json<{ token: string }>()).token;
}
const purge = (id: string, token: string) => call("POST", `/v1/events/${id}/purge`, { confirm_token: token, reason: "test" }, bearer(env, "ADMIN"));

describe("purge", () => {
  it("rejects missing/wrong/expired tokens and leaves the event intact", async () => {
    const id = await seed();
    expect((await purge(id, "no-such-token")).status).toBe(400);
    const other = await mint("event:someone-else");
    expect((await purge(id, other)).status).toBe(400);
    await env.BRAIN_DB.prepare(`INSERT INTO confirm_tokens (token, target, created_at, expires_at) VALUES ('expired-1', ?1, 1, 2)`).bind(`event:${id}`).run();
    expect((await purge(id, "expired-1")).status).toBe(400);
    const row = await env.BRAIN_DB.prepare(`SELECT redacted FROM events WHERE id = ?1`).bind(id).first<{ redacted: number }>();
    expect(row!.redacted).toBe(0);
    expect(await env.BRAIN_RAW.get(`payloads/${id}`)).not.toBeNull();
  });

  it("crypto-shreds through the full sequence and audits it", async () => {
    const id = await seed({ id: "purge-happy" });
    expect((await purge(id, await mint(`event:${id}`))).status).toBe(200);
    const row = await env.BRAIN_DB.prepare(`SELECT redacted, excerpt FROM events WHERE id = 'purge-happy'`).first<{ redacted: number; excerpt: string | null }>();
    expect(row).toEqual({ redacted: 1, excerpt: null });
    expect(await env.BRAIN_RAW.get(`payloads/${id}`)).toBeNull();
    expect((await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM event_keys WHERE event_id = ?1`).bind(id).first<{ n: number }>())!.n).toBe(0);
    expect((await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH '"alpha-secret-term"'`).first<{ n: number }>())!.n).toBe(0);
    const tomb = await env.BRAIN_DB.prepare(`SELECT id FROM events WHERE kind = 'purge_tombstone'`).first<{ id: string }>();
    const key = await env.BRAIN_DB.prepare(`SELECT wrapped_key FROM event_keys WHERE event_id = ?1`).bind(tomb!.id).first<{ wrapped_key: string }>();
    const body = JSON.parse(await decryptPayload(env.PAYLOAD_KEK, key!.wrapped_key, await (await env.BRAIN_RAW.get(`payloads/${tomb!.id}`))!.arrayBuffer()));
    expect(body).toEqual({ purged_event_id: "purge-happy", reason: "test" });
    const audit = await env.BRAIN_DB.prepare(`SELECT action, target_id FROM audit_log WHERE action = 'purge'`).first<{ action: string; target_id: string }>();
    expect(audit).toEqual({ action: "purge", target_id: "purge-happy" });
  });

  it("consumes tokens once; re-purge is an idempotent no-op", async () => {
    const id = await seed({ id: "purge-once" });
    const token = await mint(`event:${id}`);
    expect((await purge(id, token)).status).toBe(200);
    expect((await purge(id, token)).status).toBe(400);                      // single-use
    const fresh = await mint(`event:${id}`);
    const res = await purge(id, fresh);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: false });                    // already redacted
  });

  it("identical payloads get independent keys: purging one leaves the other decryptable", async () => {
    const a = await seed({ id: "ind-a", session_id: "ind-s1" });
    const b = await seed({ id: "ind-b", session_id: "ind-s2" }); // different session => not deduped
    expect((await purge(a, await mint(`event:${a}`))).status).toBe(200);
    expect(await env.BRAIN_RAW.get(`payloads/${a}`)).toBeNull();
    const key = await env.BRAIN_DB.prepare(`SELECT wrapped_key FROM event_keys WHERE event_id = ?1`).bind(b).first<{ wrapped_key: string }>();
    const plain = await decryptPayload(env.PAYLOAD_KEK, key!.wrapped_key, await (await env.BRAIN_RAW.get(`payloads/${b}`))!.arrayBuffer());
    expect(plain).toBe(JSON.stringify({ text: "alpha-secret-term" }));
    expect((await env.BRAIN_DB.prepare(`SELECT redacted FROM events WHERE id = ?1`).bind(b).first<{ redacted: number }>())!.redacted).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** → FAIL (no `src/purge.ts`).

- [ ] **Step 3: Implement `src/audit.ts` + `src/purge.ts` + routes** (sequence per the Interfaces block).

- [ ] **Step 4: Run it, verify it passes** → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: crypto-shred purge with single-use confirm tokens"
```

---

