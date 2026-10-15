import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bearer, call, installFakeVectorize } from "./helpers";
import { network } from "./server";

const GH = "https://api.github.com/repos";

const COMMITS = [
  {
    sha: "1111111111111111111111111111111111111111",
    html_url: "https://github.com/taxin-404/brain/commit/1111111111111111111111111111111111111111",
    commit: {
      message: "feat: add the connector\n\nlonger body here",
      author: { name: "taxin", date: "2026-10-15T12:00:00Z" },
    },
  },
  {
    sha: "2222222222222222222222222222222222222222",
    html_url: "https://github.com/taxin-404/brain/commit/2222222222222222222222222222222222222222",
    commit: { message: "fix: tighten the gate", author: { name: "taxin", date: "2026-10-15T13:00:00Z" } },
  },
];

const sync = (body: unknown) => call("POST", "/v1/connectors/github/sync", body, bearer(env, "ADMIN"));

describe("github connector", () => {
  beforeAll(async () => {
    await network.enable();
  });
  beforeEach(() => {
    installFakeVectorize();
    network.use(http.get(`${GH}/taxin-404/brain/commits`, () => HttpResponse.json(COMMITS)));
  });
  afterEach(() => {
    network.resetHandlers();
  });
  afterAll(async () => {
    await network.disable();
  });

  it("maps commits to external events and is idempotent on re-sync", async () => {
    const res = await sync({ repos: ["taxin-404/brain"], lookback_hours: 24 });
    expect(res.status).toBe(200);
    const body = await res.json<{ results: Array<{ repo: string; fetched: number; stored: number; duplicates: number }> }>();
    expect(body.results[0]).toMatchObject({ repo: "taxin-404/brain", fetched: 2, stored: 2, duplicates: 0 });

    const row = await env.BRAIN_DB.prepare(
      `SELECT id, source, actor, trust, session_id, kind, excerpt FROM events WHERE id = ?1`,
    )
      .bind("gh-taxin-404-brain-c-111111111111")
      .first<{ id: string; source: string; actor: string; trust: number; session_id: string; kind: string; excerpt: string }>();
    expect(row).toMatchObject({
      source: "github",
      actor: "external", // third-party surface: never user_stated material
      trust: 0.4,
      session_id: "gh:taxin-404/brain",
      kind: "note",
    });
    expect(row?.excerpt).toContain("taxin-404/brain: feat: add the connector");

    const again = await sync({ repos: ["taxin-404/brain"] });
    const againBody = await again.json<{ results: Array<{ stored: number; duplicates: number }> }>();
    expect(againBody.results[0]).toMatchObject({ fetched: 2, stored: 0, duplicates: 2 });
  });

  it("isolates per-repo errors and 502s only when everything failed", async () => {
    network.use(http.get(`${GH}/taxin-404/private-repo/commits`, () => new HttpResponse(null, { status: 404 })));
    const mixed = await sync({ repos: ["taxin-404/brain", "taxin-404/private-repo"] });
    expect(mixed.status).toBe(200);
    const mixedBody = await mixed.json<{ results: Array<{ repo: string; error?: string }> }>();
    expect(mixedBody.results[0].error).toBeUndefined();
    expect(mixedBody.results[1].error).toContain("404");

    const allFail = await sync({ repos: ["taxin-404/private-repo"] });
    expect(allFail.status).toBe(502);
  });

  it("validates the request body and stays admin-only", async () => {
    for (const bad of [
      {},
      { repos: [] },
      { repos: ["not a repo"] },
      { repos: Array.from({ length: 11 }, (_, i) => `a/b${i}`) },
      { repos: ["a/b"], lookback_hours: 9999 },
      { repos: ["a/b"], max_per_repo: 51 },
      { repos: ["a/b"], max_per_repo: 0 },
    ]) {
      expect((await sync(bad)).status).toBe(400);
    }
    expect(
      (await call("POST", "/v1/connectors/github/sync", { repos: ["a/b"] }, bearer(env, "MCP_READ"))).status,
    ).toBe(403);
    expect(
      (await call("POST", "/v1/connectors/github/sync", { repos: ["a/b"] }, bearer(env, "MCP_PROPOSE"))).status,
    ).toBe(403);
  });
});
