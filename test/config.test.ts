import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import handler from "../src/index";
import { bearer, call, setEnvVars } from "./helpers";

// The deploy-time secret gate (`secrets.required`) was removed on 2026-10-17:
// deploys always go green, and the worker reports what is missing itself. Until
// PAYLOAD_KEK + ADMIN_TOKEN exist it answers 503 `not configured` naming them —
// readable with no credentials, which is the whole discovery mechanism.
describe("unconfigured worker (no deploy-time secret gate)", () => {
  it("answers 503 listing the missing secrets — readable with no credentials", async () => {
    const original = { PAYLOAD_KEK: env.PAYLOAD_KEK, ADMIN_TOKEN: env.ADMIN_TOKEN };
    try {
      setEnvVars({ PAYLOAD_KEK: undefined, ADMIN_TOKEN: undefined });
      const res = await call("GET", "/v1/health-report");
      expect(res.status).toBe(503);
      const body = await res.json<{ error: string; missing: string[]; hint: string }>();
      expect(body.error).toBe("not configured");
      expect(body.missing).toEqual(["PAYLOAD_KEK", "ADMIN_TOKEN"]);
      expect(body.hint).toContain("Variables and Secrets");
      // every route is gated — public shells and stale bearers included
      expect((await call("GET", "/inspector")).status).toBe(503);
      expect((await call("GET", "/v1/health-report", undefined, { authorization: "Bearer whatever" })).status).toBe(503);
    } finally {
      setEnvVars(original);
    }
  });

  it("counts empty strings as missing and lists only what is absent", async () => {
    const original = { PAYLOAD_KEK: env.PAYLOAD_KEK, ADMIN_TOKEN: env.ADMIN_TOKEN };
    try {
      setEnvVars({ PAYLOAD_KEK: "kek-now-set", ADMIN_TOKEN: "" });
      const body = await (await call("GET", "/v1/health-report")).json<{ missing: string[] }>();
      expect(body.missing).toEqual(["ADMIN_TOKEN"]);
      setEnvVars({ PAYLOAD_KEK: undefined });
      const body2 = await (await call("GET", "/v1/health-report")).json<{ missing: string[] }>();
      expect(body2.missing).toEqual(["PAYLOAD_KEK", "ADMIN_TOKEN"]);
    } finally {
      setEnvVars(original);
    }
  });

  it("AI key is a note, not a gate — and its absence does not block routes", async () => {
    const original = { GEMINI_API_KEY: env.GEMINI_API_KEY };
    try {
      setEnvVars({ GEMINI_API_KEY: undefined });
      expect((await call("GET", "/v1/health-report", undefined, bearer(env, "ADMIN"))).status).toBe(200);
      // while unconfigured, the hint mentions the AI key separately
      setEnvVars({ PAYLOAD_KEK: undefined });
      const body = await (await call("GET", "/v1/health-report")).json<{ missing: string[]; hint: string }>();
      expect(body.missing).toEqual(["PAYLOAD_KEK"]);
      expect(body.hint).toContain("GEMINI_API_KEY");
    } finally {
      setEnvVars(original);
    }
  });

  it("crons skip quietly while unconfigured", async () => {
    const original = { PAYLOAD_KEK: env.PAYLOAD_KEK, ADMIN_TOKEN: env.ADMIN_TOKEN };
    try {
      setEnvVars({ PAYLOAD_KEK: undefined, ADMIN_TOKEN: undefined });
      const pending: Array<Promise<unknown>> = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
      await handler.scheduled!({ cron: "*/30 * * * *" } as ScheduledController, env, ctx);
      await Promise.all(pending);
    } finally {
      setEnvVars(original);
    }
  });
});
