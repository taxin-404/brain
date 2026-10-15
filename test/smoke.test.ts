import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const vec = (a: number, b: number) => {
  const v = new Array<number>(768).fill(0);
  v[0] = a;
  v[1] = b;
  return v;
};

describe("router", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await exports.default.fetch("https://brain.test/nope");
    expect(res.status).toBe(404);
  });
});

// Miniflare has no local Vectorize simulation ("Binding VECTORIZE needs to be
// run remotely"), so tests install an in-memory fake through the env proxy —
// the seam every vector-touching test uses. The real binding is only exercised
// at live acceptance (single-shot).
describe("vectorize test seam", () => {
  it("routes env.VECTORIZE calls to an installed in-memory fake", async () => {
    const inserted: Array<{ id: string; values: number[] }> = [];
    const fake = {
      insert: async (vectors: Array<{ id: string; values: number[] }>) => {
        inserted.push(...vectors);
        return { mutationId: "m1" };
      },
      query: async (_v: number[], _o: unknown) => ({ matches: [{ id: "v1", score: 1 }] }),
    };
    (env as unknown as Record<string, unknown>).VECTORIZE = fake as unknown as VectorizeIndex;
    await env.VECTORIZE.insert([{ id: "v1", values: vec(1, 0) }]);
    const res = await env.VECTORIZE.query(vec(1, 0), { topK: 1 });
    expect(inserted.map((v) => v.id)).toEqual(["v1"]);
    expect(res.matches[0]?.id).toBe("v1");
  });
});
