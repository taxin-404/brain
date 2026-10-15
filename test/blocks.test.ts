import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bearer, call } from "./helpers";

describe("blocks", () => {
  it("enforces scopes and the key whitelist", async () => {
    expect((await call("GET", "/v1/blocks")).status).toBe(401);
    expect((await call("PUT", "/v1/blocks/identity", { value: "x" }, bearer(env, "MCP_READ"))).status).toBe(403);
    expect((await call("PUT", "/v1/blocks/foo", { value: "x" }, bearer(env, "ADMIN"))).status).toBe(400);
    expect((await call("PUT", "/v1/blocks/identity", { value: "" }, bearer(env, "ADMIN"))).status).toBe(400);
  });

  it("upserts with ADMIN and audits the write", async () => {
    expect((await call("PUT", "/v1/blocks/objective", { value: "ship phase 1" }, bearer(env, "ADMIN"))).status).toBe(200);
    await call("PUT", "/v1/blocks/objective", { value: "ship phase 1 and 2" }, bearer(env, "ADMIN"));
    const body = await (await call("GET", "/v1/blocks", undefined, bearer(env, "MCP_READ"))).json<{ blocks: Array<{ key: string; value: string }> }>();
    expect(body.blocks).toEqual([expect.objectContaining({ key: "objective", value: "ship phase 1 and 2" })]);
    const { results } = await env.BRAIN_DB.prepare(`SELECT action FROM audit_log WHERE target_id = 'objective' ORDER BY ts`).all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual(["create", "correct"]);
  });
});
