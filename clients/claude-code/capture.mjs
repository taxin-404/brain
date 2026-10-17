#!/usr/bin/env node
/** Claude Code SessionEnd hook → brain capture.
 *
 *  Claude Code runs this command on the SessionEnd event with a JSON blob on
 *  stdin containing at least `session_id` and `transcript_path` (the path of a
 *  JSONL transcript, one message record per line). This script maps the
 *  records the same way the OpenCode plugin does — payload shapes and kind
 *  names come from `plugin/src/capture.ts`, and `source` is `"file"`, the
 *  value `src/ingest.ts` reserves for transcript-fed ingestion — then POSTs
 *  bare JSON arrays to `/v1/events/batch` (the plugin's exact body shape).
 *
 *  Contract (fail-open): this hook NEVER exits nonzero. A broken config or
 *  unreadable transcript must not break the session; it only reports to
 *  stderr and stops. Payload text is never echoed — stderr carries counts
 *  and HTTP statuses only.
 *
 *  Config:
 *    BRAIN_ENDPOINT       worker base URL, e.g. https://brain-api.<you>.workers.dev
 *    BRAIN_PROPOSE_TOKEN  an MCP_PROPOSE-scoped token (capture scope)
 *  Flags (override env / stdin):
 *    --transcript <path>  read that file instead of stdin's transcript_path
 *    --session-id <id>    session id override when posting manually
 *    --endpoint <url>     BRAIN_ENDPOINT override
 *    --token <tok>        BRAIN_PROPOSE_TOKEN override (avoid; leaks to ps)
 *    --dry-run            print the mapped events to stdout, POST nothing
 *    --limit <n>          cap total events (default 5000)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TRUNCATION_SUFFIX = "…[truncated]";
const DEFAULT_MAX_STRING = 65_536;
const BATCH_LIMIT = 450; // server accepts 500; leave headroom
const OVERALL_LIMIT = 5_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Recursively truncate every string deeper than `max` characters, appending the suffix. Mirrors plugin/src/capture.ts. */
export function truncateStrings(value, max = DEFAULT_MAX_STRING) {
  if (typeof value === "string") {
    return value.length > max ? value.slice(0, max) + TRUNCATION_SUFFIX : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateStrings(item, max));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, truncateStrings(inner, max)]),
    );
  }
  return value;
}

function djb2(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, "0");
}

/** Timestamps in transcripts are ISO strings; normalize to epoch millis. */
export function toMillis(ts, now = Date.now) {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts < 1e12 ? ts * 1000 : ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now();
}

function safeId(base, suffix) {
  const candidate = `cc_${base}${suffix}`.replace(/[^A-Za-z0-9_-]/g, "");
  const bounded = candidate === "cc_" ? "cc_" : candidate.slice(0, 64);
  return ID_RE.test(bounded) ? bounded : `cc_l${suffix || djb2(String(base))}`;
}

/** Extract joined text from a message content field (string or content-part array). */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return truncateStrings(content);
  if (Array.isArray(content)) {
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    return text === "" ? null : truncateStrings(text);
  }
  return null;
}

/** Map raw transcript lines to brain events. Pure; no I/O. */
export function linesToEvents(sessionId, lines, opts = {}) {
  const now = opts.now ?? Date.now;
  const limit = opts.limit ?? OVERALL_LIMIT;
  const events = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (events.length >= limit) break;
    const raw = lines[index].trim();
    if (raw === "") continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // stray JSONL line — skip, never fail
    }
    const type = typeof line?.type === "string" ? line.type : null;
    if (type !== "user" && type !== "assistant") continue; // summary/meta lines
    const message = typeof line?.message === "object" && line.message !== null ? line.message : null;
    if (message === null) continue;

    const uuid = typeof line.uuid === "string" && line.uuid.length > 0
      ? line.uuid
      : djb2(`${index}:${raw.length}:${raw.slice(0, 256)}`);
    const ts = toMillis(line.timestamp, now);
    const base = { ts, source: "file", session_id: sessionId ?? null };

    if (type === "user") {
      const text = messageText(message);
      if (text !== null && text !== "") {
        events.push({ ...base, id: safeId(uuid, ""), actor: "user", kind: "message", payload: { text } });
      }
      continue;
    }

    // assistant: joined text parts → one message event; tool_use parts → tool_call events
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text !== "") {
      events.push({ ...base, id: safeId(uuid, ""), actor: "assistant", kind: "message", payload: { text: truncateStrings(text) } });
    }
    content.forEach((part, partIndex) => {
      if (part?.type !== "tool_use") return;
      if (events.length >= limit) return;
      events.push({
        ...base,
        id: safeId(uuid, `_t${partIndex}`),
        actor: "tool",
        kind: "tool_call",
        payload: { tool: truncateStrings(part.name), call_id: truncateStrings(part.id), input: truncateStrings(part.input) },
      });
    });
  }
  return events;
}

function readStdinJson() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function expandHome(path) {
  if (typeof path !== "string") return null;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
  return path;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const flagOn = (name) => argv.includes(name);

  const hookJson = flagOn("--transcript") ? "{}" : JSON.parse(await readStdinJson() || "{}");
  const transcriptPath = expandHome(flag("--transcript") ?? hookJson?.transcript_path);
  const sessionId = flag("--session-id") ?? (typeof hookJson?.session_id === "string" ? hookJson.session_id : null);
  const endpoint = (flag("--endpoint") ?? process.env.BRAIN_ENDPOINT ?? "").replace(/\/+$/, "");
  const token = flag("--token") ?? process.env.BRAIN_PROPOSE_TOKEN ?? "";

  if (!transcriptPath) {
    process.stderr.write("brain-capture: no transcript_path (stdin hook JSON empty or unsupported) — nothing to do\n");
    return;
  }
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n");
  } catch (error) {
    process.stderr.write(`brain-capture: transcript unreadable: ${error?.code ?? "error"}\n`);
    return;
  }

  const events = linesToEvents(sessionId, lines, {});
  if (events.length === 0) {
    process.stderr.write("brain-capture: no user/assistant records found in transcript\n");
    return;
  }

  if (flagOn("--dry-run")) {
    process.stdout.write(`${JSON.stringify(events, null, 2)}\n`);
    return;
  }

  if (endpoint === "" || token === "") {
    process.stderr.write("brain-capture: config missing — set BRAIN_ENDPOINT and BRAIN_PROPOSE_TOKEN\n");
    return;
  }

  let stored = 0;
  let duplicates = 0;
  for (let start = 0; start < events.length; start += BATCH_LIMIT) {
    const chunk = events.slice(start, start + BATCH_LIMIT);
    try {
      const response = await fetch(`${endpoint}/v1/events/batch`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(chunk),
      });
      if (!response.ok) {
        process.stderr.write(`brain-capture: HTTP ${response.status} on batch ${Math.floor(start / BATCH_LIMIT) + 1} — ${response.statusText}\n`);
        continue;
      }
      const body = await response.json().catch(() => ({}));
      stored += body.stored ?? 0;
      duplicates += chunk.length - (body.stored ?? 0);
    } catch (error) {
      process.stderr.write(`brain-capture: fetch failed (${error?.cause?.code ?? error?.message ?? "network"})\n`);
      continue;
    }
  }
  process.stderr.write(`brain-capture: ${events.length} events — ${stored} stored, ${duplicates} duplicate\n`);
}

/* Run only when invoked as a script; imports (tests) get pure functions only. */
function isMain() {
  try {
    const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
    return invoked !== "" && invoked === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) {
  await main().catch(() => {});
  process.exitCode = 0;
}
