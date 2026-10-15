import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import pairs from "../eval/keyword.json";
import { searchEvents } from "../src/search";
import type { EventInput } from "../src/ingest";
import { bearer, call } from "./helpers";

describe("keyword eval", () => {
  it("keeps recall@5 at or above the regression gate", async () => {
    for (const [i, p] of pairs.entries()) {
      const res = await call(
        "POST",
        "/v1/events",
        {
          source: "manual",
          actor: "user",
          kind: "note",
          session_id: `eval-${i}`,
          payload: { text: p.doc },
        } as EventInput,
        bearer(env, "MCP_PROPOSE"),
      );
      expect(res.status).toBe(201);
    }
    let hits = 0;
    for (const p of pairs) {
      const results = await searchEvents(env, p.q, 5, { includeRestricted: false });
      if (results.some((r) => r.excerpt.includes(p.expect))) hits++;
    }
    console.log(`recall@5: ${hits}/${pairs.length}`);
    expect(hits / pairs.length).toBeGreaterThanOrEqual(0.9);
  });
});
