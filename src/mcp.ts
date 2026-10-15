import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env, Scope } from "./env";
import { canPropose } from "./env";
import { healthReport } from "./health";
import { ingestEvents } from "./ingest";
import { searchEvents, searchFacts } from "./search";

/** Stateless MCP server, built fresh per request. Exactly four tools exist;
 *  `forget`/`approve`/`export`/`dispute` are deliberately NOT registered
 *  anywhere (destructive and policy actions stay behind the Bearer HTTP API). */
export function createBrainMcpServer(env: Env, scope: Scope): McpServer {
  const server = new McpServer({ name: "brain", version: "0.1.0" });

  server.registerTool(
    "recall",
    {
      description: "Semantic + keyword search over stored memory (redacted excerpts; restricted excluded).",
      inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).optional() }),
    },
    async ({ query, limit }) => {
      const n = limit ?? 8;
      const [results, facts] = await Promise.all([
        searchEvents(env, query, n, { includeRestricted: false }),
        searchFacts(env, query, n, { includeRestricted: false }),
      ]);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ results, facts: facts.facts, ...(facts.degraded ? { degraded: true } : {}) }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_blocks",
    { description: "Fetch the working-memory blocks (identity, preferences, projects, ...)." },
    async () => {
      const { results } = await env.BRAIN_DB.prepare(
        `SELECT key, value, updated_at FROM blocks ORDER BY key`,
      ).all();
      return { content: [{ type: "text" as const, text: JSON.stringify(results) }] };
    },
  );

  server.registerTool(
    "health_report",
    { description: "Budget, breaker and storage health for the brain." },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(await healthReport(env)) }],
    }),
  );

  server.registerTool(
    "remember",
    {
      description: "Propose a memory note (requires propose scope).",
      inputSchema: z.object({ text: z.string(), session_id: z.string().optional() }),
    },
    async ({ text, session_id }) => {
      if (!canPropose(scope)) {
        return { content: [{ type: "text" as const, text: "MCP_PROPOSE scope required" }], isError: true };
      }
      const { results } = await ingestEvents(env, scope, [
        { source: "manual", actor: "assistant", kind: "note", session_id, payload: { text } },
      ]);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ stored: true, id: results[0].id }) }],
      };
    },
  );

  return server;
}

export function handleMcp(request: Request, env: Env, scope: Scope): Promise<Response> {
  const handler = createMcpHandler(() => createBrainMcpServer(env, scope));
  return handler.fetch(request);
}
