import { describe, expect, it } from "vitest";
import { linesToEvents, toMillis, truncateStrings } from "../clients/claude-code/capture.mjs";

const iso = "2026-10-17T10:00:00.000Z";
const sess = "claude-session-1";

const USER_LINE = JSON.stringify({
  type: "user",
  uuid: "11111111-2222-3333-4444-555555555555",
  timestamp: iso,
  message: { role: "user", content: [{ type: "text", text: " always deploy with tb/ prefix" }] },
});
const ASSISTANT_LINE = JSON.stringify({
  type: "assistant",
  uuid: "99999999-8888-7777-6666-555555555555",
  timestamp: iso,
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "On it." },
      { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } },
    ],
  },
});

describe("claude-code capture shim (clients/claude-code)", () => {
  it("maps user text, assistant text, and tool_use to the ingest contract", () => {
    const events = linesToEvents(sess, [USER_LINE, ASSISTANT_LINE]);
    expect(events).toHaveLength(3);

    const user = events[0];
    expect(user).toMatchObject({
      id: "cc_11111111-2222-3333-4444-555555555555",
      source: "file",
      actor: "user",
      kind: "message",
      session_id: sess,
      payload: { text: "always deploy with tb/ prefix" },
    });
    expect(user!.ts).toBe(Date.parse(iso));

    const tool = events.at(-1)!;
    expect(tool).toMatchObject({
      id: "cc_99999999-8888-7777-6666-555555555555_t1",
      actor: "tool",
      kind: "tool_call",
      payload: { tool: "Bash", call_id: "toolu_01", input: { command: "ls" } },
    });
    for (const e of events) expect(e.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("skips summary/meta/malformed lines without failing", () => {
    const events = linesToEvents(sess, ["", "not json", JSON.stringify({ type: "summary", uuid: "s" }), USER_LINE]);
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe("user");
  });

  it("produces stable dedupe-safe ids (re-run → same ids)", () => {
    const a = linesToEvents(sess, [USER_LINE, ASSISTANT_LINE]);
    const b = linesToEvents(sess, [USER_LINE, ASSISTANT_LINE]);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });

  it("falls back to a stable synthetic id when uuid is missing", () => {
    const bare = JSON.stringify({ type: "user", timestamp: iso, message: { role: "user", content: "plain string content" } });
    const events = linesToEvents(sess, [bare]);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toMatch(/^cc_[A-Za-z0-9_-]{1,64}$/);
    expect(events[0]!.payload).toEqual({ text: "plain string content" });
  });

  it("respects the overall event cap", () => {
    const line = JSON.stringify({
      type: "user",
      uuid: "ffffffff-0000-0000-0000-00000000000a",
      timestamp: iso,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    expect(linesToEvents(sess, [line, line, line], { limit: 2 })).toHaveLength(2);
  });

  it("normalizes ISO and epoch-second timestamps, falls back to now", () => {
    const now = () => 5_000_000_000_000;
    expect(toMillis(iso, now)).toBe(Date.parse(iso));
    expect(toMillis(1_700_000_000, now)).toBe(1_700_000_000_000);
    expect(toMillis(undefined, now)).toBe(5_000_000_000_000);
  });

  it("truncateStrings mirrors the plugin (nested strings + suffix)", () => {
    expect(truncateStrings("x".repeat(65_537))).toBe("x".repeat(65_536) + "…[truncated]");
    expect(truncateStrings({ a: ["y".repeat(65_537)] })).toEqual({ a: ["y".repeat(65_536) + "…[truncated]"] });
    expect(truncateStrings({ a: 1 })).toEqual({ a: 1 });
  });
});
