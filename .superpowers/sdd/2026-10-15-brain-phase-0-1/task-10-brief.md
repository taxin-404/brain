### Task 10: Keyword search + working-memory blocks

**Files:**
- Create: `src/search.ts`, `src/blocks.ts`, `test/search.test.ts`, `test/blocks.test.ts`
- Modify: `src/index.ts` (3 routes)

**Interfaces:**
- Produces:

```ts
export interface SearchHit { id: string; ts: number; kind: string; excerpt: string; privacy: string }
export async function searchEvents(env: Env, q: string, limit: number, opts: { includeRestricted: boolean }): Promise<SearchHit[]>;
export function handleSearch(request: Request, env: Env, scope: Scope): Promise<Response>;

export const BLOCK_KEYS = ["identity", "preferences", "active_projects", "infrastructure", "constraints", "objective"] as const;
export function handleGetBlocks(env: Env): Promise<Response>;                       // { blocks: Array<{ key, value, updated_at }> }
export function handlePutBlock(request: Request, env: Env, key: string): Promise<Response>;
```

- Query sanitization is pinned: split on whitespace, wrap each term as an FTS5 phrase (double internal quotes), join with ` AND `. SQL: join `events_fts` → `events` on rowid, `WHERE events_fts MATCH ? AND e.redacted = 0 AND (e.privacy != 'restricted' OR ?includeRestricted) ORDER BY rank LIMIT ?`.
- Routes: `GET /^\/v1\/search$/` read (`q` required else 400; `limit` default 8, clamp 1–50; `include_restricted=true` with non-ADMIN scope → 403) → `{ results: SearchHit[] }`; `GET /^\/v1\/blocks$/` read; `PUT /^\/v1\/blocks\/([a-z][a-z0-9_]*)$/` admin (key must be in `BLOCK_KEYS` else 400; body `{ value: string }` non-empty else 400; upsert; `writeAudit` with `action: "create" | "correct"` (new vs existing), `targetType: "block"`, before/after values).

- [ ] **Step 1: Write the failing search test** — `test/search.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { EventInput } from "../src/ingest";
import { bearer, call } from "./helpers";

const seed = (over: Partial<EventInput>) =>
  call("POST", "/v1/events", { source: "manual", actor: "user", kind: "note", ...over }, bearer(env, "MCP_PROPOSE"));
const search = (qs: string, scope: "MCP_READ" | "ADMIN" = "MCP_READ") => call("GET", `/v1/search${qs}`, undefined, bearer(env, scope));

describe("search", () => {
  it("returns keyword hits and excludes restricted for read scope", async () => {
    await seed({ session_id: "sq-1", payload: { text: "kubernetes rollout plan" } });
    await seed({ session_id: "sq-2", privacy: "restricted", payload: { text: "kubernetes restricted detail" } });
    const res = await search("?q=kubernetes");
    expect(res.status).toBe(200);
    const body = await res.json<{ results: Array<{ excerpt: string }> }>();
    expect(body.results.some((r) => r.excerpt.includes("rollout plan"))).toBe(true);
    expect(body.results.some((r) => r.excerpt.includes("restricted detail"))).toBe(false);
    expect((await search("?q=kubernetes&include_restricted=true")).status).toBe(403);
    const admin = await search("?q=kubernetes&include_restricted=true", "ADMIN");
    expect((await admin.json<{ results: unknown[] }>()).results.length).toBeGreaterThanOrEqual(2);
  });

  it("never returns purged events", async () => {
    const id = (await (await seed({ session_id: "sq-3", payload: { text: "vanishterm unique" } })).json<{ results: Array<{ id: string }> }>()).results[0].id;
    const token = (await (await call("POST", "/v1/confirm/token", { target: `event:${id}` }, bearer(env, "ADMIN"))).json<{ token: string }>()).token;
    await call("POST", `/v1/events/${id}/purge`, { confirm_token: token, reason: "t" }, bearer(env, "ADMIN"));
    const body = await (await search("?q=vanishterm")).json<{ results: unknown[] }>();
    expect(body.results).toEqual([]);
  });

  it("sanitizes FTS metacharacters and validates input", async () => {
    expect((await search("")).status).toBe(400);
    expect((await search('?q=kube" OR x=1')).status).toBe(200);
    expect((await call("GET", "/v1/search?q=x")).status).toBe(401);
  });
});
```

- [ ] **Step 2: Write the failing blocks test** — `test/blocks.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bearer, call } from "./helpers";

describe("blocks", () => {
  it("enforces scopes and the key whitelist", async () => {
    expect((await call("GET", "/v1/blocks")).status).toBe(401);
    expect((await call("PUT", "/v1/blocks/identity", { value: "x" }, bearer(env, "MCP_READ"))).status).toBe(403);
    expect((await call("PUT", "/v1/blocks/foo", { value: "x" }, bearer(env, "ADMIN"))).status).toBe(400);
    expect((await call("PUT", "/v1/blocks/identity", { value: "" }, bearer(env, "ADMIN"))).status).toBe(400);
  });

  it("upserts with ADMIN and audits the write", async () => {
    expect((await call("PUT", "/v1/blocks/objective", { value: "ship phase 1" }, bearer(env, "ADMIN"))).status).toBe(200);
    await call("PUT", "/v1/blocks/objective", { value: "ship phase 1 and 2" }, bearer(env, "ADMIN"));
    const body = await (await call("GET", "/v1/blocks", undefined, bearer(env, "MCP_READ"))).json<{ blocks: Array<{ key: string; value: string }> }>();
    expect(body.blocks).toEqual([expect.objectContaining({ key: "objective", value: "ship phase 1 and 2" })]);
    const { results } = await env.BRAIN_DB.prepare(`SELECT action FROM audit_log WHERE target_id = 'objective' ORDER BY ts`).all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual(["create", "correct"]);
  });
});
```

- [ ] **Step 3: Run both, verify they fail** → FAIL (missing modules/routes).

- [ ] **Step 4: Implement `src/search.ts` + `src/blocks.ts` + routes**

- [ ] **Step 5: Run them, verify they pass** → PASS (search 3, blocks 2).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: FTS keyword search and audited working-memory blocks"
```

---

