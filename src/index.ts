import type { Env, Need, Scope } from "./env";
import { resolveScope, requireScope } from "./auth";
import { json } from "./http";
import { healthReport } from "./health";
import { handleEvents } from "./ingest";
import { handleMintToken, handlePurge } from "./purge";
import { handleSearch } from "./search";
import { handleGetBlocks, handlePutBlock } from "./blocks";
import { handleMcp } from "./mcp";

export type Handler = (
  request: Request,
  env: Env,
  scope: Scope,
  ctx: ExecutionContext,
  match: RegExpExecArray,
) => Promise<Response>;

const ROUTES: Array<{ method: string; re: RegExp; need: Need; handler: Handler }> = [
  {
    method: "GET",
    re: /^\/v1\/health-report$/,
    need: "read",
    handler: async (_r, env) => json(await healthReport(env)),
  },
  {
    method: "POST",
    re: /^\/v1\/events$/,
    need: "propose",
    handler: (request, env, scope) => handleEvents(request, env, scope),
  },
  {
    method: "POST",
    re: /^\/v1\/events\/batch$/,
    need: "propose",
    handler: (request, env, scope) => handleEvents(request, env, scope),
  },
  {
    method: "POST",
    re: /^\/v1\/confirm\/token$/,
    need: "admin",
    handler: (request, env) => handleMintToken(request, env),
  },
  {
    method: "POST",
    re: /^\/v1\/events\/([A-Za-z0-9_-]+)\/purge$/,
    need: "admin",
    handler: (request, env, _scope, _ctx, match) => handlePurge(request, env, match[1]),
  },
  {
    method: "GET",
    re: /^\/v1\/search$/,
    need: "read",
    handler: (request, env, scope) => handleSearch(request, env, scope),
  },
  {
    method: "GET",
    re: /^\/v1\/blocks$/,
    need: "read",
    handler: (_request, env) => handleGetBlocks(env),
  },
  {
    method: "PUT",
    re: /^\/v1\/blocks\/([a-z][a-z0-9_]*)$/,
    need: "admin",
    handler: (request, env, _scope, _ctx, match) => handlePutBlock(request, env, match[1]),
  },
  {
    method: "GET",
    re: /^\/mcp$/,
    need: "any", // any valid token; tools gate themselves (recall=read, remember=propose)
    handler: (request, env, scope) => handleMcp(request, env, scope),
  },
  {
    method: "POST",
    re: /^\/mcp$/,
    need: "any",
    handler: (request, env, scope) => handleMcp(request, env, scope),
  },
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    for (const route of ROUTES) {
      if (route.method !== request.method) continue;
      const match = route.re.exec(pathname);
      if (!match) continue;
      const denied = requireScope(request, env, route.need);
      if (denied) return denied;
      const scope = resolveScope(request, env);
      if (!scope) return new Response("unauthorized", { status: 401 });
      return route.handler(request, env, scope, ctx, match);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
