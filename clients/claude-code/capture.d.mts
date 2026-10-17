// Type surface for the zero-dependency CLI shim, so TypeScript tests can import it.
export interface CapturedEvent {
  id: string;
  ts: number;
  source: "file";
  actor: "user" | "assistant" | "tool";
  kind: "message" | "tool_call";
  session_id: string | null;
  payload: Record<string, unknown>;
}

export function truncateStrings(value: unknown, max?: number): unknown;
export function toMillis(ts: unknown, now?: () => number): number;
export function linesToEvents(
  sessionId: string | null,
  lines: string[],
  opts?: { now?: () => number; limit?: number },
): CapturedEvent[];
