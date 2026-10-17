import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { dayKey } from "../src/budget";
import { bearer, call, setEnvVars } from "./helpers";

describe("auth + health", () => {
  it("rejects missing and unknown tokens with 401", async () => {
    expect((await call("GET", "/v1/health-report")).status).toBe(401);
    expect((await call("GET", "/v1/health-report", undefined, { authorization: "Bearer nope" })).status).toBe(401);
  });

  it("never matches Bearer tokens against unset or empty secrets", async () => {
    const original = {
      ADMIN_TOKEN: env.ADMIN_TOKEN,
      MCP_PROPOSE_TOKEN: env.MCP_PROPOSE_TOKEN,
      MCP_READ_TOKEN: env.MCP_READ_TOKEN,
    };
    try {
      setEnvVars({ ADMIN_TOKEN: undefined, MCP_PROPOSE_TOKEN: undefined, MCP_READ_TOKEN: undefined });
      // `Bearer undefined` is not a credential — no token set means no access.
      expect((await call("GET", "/v1/health-report", undefined, { authorization: "Bearer undefined" })).status).toBe(401);
      // An empty-string secret must not match `Bearer ` either.
      setEnvVars({ MCP_READ_TOKEN: "" });
      expect((await call("GET", "/v1/health-report", undefined, { authorization: "Bearer " })).status).toBe(401);
    } finally {
      setEnvVars(original);
    }
  });

  it("rejects insufficient scope with 403 (strict: propose is not read)", async () => {
    expect((await call("GET", "/v1/health-report", undefined, bearer(env, "MCP_PROPOSE"))).status).toBe(403);
  });

  it("minimal setups: with the scoped tokens unset, the admin token is the credential", async () => {
    const original = { MCP_READ_TOKEN: env.MCP_READ_TOKEN, MCP_PROPOSE_TOKEN: env.MCP_PROPOSE_TOKEN };
    try {
      setEnvVars({ MCP_READ_TOKEN: undefined, MCP_PROPOSE_TOKEN: undefined });
      expect((await call("GET", "/v1/health-report", undefined, bearer(env, "ADMIN"))).status).toBe(200);
      // the old hazard must stay closed in this mode too
      expect((await call("GET", "/v1/health-report", undefined, { authorization: "Bearer undefined" })).status).toBe(401);
    } finally {
      setEnvVars(original);
    }
  });

  it("returns the health report shape with live counts", async () => {
    await env.BRAIN_DB.prepare(
      `INSERT INTO events (id, ts, ingested_at, source, actor, trust, kind, excerpt, content_hmac)
       VALUES ('h1', 1, 1, 'manual', 'user', 1.0, 'note', 'x', 'hh1')`,
    ).run();
    await env.BRAIN_DB.prepare(
      `INSERT INTO rate_budgets (scope, day, rows_written) VALUES ('__global__', ?1, 70000)`,
    )
      .bind(dayKey(Date.now()))
      .run();
    const res = await call("GET", "/v1/health-report", undefined, bearer(env, "MCP_READ"));
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ events: 1, budget: { used: 70000, warn: true, breaker: false }, purges: 0, pending_proposals: 0 });
    expect((await call("GET", "/v1/health-report", undefined, bearer(env, "ADMIN"))).status).toBe(200);
  });
});
