export type Scope = "MCP_READ" | "MCP_PROPOSE" | "ADMIN";
/** `public` = no bearer required: the handler authenticates itself (HMAC-
 *  signed export download URLs) or serves a data-free shell (the inspector
 *  page). Exact list is two routes; keep it that way. */
export type Need = "read" | "propose" | "admin" | "any" | "public";
export interface Env {
  BRAIN_DB: D1Database;
  BRAIN_RAW: R2Bucket;
  VECTORIZE: VectorizeIndex;
  PAYLOAD_KEK: string;
  CONTENT_HMAC_KEY: string;
  MCP_READ_TOKEN: string;
  MCP_PROPOSE_TOKEN: string;
  ADMIN_TOKEN: string;
  AI_GATEWAY_BASE: string;
  GEMINI_API_KEY: string;
  /** Optional: raises GitHub API rate limits for the connector; unauthenticated works for public repos. */
  GITHUB_TOKEN?: string;
}
export const TRUST = { user: 1.0, assistant: 0.9, tool: 0.7, external: 0.4 } as const;
export function canRead(scope: Scope): boolean {
  return scope === "MCP_READ" || scope === "ADMIN";
}
export function canPropose(scope: Scope): boolean {
  return scope === "MCP_PROPOSE" || scope === "ADMIN";
}
export function canAdmin(scope: Scope): boolean {
  return scope === "ADMIN";
}
