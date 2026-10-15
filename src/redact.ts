export function redactText(input: string): { text: string; found: boolean } {
  let found = false;
  let text = input;
  const scrub = (re: RegExp, replacement: string) => {
    text = text.replace(re, () => {
      found = true;
      return replacement;
    });
  };
  scrub(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]");
  scrub(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]");
  scrub(/\bsk-[A-Za-z0-9-]{16,}\b/g, "[REDACTED]");
  scrub(/\bxox[baprs]-[A-Za-z0-9-]+\b/g, "[REDACTED]");
  scrub(/\bAIza[0-9A-Za-z_\-]{20,}\b/g, "[REDACTED]");
  scrub(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]");
  // Generic labeled key/value: replace only the value, keep the label.
  text = text.replace(
    /(password|passwd|secret|api[_-]?key|token)("?\s*[:=]\s*)("?)([^"\s,}]+)/gi,
    (_m, label: string, sep: string, quote: string) => {
      found = true;
      return `${label}${sep}${quote}[REDACTED]`;
    },
  );
  return { text, found };
}

// JSON keys that mark their value as a secret (checked as substring so
// db_password / auth_token / apiKey all match).
const SENSITIVE_KEY = /(password|passwd|secret|api[_-]?key|token)/i;

export function redactPayload(payload: unknown): { redacted: string; sensitive: boolean } {
  let sensitive = false;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const r = redactText(value);
      if (r.found) sensitive = true;
      return r.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => {
          if (SENSITIVE_KEY.test(k)) {
            sensitive = true;
            return [k, "[REDACTED]"];
          }
          return [k, walk(v)];
        }),
      );
    }
    return value;
  };
  return { redacted: JSON.stringify(walk(payload)), sensitive };
}

export function buildExcerpt(redacted: string): string {
  return redacted.slice(0, 500);
}
