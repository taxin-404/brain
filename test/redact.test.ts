import { describe, expect, it } from "vitest";
import { buildExcerpt, redactPayload } from "../src/redact";

const RAW = {
  text: "use AKIA1234567890ABCDEF for aws, ghp_abcdefghijklmnopqrstuv12345678 for github",
  config: { password: "hunter2-secret", note: ["sk-ant-api03-abcdefghijklmnopqrstuv", "harmless"] },
};

describe("redaction", () => {
  it("removes planted secrets everywhere and flags sensitive", () => {
    const { redacted, sensitive } = redactPayload(RAW);
    expect(sensitive).toBe(true);
    for (const secret of ["AKIA1234567890ABCDEF", "ghp_abcdefghijklmnopqrstuv12345678", "hunter2-secret", "sk-ant-api03-abcdefghijklmnopqrstuv"])
      expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[REDACTED]");
  });

  it("passes clean payloads through unchanged", () => {
    const clean = { text: "prefers dark mode", n: 3 };
    const { redacted, sensitive } = redactPayload(clean);
    expect(sensitive).toBe(false);
    expect(redacted).toBe(JSON.stringify(clean));
  });

  it("truncates excerpts to 500 chars", () => {
    expect(buildExcerpt("x".repeat(600))).toHaveLength(500);
  });
});
