import type { Env, Need, Scope } from "./env";
import { canAdmin, canPropose, canRead } from "./env";

export function resolveScope(request: Request, env: Env): Scope | null {
  const header = request.headers.get("authorization");
  if (header === `Bearer ${env.ADMIN_TOKEN}`) return "ADMIN";
  if (header === `Bearer ${env.MCP_PROPOSE_TOKEN}`) return "MCP_PROPOSE";
  if (header === `Bearer ${env.MCP_READ_TOKEN}`) return "MCP_READ";
  return null;
}

export function requireScope(request: Request, env: Env, need: Need): Response | null {
  const scope = resolveScope(request, env);
  if (!scope) return new Response("unauthorized", { status: 401 });
  // "any": any valid token reaches the route; per-tool gating happens inside
  // (used by /mcp, which serves read tools for MCP_READ and `remember` for
  // MCP_PROPOSE — the scope hierarchy here is strict, so "read" would 403 the
  // propose token that spec §11 requires on the same endpoint).
  const ok =
    need === "any" ? true : need === "read" ? canRead(scope) : need === "propose" ? canPropose(scope) : canAdmin(scope);
  if (!ok) return new Response("forbidden", { status: 403 });
  return null;
}
