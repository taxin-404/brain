### Task 3: Auth middleware + budget read + health endpoint + Phase 0 gate

**Files:**
- Create: `src/auth.ts`, `src/http.ts`, `src/budget.ts`, `src/health.ts`, `test/auth.test.ts`
- Modify: `src/index.ts` (router), `wrangler.jsonc` (database_id from `wrangler d1 create`)

**Interfaces:**
- Produces: `json(data, status=200): Response`; `resolveScope(request: Request, env: Env): Scope | null`; `requireScope(request: Request, env: Env, need: Need): Response | null` (401 unknown/missing token, 403 wrong scope); `dayKey(now: number): string` (UTC `YYYY-MM-DD`); `PROPOSE_CAP = 10_000`, `WARN_AT = 70_000`, `BREAKER_AT = 80_000`; `readBudget(db: D1Database, now?: number): Promise<{ used: number; warn: boolean; breaker: boolean }>` (reads `__global__` row for the day); `HealthReport = { events: number; budget: { used: number; warn: boolean; breaker: boolean }; purges: number; pending_proposals: number }`; `healthReport(env: Env): Promise<HealthReport>` (`events` = all rows in `events`, `purges` = count of `kind='purge_tombstone'`, `pending_proposals` = `status='pending'`).
- Router contract (all later tasks add entries, never change it):

```ts
// src/index.ts
export type Handler = (
  request: Request, env: Env, scope: Scope, ctx: ExecutionContext, match: RegExpExecArray,
) => Promise<Response>;
const ROUTES: Array<{ method: string; re: RegExp; need: Need; handler: Handler }> = [/* ... */];
// fetch(): match pathname+method -> requireScope -> handler; else 404.
```

- [ ] **Step 1: Write the failing auth + health test** — `test/auth.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { dayKey } from "../src/budget";
import { bearer, call } from "./helpers";

describe("auth + health", () => {
  it("rejects missing and unknown tokens with 401", async () => {
    expect((await call("GET", "/v1/health-report")).status).toBe(401);
    expect((await call("GET", "/v1/health-report", undefined, { authorization: "Bearer nope" })).status).toBe(401);
  });

  it("rejects insufficient scope with 403 (strict: propose is not read)", async () => {
    expect((await call("GET", "/v1/health-report", undefined, bearer(env, "MCP_PROPOSE"))).status).toBe(403);
  });

  it("returns the health report shape with live counts", async () => {
    await env.BRAIN_DB.prepare(
      `INSERT INTO events (id, ts, ingested_at, source, actor, trust, kind, excerpt, content_hmac)
       VALUES ('h1', 1, 1, 'manual', 'user', 1.0, 'note', 'x', 'hh1')`,
    ).run();
    await env.BRAIN_DB.prepare(
      `INSERT INTO rate_budgets (scope, day, rows_written) VALUES ('__global__', ?1, 70000)`,
    ).bind(dayKey(Date.now())).run();
    const res = await call("GET", "/v1/health-report", undefined, bearer(env, "MCP_READ"));
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ events: 1, budget: { used: 70000, warn: true, breaker: false }, purges: 0, pending_proposals: 0 });
    expect((await call("GET", "/v1/health-report", undefined, bearer(env, "ADMIN"))).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run test/auth.test.ts` → FAIL (404s, no `src/budget.ts`).

- [ ] **Step 3: Implement auth, budget read, health, router**

`src/auth.ts`: compare the raw Bearer token against the three env secrets (exact match, `ADMIN_TOKEN` → `"ADMIN"`, etc.); `requireScope` returns `null` when `canRead/canPropose/canAdmin(scope)` passes for `need`. `src/health.ts` uses `env.BRAIN_DB` (COUNT queries) + `readBudget`. Add the health route to `ROUTES` and implement the router per the Interfaces block.

- [ ] **Step 4: Run tests and full suite, verify green**

Run: `npx vitest run` → PASS (smoke + schema + auth); `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: scoped token auth, budget read, health endpoint"
```

- [ ] **Step 6: Phase 0 gate — provision and deploy**

```bash
npx wrangler whoami                     # if not logged in: npx wrangler login (human step)
npx wrangler d1 create brain-db         # copy database_id into wrangler.jsonc (replace PENDING)
npx wrangler r2 bucket create brain-raw
npx wrangler d1 migrations apply brain-db --remote   # expect: 5 migrations applied
npx wrangler deploy                     # expect: "Uploaded brain-api"
```

Then generate + escrow prod secrets (KEK **must** be saved to the password manager before it is piped away — human step):

```bash
KEK=$(openssl rand -base64 32)          # save to password manager NOW (spec §3 escrow)
printf '%s' "$KEK" | npx wrangler secret put PAYLOAD_KEK
openssl rand -base64 32 | npx wrangler secret put CONTENT_HMAC_KEY
for s in MCP_READ_TOKEN MCP_PROPOSE_TOKEN ADMIN_TOKEN; do openssl rand -hex 32 | npx wrangler secret put "$s"; done
export MCP_READ_TOKEN='<the read token you just set>'   # keep for the curl below
curl -s "https://brain-api.<your-subdomain>.workers.dev/v1/health-report" -H "Authorization: Bearer $MCP_READ_TOKEN"
# expect: 200 {"events":0,...,"budget":{"used":0,"warn":false,"breaker":false},"purges":0,"pending_proposals":0}
```

- [ ] **Step 7: Commit the provisioned config**

```bash
git add wrangler.jsonc && git commit -m "chore: provision brain-db database id"
```

---

