import type { Env, Need, Scope } from "./env";
import { resolveScope, requireScope } from "./auth";
import { json } from "./http";
import { healthReport } from "./health";
import { handleEvents } from "./ingest";
import { handleExtract } from "./extract";
import { handleConsolidate, runConsolidation } from "./consolidate";
import { handleReflect, handleReflectionsLatest, runReflection } from "./reflect";
import { handleGetFact, handleWhy } from "./facts";
import { handleGetEntity } from "./graph";
import { handleMintToken, handlePurge } from "./purge";
import { handleSearch } from "./search";
import { handleGetBlocks, handlePutBlock } from "./blocks";
import { handleMcp } from "./mcp";
import { handleListProposals } from "./proposals";
import { handleGithubSync } from "./connector-github";
import { handleApproveProcedure, handleGetProcedure, handleListProcedures } from "./procedures";
import { handleFactReview, handleProposalReview } from "./review";
import { runSweep } from "./sweep";

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
    re: /^\/v1\/facts\/([A-Za-z0-9_-]+)$/,
    need: "read",
    handler: (_request, env, scope, _ctx, match) => handleGetFact(env, scope, match[1]),
  },
  {
    method: "GET",
    re: /^\/v1\/why\/([A-Za-z0-9_-]+)$/,
    need: "read",
    handler: (_request, env, scope, _ctx, match) => handleWhy(env, scope, match[1]),
  },
  {
    method: "GET",
    re: /^\/v1\/entities\/([A-Za-z0-9_-]+)$/,
    need: "read",
    handler: (_request, env, scope, _ctx, match) => handleGetEntity(env, scope, match[1]),
  },
  {
    method: "GET",
    re: /^\/v1\/proposals$/,
    need: "read",
    handler: (request, env, scope) => handleListProposals(request, env, scope),
  },
  {
    method: "POST",
    re: /^\/v1\/facts\/([A-Za-z0-9_-]+)\/(correct|dispute|purge)$/,
    need: "admin",
    handler: (request, env, scope, _ctx, match) => handleFactReview(request, env, scope, match[1], match[2]),
  },
  {
    method: "POST",
    re: /^\/v1\/proposals\/([A-Za-z0-9_-]+)\/(apply|discard|undo)$/,
    need: "admin",
    handler: (request, env, scope, _ctx, match) => handleProposalReview(request, env, scope, match[1], match[2]),
  },
  {
    method: "POST",
    re: /^\/v1\/extract$/,
    need: "admin",
    handler: (request, env) => handleExtract(request, env),
  },
  {
    method: "POST",
    re: /^\/v1\/consolidate$/,
    need: "admin",
    handler: (_request, env) => handleConsolidate(env),
  },
  {
    method: "POST",
    re: /^\/v1\/procedures\/([^/]+)\/approve$/,
    need: "admin",
    handler: (_request, env, _scope, _ctx, match) => handleApproveProcedure(env, match[1]),
  },
  {
    method: "GET",
    re: /^\/v1\/procedures$/,
    need: "read",
    handler: (_request, env) => handleListProcedures(env),
  },
  {
    method: "GET",
    re: /^\/v1\/procedures\/([^/]+)$/,
    need: "read",
    handler: (_request, env, _scope, _ctx, match) => handleGetProcedure(env, match[1]),
  },
  {
    method: "POST",
    re: /^\/v1\/connectors\/github\/sync$/,
    need: "admin",
    handler: (request, env) => handleGithubSync(request, env),
  },
  {
    method: "GET",
    re: /^\/v1\/reflections\/latest$/,
    need: "read",
    handler: (_request, env) => handleReflectionsLatest(env),
  },
  {
    method: "POST",
    re: /^\/v1\/reflect$/,
    need: "admin",
    handler: (request, env) => handleReflect(request, env),
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

export type CronJob = "sweep" | "consolidation" | "reflection_week" | "reflection_month";

/** Map a configured trigger string to its job. Unknown strings (e.g. a cron
 *  edited in the dashboard) log and no-op instead of running the wrong work. */
export function routeCron(cron: string): CronJob | null {
  switch (cron) {
    case "*/30 * * * *":
      return "sweep";
    case "0 3 * * *":
      return "consolidation";
    case "0 4 * * 1":
      return "reflection_week";
    case "0 4 1 * *":
      return "reflection_month";
    default:
      return null;
  }
}

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

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job = routeCron(controller.cron);
    ctx.waitUntil(
      (async () => {
        try {
          switch (job) {
            case "sweep":
              await runSweep(env);
              break;
            case "consolidation":
              await runConsolidation(env);
              break;
            case "reflection_week":
              await runReflection(env, { period: "week" });
              break;
            case "reflection_month":
              await runReflection(env, { period: "month" });
              break;
            default:
              console.log(`[cron] unknown trigger: ${controller.cron}`);
              break;
          }
        } catch (err) {
          // A cron must never die silently: log and let the next tick retry.
          console.log(`[cron] ${controller.cron} failed: ${String(err)}`);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
