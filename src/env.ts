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
  /** Optional: unset = derived from `PAYLOAD_KEK` (domain-separated HMAC). Set it
   *  to decouple signing from the KEK; adding it later changes content keys and
   *  export links, so pick one arrangement once. */
  CONTENT_HMAC_KEY?: string;
  /** Optional: read scope. Unset = reads authenticate with `ADMIN_TOKEN`; set it
   *  to hand clients (opencode, the recall MCP) a read-only credential. */
  MCP_READ_TOKEN?: string;
  /** Optional: propose scope. Unset = writes authenticate with `ADMIN_TOKEN`; set
   *  it (distinct from the read token) to scope the capture path down. */
  MCP_PROPOSE_TOKEN?: string;
  ADMIN_TOKEN: string;
  AI_GATEWAY_BASE?: string;
  GEMINI_API_KEY: string;
  /** Optional: raises GitHub API rate limits for the connector; unauthenticated works for public repos. */
  GITHUB_TOKEN?: string;
  /** Optional: base URL of any OpenAI-compatible chat API (e.g. https://api.openai.com/v1). Set = run chat on that provider instead of Gemini. */
  AI_BASE_URL?: string;
  /** Optional: bearer key for the compatible chat provider; falls back to GEMINI_API_KEY. Unset both for keyless endpoints. */
  AI_API_KEY?: string;
  /** Optional: chat model for the compatible provider (e.g. gpt-4.1-mini); required when AI_BASE_URL is set. */
  AI_MODEL?: string;
  /** Optional: second chat model tried when the provider is down, rate-limited, or the model is retired. */
  AI_FALLBACK_MODEL?: string;
  /** Optional: embeddings base URL for a compatible provider; the literal "native" forces the Gemini embeddings path. */
  AI_EMBED_BASE_URL?: string;
  /** Optional: bearer key for compatible embeddings; falls back to AI_API_KEY, then GEMINI_API_KEY. */
  AI_EMBED_API_KEY?: string;
  /** Optional: embeddings model for the compatible provider; required when embeddings resolve to a compatible provider. */
  AI_EMBED_MODEL?: string;
  /** Optional: expected embedding size (integer 1-1536, default 768). Must match the Vectorize index; changing it re-embeds stored facts. */
  AI_EMBED_DIMS?: string;
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
