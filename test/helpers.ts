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

/** Deterministic pseudo-embedding for tests (unit-length, seeded by the text):
 *  identical texts produce identical vectors, so a fake index can rank by
 *  cosine without a real model. */
export function fakeVec(text: string, dims = 768): number[] {
  let h = 2166136261;
  const out: number[] = new Array(dims);
  for (let i = 0; i < dims; i += 1) {
    h ^= text.charCodeAt(i % (text.length || 1));
    h = Math.imul(h, 16777619) >>> 0;
    out[i] = (h / 0xffffffff) * 2 - 1;
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}
