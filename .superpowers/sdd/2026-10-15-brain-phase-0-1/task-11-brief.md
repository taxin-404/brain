### Task 11: Stateless MCP server (read + propose only)

**Files:**
- Create: `src/mcp.ts`, `test/mcp.test.ts`
- Modify: `src/index.ts` (1 route, GET+POST)

**Interfaces:**
- Produces: `createBrainMcpServer(env: Env, scope: Scope): McpServer` — built fresh per request from `import { McpServer, createMcpHandler } from "@modelcontextprotocol/server"`; route `/^\/mcp$/` (GET and POST) with `need: "read"`, handler:

```ts
const handler = createMcpHandler(() => createBrainMcpServer(env, scope));
return handler(request, env, ctx);
```

- Tools (exact names): `recall` `{ query: z.string(), limit?: z.number().int().min(1).max(20) }` → `searchEvents(env, query, limit ?? 8, { includeRestricted: false })` as JSON text; `get_blocks` → blocks array; `health_report` → `healthReport(env)`; `remember` `{ text: z.string(), session_id?: z.string() }` → if `!canPropose(scope)` return `isError: true` with "MCP_PROPOSE scope required", else `ingestEvents(env, scope, [{ source: "manual", actor: "assistant", kind: "note", session_id, payload: { text } }])` and return `{ stored: true, id }`. No other tools exist — `forget`/`approve`/`export`/`dispute` are not registered anywhere.

- [ ] **Step 1: Write the failing MCP test** — `test/mcp.test.ts`:

```ts
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Scope } from "../src/env";
import { bearer, call } from "./helpers";

const send = (body: unknown, headers: Record<string, string>) =>
  exports.default.fetch("https://brain.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });

function parseMcp(text: string): any {
  if (text.startsWith("event:") || text.startsWith("data:"))
    return JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""));
  return JSON.parse(text);
}

async function mcp(scope: Scope, method: string, params?: unknown) {
  const hdrs = bearer(env, scope);
  const init = await send(
    { jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    hdrs,
  );
  const sessionId = init.headers.get("mcp-session-id");
  const withSession = sessionId ? { ...hdrs, "mcp-session-id": sessionId } : hdrs;
  await send({ jsonrpc: "2.0", method: "notifications/initialized" }, withSession);
  const res = await send({ jsonrpc: "2.0", id: 2, method, params }, withSession);
  return { status: res.status, body: parseMcp(await res.text()) };
}
const callTool = (scope: Scope, name: string, args: unknown = {}) => mcp(scope, "tools/call", { name, arguments: args });
const toolText = (body: any): string => body.result.content[0].text;

describe("mcp", () => {
  it("requires at least read scope", async () => {
    expect((await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, {})).status).toBe(401);
  });

  it("exposes exactly the read+propose toolset", async () => {
    const { body } = await mcp("MCP_READ", "tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["get_blocks", "health_report", "recall", "remember"]);
  });

  it("recall excludes restricted and never leaks confirm tokens", async () => {
    await call("POST", "/v1/events", { source: "manual", actor: "user", kind: "note", session_id: "mcp-1", payload: { text: "mcpfind normal note" } }, bearer(env, "MCP_PROPOSE"));
    await call("POST", "/v1/events", { source: "manual", actor: "user", kind: "note", session_id: "mcp-2", privacy: "restricted", payload: { text: "mcpfind restricted note" } }, bearer(env, "MCP_PROPOSE"));
    const token = (await (await call("POST", "/v1/confirm/token", { target: "event:x" }, bearer(env, "ADMIN"))).json<{ token: string }>()).token;
    const { body } = await callTool("MCP_READ", "recall", { query: "mcpfind" });
    const text = toolText(body);
    expect(text).toContain("normal note");
    expect(text).not.toContain("restricted note");
    expect(text).not.toContain(token);
    const health = await callTool("MCP_READ", "health_report");
    expect(toolText(health.body)).not.toContain(token);
  });

  it("gates remember on propose scope and stores as assistant/0.9", async () => {
    const denied = await callTool("MCP_READ", "remember", { text: "nope" });
    expect(denied.body.result.isError).toBe(true);
    const ok = await callTool("MCP_PROPOSE", "remember", { text: "recorded via mcp", session_id: "mcp-3" });
    expect(JSON.parse(toolText(ok.body))).toMatchObject({ stored: true });
    const row = await env.BRAIN_DB.prepare(`SELECT actor, trust, kind FROM events WHERE kind = 'note' AND excerpt LIKE '%recorded via mcp%'`).first<{ actor: string; trust: number; kind: string }>();
    expect(row).toEqual({ actor: "assistant", trust: 0.9, kind: "note" });
    const budget = await env.BRAIN_DB.prepare(`SELECT rows_written FROM rate_budgets WHERE scope = 'MCP_PROPOSE'`).first<{ rows_written: number }>();
    expect(budget!.rows_written).toBe(1);
    expect((await callTool("ADMIN", "remember", { text: "admin note" })).body.result.isError).toBeUndefined();
  });
});
```

If `initialize` is rejected for the pinned protocol version, log the server's supported `protocolVersion` and use that value in the helper.

- [ ] **Step 2: Run it, verify it fails** → FAIL (no `/mcp` route).

- [ ] **Step 3: Install deps and implement `src/mcp.ts` + route** (`npx npm i @modelcontextprotocol/server zod` for runtime deps).

- [ ] **Step 4: Run it, verify it passes** → PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: stateless MCP server with read+propose tools only"
```

---

