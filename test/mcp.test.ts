import { env, exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Scope } from "../src/env";
import { bearer, call, fakeVec, installFakeVectorize } from "./helpers";
import { network } from "./server";

const EMB_URL = "https://gw.test/google-ai-studio/v1beta/models/gemini-embedding-001:batchEmbedContents";

// Shared-state adaptation (no per-test isolation): test 4 asserts a budget
// DELTA (tests 3's seeds also charge MCP_PROPOSE in this file).

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
  beforeAll(async () => {
    await network.enable();
  });
  beforeEach(() => {
    installFakeVectorize();
    network.use(
      http.post(EMB_URL, async ({ request }) => {
        const body = (await request.json()) as {
          requests?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const reqs = body.requests ?? [];
        return HttpResponse.json({ embeddings: reqs.map((r) => ({ values: fakeVec(r.content?.parts?.[0]?.text ?? "") })) });
      }),
    );
  });
  afterEach(() => {
    network.resetHandlers();
  });
  afterAll(async () => {
    await network.disable();
  });

  it("requires at least read scope", async () => {
    expect((await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, {})).status).toBe(401);
  });

  it("exposes exactly the read+propose toolset", async () => {
    const { body } = await mcp("MCP_READ", "tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "get_blocks",
      "health_report",
      "propose_block_edit",
      "propose_correction",
      "propose_forget",
      "propose_procedure",
      "recall",
      "remember",
    ]);
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
    const before = ((await env.BRAIN_DB.prepare(`SELECT rows_written FROM rate_budgets WHERE scope = 'MCP_PROPOSE'`).first<{ rows_written: number }>())?.rows_written) ?? 0;
    const ok = await callTool("MCP_PROPOSE", "remember", { text: "recorded via mcp", session_id: "mcp-3" });
    expect(JSON.parse(toolText(ok.body))).toMatchObject({ stored: true });
    const row = await env.BRAIN_DB.prepare(`SELECT actor, trust, kind FROM events WHERE kind = 'note' AND excerpt LIKE '%recorded via mcp%'`).first<{ actor: string; trust: number; kind: string }>();
    expect(row).toEqual({ actor: "assistant", trust: 0.9, kind: "note" });
    const after = ((await env.BRAIN_DB.prepare(`SELECT rows_written FROM rate_budgets WHERE scope = 'MCP_PROPOSE'`).first<{ rows_written: number }>())?.rows_written) ?? 0;
    expect(after - before).toBe(1); // remember charged the propose scope exactly once
    expect((await callTool("ADMIN", "remember", { text: "admin note" })).body.result.isError).toBeUndefined();
  });
});
