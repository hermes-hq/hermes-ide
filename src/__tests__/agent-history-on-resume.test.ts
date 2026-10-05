/**
 * A restored Agent-view session draws its earlier conversation again: the
 * events read back from Claude's transcript go in front of anything the
 * store already shows, finished (nothing running or waiting), each message
 * with the time it was said, and never twice.
 */
import { describe, it, expect } from "vitest";
import { emptyState, reduceEvent, withHistory, deriveActivity } from "../agent/messageStore";
import { AgentSessionStore } from "../agent/agentSessionStore";
import type { AgentEvent } from "../agent/types";

const T0 = Date.parse("2026-10-05T10:00:00.000Z");

const user = (uuid: string, text: string, ts: number) =>
  ({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, _hermes_history_ts: ts }) as unknown as AgentEvent;
const toolResult = (uuid: string, toolUseId: string, content: string, ts: number) =>
  ({ type: "user", uuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] }, parent_tool_use_id: null, _hermes_history_ts: ts }) as unknown as AgentEvent;
const assistant = (id: string, content: unknown[], ts: number) =>
  ({ type: "assistant", message: { id, role: "assistant", content }, parent_tool_use_id: null, _hermes_history_ts: ts }) as unknown as AgentEvent;

const HISTORY: AgentEvent[] = [
  user("u1", "make greet say hello, world", T0),
  assistant("msg_1", [{ type: "thinking", thinking: "Read it first." }], T0 + 1000),
  assistant("msg_1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat greet.js" } }], T0 + 2000),
  toolResult("u2", "t1", "export const greet = () => \"hello\";", T0 + 3000),
  assistant("msg_2", [{ type: "text", text: "Done." }], T0 + 4000),
];

describe("the earlier conversation of a restored session", () => {
  it("is drawn in order, finished, with the time each message was said", () => {
    const state = withHistory(emptyState(), HISTORY);
    expect(state.messages.map((m) => [m.role, m.id])).toEqual([
      ["user", "user-u1"],
      ["assistant", "msg_1"],
      ["assistant", "msg_2"],
    ]);
    expect(state.messages[1].blocks.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(state.messages.map((m) => m.timestamp)).toEqual([T0, T0 + 1000, T0 + 4000]);
    expect(state.toolResults.get("t1")).toBeTruthy();
    expect(state.runningToolUseIds.size).toBe(0);
    expect(state.streamingMessageId).toBeNull();
    // No timer for a thinking block of the past: its time is not known.
    expect(state.thinkingStartedAt.size).toBe(0);
    expect(state.thinkingElapsed.size).toBe(0);
    expect(deriveActivity(state).status).toBe("idle");
  });

  it("goes before what the resumed agent already streamed, and is not added twice", () => {
    let live = emptyState();
    live = reduceEvent(live, user("u9", "and now?", Date.now()));
    live = reduceEvent(live, assistant("msg_9", [{ type: "text", text: "Here." }], Date.now()));
    const state = withHistory(live, HISTORY);
    expect(state.messages.map((m) => m.id)).toEqual(["user-u1", "msg_1", "msg_2", "user-u9", "msg_9"]);
    expect(withHistory(state, HISTORY).messages.map((m) => m.id)).toEqual(state.messages.map((m) => m.id));
    expect(withHistory(state, HISTORY)).toBe(state);
  });

  it("does not read as waiting when it ends on a prompt the app quit before answering", () => {
    const unanswered = [...HISTORY, user("u3", "one more thing", T0 + 5000)];
    const state = withHistory(emptyState(), unanswered);
    expect(state.messages.at(-1)?.id).toBe("user-u3");
    expect(deriveActivity(state).status).toBe("idle");
    // A prompt sent now still waits for its answer.
    const next = reduceEvent(state, user("u4", "hello?", Date.now() + 10));
    expect(deriveActivity(next).status).toBe("awaiting");
  });

  it("changes nothing when there is no history", () => {
    const live = emptyState();
    expect(withHistory(live, [])).toBe(live);
    expect(withHistory(live, [{ type: "system", subtype: "status" } as unknown as AgentEvent])).toBe(live);
  });

  it("reaches the session's store and its views", () => {
    const store = new AgentSessionStore("s-history", () => Promise.resolve(() => {}));
    let notified = 0;
    store.subscribe(() => { notified += 1; });
    store.seedHistory(HISTORY);
    expect(store.getSnapshot().state.messages).toHaveLength(3);
    expect(notified).toBe(1);
    store.seedHistory(HISTORY);
    expect(notified).toBe(1);
    store.destroy();
  });
});
