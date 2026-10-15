import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env, Scope } from "./env";
import { canPropose } from "./env";
import { healthReport } from "./health";
import { ingestEvents } from "./ingest";
import { createProposal, ProposalError } from "./proposals";
import { searchEvents, searchFacts } from "./search";

const PROPOSE_DENIED = {
  content: [{ type: "text" as const, text: "MCP_PROPOSE scope required" }],
  isError: true as const,
};

/** Proposal tools share one reply shape; charge rejections surface as isError
 *  text with the same codes ingest uses (over_limit / breaker_open). */
async function proposalReply(run: () => Promise<{ id: string }>) {
  try {
    const { id } = await run();
    return { content: [{ type: "text" as const, text: JSON.stringify({ created: true, id }) }] };
  } catch (err) {
    if (err instanceof ProposalError) {
      return { content: [{ type: "text" as const, text: err.code }], isError: true as const };
    }
    throw err;
  }
}

/** Stateless MCP server, built fresh per request. Eight tools exist. The four
 *  propose_* tools only land reviewable `proposals` rows (never apply them);
 *  apply/undo/export durable destructive actions stay behind the Bearer HTTP API. */
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

  server.registerTool(
    "propose_correction",
    {
      description: "Propose a correction to a stored fact (lands as a reviewable proposal; requires propose scope).",
      inputSchema: z.object({
        fact_id: z.string(),
        correction: z.string(),
        evidence_event_id: z.string().optional(),
        reason: z.string().optional(),
      }),
    },
    async ({ fact_id, correction, evidence_event_id, reason }) => {
      if (!canPropose(scope)) return PROPOSE_DENIED;
      const fact = await env.BRAIN_DB.prepare(`SELECT sensitivity FROM facts WHERE id = ?1`)
        .bind(fact_id)
        .first<{ sensitivity: string }>();
      if (!fact) return { content: [{ type: "text" as const, text: "fact not found" }], isError: true };
      return proposalReply(() =>
        createProposal(env, scope, {
          kind: "correction",
          payload: { fact_id, correction, ...(reason ? { reason } : {}) },
          target_type: "fact",
          target_id: fact_id,
          evidence_event_id,
          sensitivity: fact.sensitivity,
        }),
      );
    },
  );

  server.registerTool(
    "propose_forget",
    {
      description: "Propose forgetting a fact or event (always manual review; requires propose scope).",
      inputSchema: z.object({
        target_type: z.enum(["fact", "event"]),
        target_id: z.string(),
        reason: z.string().optional(),
      }),
    },
    async ({ target_type, target_id, reason }) => {
      if (!canPropose(scope)) return PROPOSE_DENIED;
      return proposalReply(() =>
        createProposal(env, scope, {
          kind: "forget",
          payload: { target_type, target_id, ...(reason ? { reason } : {}) },
          target_type,
          target_id,
        }),
      );
    },
  );

  server.registerTool(
    "propose_block_edit",
    {
      description: "Propose an edit to a working-memory block (always manual review; requires propose scope).",
      inputSchema: z.object({ key: z.string(), value: z.string(), reason: z.string().optional() }),
    },
    async ({ key, value, reason }) => {
      if (!canPropose(scope)) return PROPOSE_DENIED;
      return proposalReply(() =>
        createProposal(env, scope, {
          kind: "block_edit",
          payload: { key, value, ...(reason ? { reason } : {}) },
          target_type: "block",
          target_id: key,
        }),
      );
    },
  );

  server.registerTool(
    "propose_procedure",
    {
      description: "Propose a new procedure (always manual review; requires propose scope).",
      inputSchema: z.object({ name: z.string(), steps: z.array(z.string()).min(1), reason: z.string().optional() }),
    },
    async ({ name, steps, reason }) => {
      if (!canPropose(scope)) return PROPOSE_DENIED;
      return proposalReply(() =>
        createProposal(env, scope, {
          kind: "procedure",
          payload: { name, steps, ...(reason ? { reason } : {}) },
          target_type: "procedure",
        }),
      );
    },
  );

  return server;
}

export function handleMcp(request: Request, env: Env, scope: Scope): Promise<Response> {
  const handler = createMcpHandler(() => createBrainMcpServer(env, scope));
  return handler.fetch(request);
}
