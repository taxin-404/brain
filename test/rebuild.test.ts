import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rebuildProjections } from "../src/rebuild";
import { bearer, call } from "./helpers";

// Shared-state adaptation (no per-test isolation): seedWithPurge takes a tag so
// each test gets its own sessions and unique FTS terms.

const post = (body: unknown) => call("POST", "/v1/events", body, bearer(env, "MCP_PROPOSE"));
const match = async (term: string) =>
  (await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH ?1`).bind(`"${term}"`).first<{ n: number }>())!.n;

async function seedWithPurge(tag: string) {
  const keep = (await (await post({ source: "manual", actor: "user", kind: "note", session_id: `rb-${tag}-1`, payload: { text: `keepalpha${tag} term` } })).json<{ results: Array<{ id: string }> }>()).results[0].id;
  const gone = (await (await post({ source: "manual", actor: "user", kind: "note", session_id: `rb-${tag}-2`, payload: { text: `gonebeta${tag} term` } })).json<{ results: Array<{ id: string }> }>()).results[0].id;
  const token = (await (await call("POST", "/v1/confirm/token", { target: `event:${gone}` }, bearer(env, "ADMIN"))).json<{ token: string }>()).token;
  await call("POST", `/v1/events/${gone}/purge`, { confirm_token: token, reason: "rb test" }, bearer(env, "ADMIN"));
  return { keep, gone };
}

describe("rebuild", () => {
  it("honors purge tombstones: purged text must not resurrect", async () => {
    await seedWithPurge("one");
    expect(await match("gonebetaone")).toBe(0);
    const { fts_rows } = await rebuildProjections(env);
    expect(await match("keepalphaone")).toBe(1);
    expect(await match("gonebetaone")).toBe(0);            // Review Focus 4
    const total = (await env.BRAIN_DB.prepare(`SELECT count(*) AS n FROM events`).first<{ n: number }>())!.n;
    expect(fts_rows).toBe(total);                          // every row re-derived, redacted ones empty
  });

  it("is idempotent and equals the live projection", async () => {
    await seedWithPurge("two");
    const first = await rebuildProjections(env);
    const second = await rebuildProjections(env);
    expect(second).toEqual(first);
    expect(await match("keepalphatwo")).toBe(1);
    expect(await match("gonebetatwo")).toBe(0);
  });
});
