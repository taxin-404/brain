### Task 4: Secret redaction

**Files:**
- Create: `src/redact.ts`, `test/redact.test.ts`

**Interfaces:**
- Produces: `redactText(text: string): { text: string; found: boolean }`; `redactPayload(payload: unknown): { redacted: string; sensitive: boolean }` (deep-walks JSON, applies `redactText` to every string, returns canonical `JSON.stringify` of the sanitized value); `buildExcerpt(redacted: string): string` (first 500 chars).

- [ ] **Step 1: Write the failing redaction test** — `test/redact.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it, verify it fails** → `npx vitest run test/redact.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/redact.ts`**

Pinned detection rules (replace with `[REDACTED]`): AWS `\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`; GitHub `\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b`; `\bsk-[A-Za-z0-9-]{16,}\b`; Slack `\bxox[baprs]-[A-Za-z0-9-]+\b`; Google `\bAIza[0-9A-Za-z_\-]{20,}\b`; PEM `-----BEGIN [A-Z ]*PRIVATE KEY-----`; generic key/value `(?i)(password|passwd|secret|api[_-]?key|token)("?\s*[:=]\s*)("?)([^"\s,}]+)` — replace only the value (group 4). If any rule matched, `found = true`.

- [ ] **Step 4: Run it, verify it passes** → PASS (3 tests). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: secret redaction for payloads and excerpts"
```

---

