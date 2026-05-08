/**
 * Tests for `deriveActivity` — the helper the session header calls to decide
 * what status to show:  thinking / running / awaiting / idle.  Pure function
 * over the reducer state, so we hand-build minimal states rather than running
 * the full reducer here.
 */
import { describe, it, expect } from "vitest";
import { deriveActivity, emptyState } from "../agent/messageStore";
import type { AgentSessionState, RenderedMessage } from "../agent/messageStore";
import type {
  TextBlockData,
  ToolUseBlockData,
} from "../agent/types";

const text = (s: string): TextBlockData => ({ type: "text", text: s });
const toolUse = (id: string, name: string): ToolUseBlockData => ({
  type: "tool_use",
  id,
  name,
  input: {},
});

const userMessage = (id: string, ts: number): RenderedMessage => ({
  id,
  role: "user",
  blocks: [text("hello")],
  timestamp: ts,
});

const assistantMessage = (
  id: string,
  ts: number,
  blocks: RenderedMessage["blocks"] = [text("ok")],
): RenderedMessage => ({
  id,
  role: "assistant",
  blocks,
  timestamp: ts,
});

const stateWith = (overrides: Partial<AgentSessionState>): AgentSessionState => ({
  ...emptyState(),
  ...overrides,
});

describe("deriveActivity", () => {
  it("returns idle when there are no messages", () => {
    expect(deriveActivity(emptyState())).toEqual({ status: "idle", since: null });
  });

  it("returns idle when the last message is an assistant reply with no in-flight work", () => {
    const state = stateWith({
      messages: [userMessage("u1", 100), assistantMessage("a1", 200)],
    });
    expect(deriveActivity(state)).toEqual({ status: "idle", since: null });
  });

  it("reports awaiting when the user has sent a message and no assistant reply has come back", () => {
    const state = stateWith({
      messages: [userMessage("u1", 100)],
    });
    expect(deriveActivity(state)).toEqual({ status: "awaiting", since: 100 });
  });

  it("reports thinking while the assistant message is mid-stream", () => {
    const a = assistantMessage("a1", 250);
    const state = stateWith({
      messages: [userMessage("u1", 100), a],
      streamingMessageId: "a1",
    });
    expect(deriveActivity(state)).toEqual({ status: "thinking", since: 250 });
  });

  it("reports running when a tool is in flight, and surfaces the tool name", () => {
    const a = assistantMessage("a1", 300, [
      text("running a command"),
      toolUse("tool-1", "Bash"),
    ]);
    const state = stateWith({
      messages: [userMessage("u1", 100), a],
      streamingMessageId: "a1",
      runningToolUseIds: new Set(["tool-1"]),
    });
    const activity = deriveActivity(state);
    expect(activity.status).toBe("running");
    expect(activity.toolName).toBe("Bash");
    expect(activity.since).toBe(300);
  });

  it("surfaces the most recently-issued tool when multiple are running", () => {
    const a = assistantMessage("a1", 300, [
      toolUse("tool-1", "Bash"),
      text("..."),
      toolUse("tool-2", "Grep"),
    ]);
    const state = stateWith({
      messages: [a],
      runningToolUseIds: new Set(["tool-1", "tool-2"]),
    });
    expect(deriveActivity(state).toolName).toBe("Grep");
  });

  it("falls back to running with no toolName when the running id can't be matched", () => {
    const state = stateWith({
      messages: [assistantMessage("a1", 300)],
      runningToolUseIds: new Set(["unmatched-id"]),
    });
    expect(deriveActivity(state)).toEqual({
      status: "running",
      toolName: undefined,
      since: null,
    });
  });

  it("prefers running over thinking when both are true (tool calls dominate the visible status)", () => {
    const a = assistantMessage("a1", 200, [toolUse("t1", "WebFetch")]);
    const state = stateWith({
      messages: [a],
      streamingMessageId: "a1",
      runningToolUseIds: new Set(["t1"]),
    });
    expect(deriveActivity(state).status).toBe("running");
  });
});
