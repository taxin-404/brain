### Task 13: OpenCode capture plugin (`plugin/`)

**Files:**
- Create: `plugin/package.json`, `plugin/tsconfig.json`, `plugin/vitest.config.ts`, `plugin/src/capture.ts`, `plugin/src/index.ts`, `plugin/test/capture.test.ts`

**Interfaces:**
- Produces (pure, unit-tested):

```ts
export interface CaptureEvent {
  id: string; ts: number; source: "opencode";
  actor: "user" | "assistant" | "tool";
  kind: "message" | "tool_call";
  session_id: string; payload: unknown;
}
export type SessionMessageLike =
  | { type: "user"; id: string; time: { created: number }; text: string }
  | { type: "assistant"; id: string; time: { created: number }; content: Array<
      { type: "text"; text: string } | { type: "tool"; id: string; name: string; state?: unknown }>;
      agent?: unknown; model?: unknown }
  | { type: "shell"; id: string; time: { created: number }; command: string; status?: string;
      exit?: number | string; output?: { output?: string } }
  | { type: string };
export function truncateStrings(value: unknown, max?: number): unknown;   // default 65_536, suffix "…[truncated]"
export function toEvents(sessionID: string, messages: SessionMessageLike[]): CaptureEvent[];
export function pickNew(events: CaptureEvent[], ingestedIds: ReadonlySet<string>): CaptureEvent[];
```

- ID/mapping pins: user → `oc_{msgId}` actor `user`; assistant text parts joined → `oc_{msgId}` actor `assistant` (skip when joined text is empty); each assistant tool item at index `i` → `oc_{msgId}_t{i}` actor `tool`, `payload: { tool: name, call_id: id, state: truncateStrings(state) }`; shell → `oc_{msgId}` actor `tool`, `payload: { command, status, exit, output: truncateStrings(output?.output ?? "") }`; all other message types skipped. `ts` = `time.created < 1e12 ? created * 1000 : created` (server re-normalizes too). `payload.text` for messages.
- Plugin wiring pins (`src/index.ts`): options `{ endpoint, token }` from `ctx.options` (warn + disable when missing); `ctx.event.subscribe({ signal })` filtered to `event.type === "session.status"`; every status update records `ingest/{sessionID}` state `{ lastStatus, lastStatusAt, ids }` in `ctx.storage`; on `status === "idle"` fire `void ingestSession(sessionID)` **not awaited** (spec §7 observe-only); `ingestSession` reads `ctx.session.context({ sessionID })`, maps with `toEvents`, filters with `pickNew`, POSTs JSON-array chunks of ≤500 to `{endpoint}/v1/events/batch` with `Authorization: Bearer {token}` — marks ids as ingested **only after every chunk returns 2xx** (replays are server-deduped, so failed runs are free to retry); backstop `reconcile()` runs on load and every 30 min, scanning `ingest/` state and re-ingesting sessions with `lastStatus === "idle"` and `lastStatusAt <= Date.now() - 30 min` (spec v1.2 amendment 8); cleanup aborts the subscription and clears the interval.

- [ ] **Step 1: Write the failing capture test** — `plugin/test/capture.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pickNew, toEvents, truncateStrings } from "../src/capture";

const user = { type: "user", id: "msg_u1", time: { created: 1_700_000_000 }, text: "hello" };
const assistant = {
  type: "assistant", id: "msg_a1", time: { created: 1_700_000_010 }, agent: "build", model: { id: "x" },
  content: [
    { type: "text", text: "sure thing" },
    { type: "tool", id: "call_1", name: "bash", state: { type: "completed", output: "y".repeat(70_000) } },
  ],
};
const shell = { type: "shell", id: "msg_s1", time: { created: 1_700_000_020 }, command: "ls", status: "exited", exit: 0, output: { output: "files" } };

describe("capture mapping", () => {
  it("maps user/assistant/tool/shell with stable ids and actor tags", () => {
    const events = toEvents("ses_1", [user, assistant, shell, { type: "synthetic" }]);
    expect(events.map((e) => [e.id, e.actor, e.kind])).toEqual([
      ["oc_msg_u1", "user", "message"],
      ["oc_msg_a1", "assistant", "message"],
      ["oc_msg_a1_t1", "tool", "tool_call"],
      ["oc_msg_s1", "tool", "tool_call"],
    ]);
    expect(events[0].ts).toBe(1_700_000_000_000);
    expect(events[0].session_id).toBe("ses_1");
    expect((events[2].payload as { tool: string }).tool).toBe("bash");
  });

  it("truncates long strings inside tool state", () => {
    const events = toEvents("ses_1", [assistant]);
    const state = (events[1].payload as { state: { output: string } }).state;
    expect(state.output.length).toBeLessThan(66_000);
    expect(state.output.endsWith("…[truncated]")).toBe(true);
    expect(truncateStrings("short")).toBe("short");
  });

  it("drops events already recorded in local state", () => {
    const events = toEvents("ses_1", [user, shell]);
    expect(pickNew(events, new Set(["oc_msg_u1"])).map((e) => e.id)).toEqual(["oc_msg_s1"]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** → `cd plugin && npx vitest run` → FAIL (module missing).

- [ ] **Step 3: Implement `plugin/src/capture.ts` + `plugin/src/index.ts` + configs** (pins above). `plugin/package.json`: `"type": "module"`, scripts `"test": "vitest run"`, dependencies `"@opencode/plugin": "^2.0.29"`, devDependencies `vitest@^4.1.0`, `typescript`. `plugin/tsconfig.json`: strict, `lib: ["ES2022", "DOM"]`, `module ESNext`, `moduleResolution bundler`, `noEmit`, include `src`+`test`. `plugin/vitest.config.ts`: `defineConfig({})` from `vitest/config` (node environment).

- [ ] **Step 4: Run it, verify it passes** → PASS (3 tests); `cd plugin && npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: opencode capture plugin with idle hook and 30-min backstop"
```

---

