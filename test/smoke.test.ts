import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("router", () => {
  it("returns 404 for unknown routes", async () => {
    const res = await exports.default.fetch("https://brain.test/nope");
    expect(res.status).toBe(404);
  });
});
