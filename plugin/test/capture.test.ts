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
