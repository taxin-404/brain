### Task 9: Rebuilder honoring tombstones

**Files:**
- Create: `src/rebuild.ts`, `test/rebuild.test.ts`

**Interfaces:**
- Produces: `rebuildProjections(env: Env): Promise<{ fts_rows: number }>` — re-derives the FTS projection from `events` (`INSERT INTO events_fts(events_fts) VALUES('rebuild')`), returns the resulting row count. Tombstoned events rebuild as NULL-content rows, so purged text stays unfindable. (Phase 2 appends fact/vector rebuild steps here; keep the single entry point.) If `'rebuild'` misbehaves under D1, fall back to delete-all + re-insert-by-rowid from `events`; the tests below are the contract, the mechanism is not.

- [ ] **Step 1: Write the failing rebuild test** — `test/rebuild.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rebuildProjections } from "../src/rebuild";
import { bearer, call } from "./helpers";

const post = (body: unknown) => call("POST", "/v1/events", body, bearer(env, "MCP_PROPOSE"));
const match = async (term: string) =>
  (await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH ?1`).bind(`"${term}"`).first<{ n: number }>())!.n;

async function seedWithPurge() {
  const keep = (await (await post({ source: "manual", actor: "user", kind: "note", session_id: "rb-1", payload: { text: "keepalpha term" } })).json<{ results: Array<{ id: string }> }>()).results[0].id;
  const gone = (await (await post({ source: "manual", actor: "user", kind: "note", session_id: "rb-2", payload: { text: "gonebeta term" } })).json<{ results: Array<{ id: string }> }>()).results[0].id;
  const token = (await (await call("POST", "/v1/confirm/token", { target: `event:${gone}` }, bearer(env, "ADMIN"))).json<{ token: string }>()).token;
  await call("POST", `/v1/events/${gone}/purge`, { confirm_token: token, reason: "rb test" }, bearer(env, "ADMIN"));
  return { keep, gone };
}

describe("rebuild", () => {
  it("honors purge tombstones: purged text must not resurrect", async () => {
    await seedWithPurge();
    expect(await match("gonebeta")).toBe(0);
    const { fts_rows } = await rebuildProjections(env);
    expect(await match("keepalpha")).toBe(1);
    expect(await match("gonebeta")).toBe(0);            // Review Focus 4
    const total = (await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM events`).first<{ n: number }>())!.n;
    expect(fts_rows).toBe(total);                        // every row re-derived, redacted ones empty
  });

  it("is idempotent and equals the live projection", async () => {
    await seedWithPurge();
    const first = await rebuildProjections(env);
    const second = await rebuildProjections(env);
    expect(second).toEqual(first);
    expect(await match("keepalpha")).toBe(1);
    expect(await match("gonebeta")).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** → FAIL (no `src/rebuild.ts`).

- [ ] **Step 3: Implement `src/rebuild.ts`**

- [ ] **Step 4: Run it, verify it passes** → PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: rebuildable FTS projection that honors purge tombstones"
```

---

