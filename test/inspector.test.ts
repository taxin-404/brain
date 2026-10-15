import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call } from "./helpers";

describe("inspector", () => {
  it("serves the self-contained shell with security headers and zero brain data", async () => {
    const res = await call("GET", "/inspector");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    // Hardening: API-only page, no referrer leakage, scripts inline by design.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");

    const html = await res.text();
    expect(html).toContain("sessionStorage");
    for (const route of ["/v1/health-report", "/v1/search", "/v1/procedures", "/v1/reflections/latest"]) {
      expect(html).toContain(route);
    }
    // The shell carries no secrets and no brain content.
    expect(html).not.toContain(env.ADMIN_TOKEN);
    expect(html).not.toContain(env.MCP_READ_TOKEN);
    expect(html).not.toContain(env.MCP_PROPOSE_TOKEN);
  });
});
