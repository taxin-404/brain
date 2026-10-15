import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { EventInput } from "../src/ingest";
import { bearer, call } from "./helpers";

const seed = (over: Partial<EventInput>) =>
  call("POST", "/v1/events", { source: "manual", actor: "user", kind: "note", ...over }, bearer(env, "MCP_PROPOSE"));
const search = (qs: string, scope: "MCP_READ" | "ADMIN" = "MCP_READ") => call("GET", `/v1/search${qs}`, undefined, bearer(env, scope));

describe("search", () => {
  it("returns keyword hits and excludes restricted for read scope", async () => {
    await seed({ session_id: "sq-1", payload: { text: "kubernetes rollout plan" } });
    await seed({ session_id: "sq-2", privacy: "restricted", payload: { text: "kubernetes restricted detail" } });
    const res = await search("?q=kubernetes");
    expect(res.status).toBe(200);
    const body = await res.json<{ results: Array<{ excerpt: string }> }>();
    expect(body.results.some((r) => r.excerpt.includes("rollout plan"))).toBe(true);
    expect(body.results.some((r) => r.excerpt.includes("restricted detail"))).toBe(false);
    expect((await search("?q=kubernetes&include_restricted=true")).status).toBe(403);
    const admin = await search("?q=kubernetes&include_restricted=true", "ADMIN");
    expect((await admin.json<{ results: unknown[] }>()).results.length).toBeGreaterThanOrEqual(2);
  });

  it("never returns purged events", async () => {
    const id = (await (await seed({ session_id: "sq-3", payload: { text: "vanishterm unique" } })).json<{ results: Array<{ id: string }> }>()).results[0].id;
    const token = (await (await call("POST", "/v1/confirm/token", { target: `event:${id}` }, bearer(env, "ADMIN"))).json<{ token: string }>()).token;
    await call("POST", `/v1/events/${id}/purge`, { confirm_token: token, reason: "t" }, bearer(env, "ADMIN"));
    const body = await (await search("?q=vanishterm")).json<{ results: unknown[] }>();
    expect(body.results).toEqual([]);
  });

  it("sanitizes FTS metacharacters and validates input", async () => {
    expect((await search("")).status).toBe(400);
    expect((await search('?q=kube" OR x=1')).status).toBe(200);
    expect((await call("GET", "/v1/search?q=x")).status).toBe(401);
  });
});
