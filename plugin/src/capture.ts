export interface CaptureEvent {
  id: string;
  ts: number;
  source: "opencode";
  actor: "user" | "assistant" | "tool";
  kind: "message" | "tool_call";
  session_id: string;
  payload: unknown;
}

export type SessionMessageLike =
  | { type: "user"; id: string; time: { created: number }; text: string }
  | {
      type: "assistant";
      id: string;
      time: { created: number };
      content: Array<{ type: "text"; text: string } | { type: "tool"; id: string; name: string; state?: unknown }>;
      agent?: unknown;
      model?: unknown;
    }
  | {
      type: "shell";
      id: string;
      time: { created: number };
      command: string;
      status?: string;
      exit?: number | string;
      output?: { output?: string };
    }
  | { type: string };

const TRUNCATION_SUFFIX = "…[truncated]";
const DEFAULT_MAX_STRING = 65_536;
const MILLIS_CUTOFF = 1e12;

/** Recursively truncate every string deeper than `max` characters, appending "…[truncated]". */
export function truncateStrings(value: unknown, max: number = DEFAULT_MAX_STRING): unknown {
  if (typeof value === "string") {
    return value.length > max ? value.slice(0, max) + TRUNCATION_SUFFIX : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateStrings(item, max));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, truncateStrings(inner, max)]),
    );
  }
  return value;
}

const toMillis = (created: number | undefined): number =>
  typeof created !== "number" ? Date.now() : created < MILLIS_CUTOFF ? created * 1000 : created;

/** Map OpenCode session messages to capture events with stable, dedupe-safe ids. */
export function toEvents(sessionID: string, messages: SessionMessageLike[]): CaptureEvent[] {
  const events: CaptureEvent[] = [];
  for (const message of messages) {
    const msg = message as {
      type?: string;
      id?: string;
      time?: { created?: number };
      text?: unknown;
      content?: unknown;
      command?: unknown;
      status?: unknown;
      exit?: unknown;
      output?: { output?: unknown };
    };
    if (typeof msg.id !== "string" || typeof msg.type !== "string") continue;
    const ts = toMillis(msg.time?.created);

    if (msg.type === "user" && typeof msg.text === "string") {
      events.push({
        id: `oc_${msg.id}`,
        ts,
        source: "opencode",
        actor: "user",
        kind: "message",
        session_id: sessionID,
        payload: { text: truncateStrings(msg.text) },
      });
      continue;
    }

    if (msg.type === "assistant" && Array.isArray(msg.content)) {
      const parts = msg.content as Array<{ type?: string; text?: unknown; id?: unknown; name?: unknown; state?: unknown }>;
      const text = parts
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();
      if (text !== "") {
        events.push({
          id: `oc_${msg.id}`,
          ts,
          source: "opencode",
          actor: "assistant",
          kind: "message",
          session_id: sessionID,
          payload: { text: truncateStrings(text) },
        });
      }
      parts.forEach((part, index) => {
        if (part?.type === "tool") {
          events.push({
            id: `oc_${msg.id}_t${index}`,
            ts,
            source: "opencode",
            actor: "tool",
            kind: "tool_call",
            session_id: sessionID,
            payload: { tool: part.name, call_id: part.id, state: truncateStrings(part.state) },
          });
        }
      });
      continue;
    }

    if (msg.type === "shell") {
      events.push({
        id: `oc_${msg.id}`,
        ts,
        source: "opencode",
        actor: "tool",
        kind: "tool_call",
        session_id: sessionID,
        payload: {
          command: msg.command,
          status: msg.status,
          exit: msg.exit ?? null,
          output: truncateStrings(typeof msg.output?.output === "string" ? msg.output.output : ""),
        },
      });
    }
  }
  return events;
}

/** Filter out events whose ids were already ingested (the local per-session ledger). */
export function pickNew(events: CaptureEvent[], ingestedIds: ReadonlySet<string>): CaptureEvent[] {
  return events.filter((event) => !ingestedIds.has(event.id));
}
