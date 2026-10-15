import { exports } from "cloudflare:workers";
import type { Env as BrainEnv, Scope } from "../src/env";

// workers-types v5: `env` is typed `Cloudflare.Env` and `exports` derives from
// `Cloudflare.GlobalProps.mainModule`; augment both globally (plan said
// ProvidedEnv, which does not exist in v5 — see ledger ruling).
declare global {
  namespace Cloudflare {
    interface Env extends BrainEnv {
      TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}

export function bearer(env: BrainEnv, scope: Scope): Record<string, string> {
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
