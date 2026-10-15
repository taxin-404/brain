### Task 1: Repo scaffold + Worker skeleton + test harness

**Files:**
- Create: `wrangler.jsonc`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.dev.vars`, `src/env.ts`, `src/index.ts`, `test/helpers.ts`, `test/smoke.test.ts`

**Interfaces:**
- Produces: `Env` (`BRAIN_DB: D1Database`, `BRAIN_RAW: R2Bucket`, `PAYLOAD_KEK | CONTENT_HMAC_KEY | MCP_READ_TOKEN | MCP_PROPOSE_TOKEN | ADMIN_TOKEN: string`), `Scope = "MCP_READ" | "MCP_PROPOSE" | "ADMIN"`, `TRUST: Record<"user"|"assistant"|"tool"|"external", number>`, `canRead/canPropose/canAdmin(scope)`, default export `{ fetch }`; test helpers `bearer(env, scope)`, `call(method, path, body?, headers?)`.

- [ ] **Step 1: Write the failing smoke test** — `test/smoke.test.ts`:

```ts
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("router", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await exports.default.fetch("https://brain.test/nope");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run test/smoke.test.ts` → FAIL (no `vitest.config.ts`, cannot resolve `src/index.ts`).

- [ ] **Step 3: Scaffold the repo** — `git init`, then create:

`wrangler.jsonc` (database_id filled in Task 3 after `wrangler d1 create`):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "brain-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "d1_databases": [{ "binding": "BRAIN_DB", "database_name": "brain-db", "database_id": "PENDING" }],
  "r2_buckets": [{ "binding": "BRAIN_RAW", "bucket_name": "brain-raw" }],
  "observability": { "enabled": true },
  "env": {
    "staging": { "name": "brain-api-staging" },
    "prod": { "name": "brain-api" }
  }
}
```

`package.json` — scripts `"test": "vitest run"`, `"deploy": "wrangler deploy"`; devDependencies: `wrangler`, `typescript`, `vitest@^4.1.0`, `@cloudflare/vitest-plugin`, `@cloudflare/workers-types`; dependencies (installed in Task 11): `@modelcontextprotocol/server`, `zod`.

`tsconfig.json` — strict, `target/lib ES2022`, `module ESNext`, `moduleResolution bundler`, `resolveJsonModule`, `noEmit`, `types: ["@cloudflare/workers-types", "@cloudflare/vitest-plugin/types"]`, `include: ["src/**/*.ts", "test/**/*.ts"]` (deliberately excludes `vitest.config.ts`).

`vitest.config.ts`:

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PAYLOAD_KEK: "dev-kek",
          CONTENT_HMAC_KEY: "dev-hmac",
          MCP_READ_TOKEN: "dev-read",
          MCP_PROPOSE_TOKEN: "dev-propose",
          ADMIN_TOKEN: "dev-admin",
        },
      },
    }),
  ],
});
```

`.gitignore`: `node_modules/`, `.wrangler/`, `.dev.vars`, `dist/`. `.dev.vars` (dev-only values, same as test bindings):

```text
PAYLOAD_KEK=dev-kek
CONTENT_HMAC_KEY=dev-hmac
MCP_READ_TOKEN=dev-read
MCP_PROPOSE_TOKEN=dev-propose
ADMIN_TOKEN=dev-admin
```

`src/env.ts`:

```ts
export type Scope = "MCP_READ" | "MCP_PROPOSE" | "ADMIN";
export type Need = "read" | "propose" | "admin";
export interface Env {
  BRAIN_DB: D1Database;
  BRAIN_RAW: R2Bucket;
  PAYLOAD_KEK: string;
  CONTENT_HMAC_KEY: string;
  MCP_READ_TOKEN: string;
  MCP_PROPOSE_TOKEN: string;
  ADMIN_TOKEN: string;
}
export const TRUST = { user: 1.0, assistant: 0.9, tool: 0.7, external: 0.4 } as const;
export function canRead(scope: Scope): boolean { return scope === "MCP_READ" || scope === "ADMIN"; }
export function canPropose(scope: Scope): boolean { return scope === "MCP_PROPOSE" || scope === "ADMIN"; }
export function canAdmin(scope: Scope): boolean { return scope === "ADMIN"; }
```

`src/index.ts` — minimal router (extended by later tasks), 404 fallback:

```ts
import type { Env, Scope } from "./env";
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

`test/helpers.ts`:

```ts
import { exports } from "cloudflare:workers";
import type { Env, Scope } from "../src/env";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

export function bearer(env: Env, scope: Scope): Record<string, string> {
  const token =
    scope === "ADMIN" ? env.ADMIN_TOKEN : scope === "MCP_PROPOSE" ? env.MCP_PROPOSE_TOKEN : env.MCP_READ_TOKEN;
  return { authorization: `Bearer ${token}` };
}

export async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(`https://brain.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
```

- [ ] **Step 4: Run tests and typecheck, verify they pass**

Run: `npx vitest run test/smoke.test.ts` → PASS; `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold brain-api worker with vitest harness"
```

---

