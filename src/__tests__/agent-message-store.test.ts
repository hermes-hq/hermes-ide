/**
 * Tests for the agent message-store reducer using captured Claude
 * stream-json fixtures from Phase 1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  emptyState,
  reduceAll,
  reduceEvent,
} from "../agent/messageStore";
import type {
  AgentEvent,
  AssistantEvent,
  ParseErrorEvent,
  RateLimitEvent,
  ResultEvent,
  ToolResultBlockData,
  ToolUseBlockData,
  UserEvent,
} from "../agent/types";

function loadFixture(name: string): AgentEvent[] {
  const path = join(
    __dirname,
    "../../src-tauri/test-fixtures/agent-stream",
    `${name}.ndjson`,
  );
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentEvent);
}

describe("messageStore", () => {
  it("text-response fixture: produces 1 assistant text message + result", () => {
    const events = loadFixture("text-response");
    const state = reduceAll(events);
    expect(state.initialized).toBe(true);
    expect(state.initEvent?.session_id).toBeDefined();
    const assistantMessages = state.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].blocks.some((b) => b.type === "text")).toBe(true);
    expect(state.resultEvent?.subtype).toBe("success");
    expect(state.resultEvent?.is_error).toBe(false);
  });

  it("tool-bash fixture: produces tool_use + paired tool_result", () => {
    const events = loadFixture("tool-bash");
    const state = reduceAll(events);
    const toolUseBlock = state.messages
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "tool_use") as ToolUseBlockData | undefined;
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock!.name).toBe("Bash");
    expect(state.toolResults.has(toolUseBlock!.id)).toBe(true);
    const result = state.toolResults.get(toolUseBlock!.id) as ToolResultBlockData;
    expect(result.tool_use_id).toBe(toolUseBlock!.id);
  });

  it("tool-bash fixture: tool_result events are NOT appended as user messages", () => {
    const events = loadFixture("tool-bash");
    const state = reduceAll(events);
    // Fixture contains a `user` event that is purely tool_result — it should
    // populate the toolResults map but NOT show up as a user message.
    const userMessages = state.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(0);
  });

  it("thinking fixture: captures thinking content blocks", () => {
    const events = loadFixture("thinking");
    const state = reduceAll(events);
    const thinkingBlock = state.messages
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
  });

  it("captures rate_limit_event", () => {
    const events = loadFixture("text-response");
    const state = reduceAll(events);
    expect(state.rateLimitInfo).not.toBeNull();
    expect(state.rateLimitInfo?.status).toBeDefined();
  });

  it("drops stream_event partials and does not push them to unknownEvents", () => {
    const events: AgentEvent[] = [
      { type: "stream_event", event: { delta: { text: "hi" } } } as AgentEvent,
      { type: "stream_event", event: { delta: { text: " there" } } } as AgentEvent,
      {
        type: "result",
        subtype: "success",
        is_error: false,
      } as ResultEvent,
    ];
    const state = reduceAll(events);
    expect(state.unknownEvents).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.resultEvent?.subtype).toBe("success");
  });

  it("merges multiple assistant events with the same message.id", () => {
    const events: AgentEvent[] = [
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "thinking", thinking: "hmm" }],
        },
        session_id: "s",
        uuid: "u1",
      } as AssistantEvent,
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "hi" }],
        },
        session_id: "s",
        uuid: "u2",
      } as AssistantEvent,
    ];
    const state = reduceAll(events);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].blocks).toHaveLength(2);
    expect(state.messages[0].blocks[0].type).toBe("thinking");
    expect(state.messages[0].blocks[1].type).toBe("text");
  });

  it("treats different message ids as separate assistant turns", () => {
    const events: AgentEvent[] = [
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "m",
          content: [{ type: "text", text: "first" }],
        },
        session_id: "s",
        uuid: "u1",
      } as AssistantEvent,
      {
        type: "assistant",
        message: {
          id: "msg_2",
          role: "assistant",
          model: "m",
          content: [{ type: "text", text: "second" }],
        },
        session_id: "s",
        uuid: "u2",
      } as AssistantEvent,
    ];
    const state = reduceAll(events);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].id).toBe("msg_1");
    expect(state.messages[1].id).toBe("msg_2");
  });

  it("appends user message when content has non-tool-result blocks", () => {
    const events: AgentEvent[] = [
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "say hi" }],
        },
        uuid: "user-uuid-1",
      } as UserEvent,
    ];
    const state = reduceAll(events);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].id).toBe("user-user-uuid-1");
  });

  it("captures parse_error events into unknownEvents and lastError", () => {
    const event: ParseErrorEvent = {
      type: "parse_error",
      raw: "{not json",
      error: "Unexpected end of JSON input",
    };
    const state = reduceEvent(emptyState(), event);
    expect(state.unknownEvents).toHaveLength(1);
    expect(state.lastError).toBe("Unexpected end of JSON input");
  });

  it("captures unknown event types into unknownEvents instead of crashing", () => {
    const event: AgentEvent = { type: "future_event_type_42", payload: { x: 1 } };
    const state = reduceEvent(emptyState(), event);
    expect(state.unknownEvents).toHaveLength(1);
    expect(state.unknownEvents[0].type).toBe("future_event_type_42");
  });

  it("captures error result with lastError", () => {
    const event: ResultEvent = {
      type: "result",
      subtype: "error",
      is_error: true,
      result: "boom",
    };
    const state = reduceEvent(emptyState(), event);
    expect(state.resultEvent?.is_error).toBe(true);
    expect(state.lastError).toBe("boom");
  });

  it("captures rate-limit info from a synthetic event", () => {
    const event: RateLimitEvent = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "warning",
        rateLimitType: "five_hour",
        isUsingOverage: false,
      },
    };
    const state = reduceEvent(emptyState(), event);
    expect(state.rateLimitInfo?.status).toBe("warning");
  });

  it("ignores unfamiliar system subtypes (e.g. status) without polluting unknownEvents", () => {
    const events: AgentEvent[] = [
      { type: "system", subtype: "status", status: "requesting" } as AgentEvent,
      { type: "system", subtype: "future_subtype" } as AgentEvent,
    ];
    const state = reduceAll(events);
    expect(state.unknownEvents).toEqual([]);
    expect(state.initialized).toBe(false);
    expect(state.initEvent).toBeNull();
  });
});

/**
 * Phase 5 — streaming state reducer tests.
 *
 * Three cues to track:
 *  - heartbeat cursor → `streamingMessageId`
 *  - tool respiration → `runningToolUseIds`
 *  - thinking elapsed → `thinkingStartedAt` / `thinkingElapsed`
 *
 * These tests use `vi.useFakeTimers()` with `vi.setSystemTime(...)` to make
 * `Date.now()` deterministic so we can assert exact elapsed values.
 */
describe("messageStore — streaming state (Phase 5)", () => {
  const T0 = 1_700_000_000_000; // arbitrary epoch ms

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function streamingAssistant(opts: {
    id: string;
    content: AssistantEvent["message"]["content"];
    stopReason?: string | null;
    uuid?: string;
  }): AssistantEvent {
    return {
      type: "assistant",
      message: {
        id: opts.id,
        role: "assistant",
        model: "claude-haiku-4-5",
        content: opts.content,
        ...(opts.stopReason !== undefined ? { stop_reason: opts.stopReason } : {}),
      },
      session_id: "s",
      uuid: opts.uuid ?? `u-${opts.id}`,
    } as AssistantEvent;
  }

  it("emptyState: initializes streaming fields", () => {
    const s = emptyState();
    expect(s.streamingMessageId).toBeNull();
    expect(s.runningToolUseIds).toBeInstanceOf(Set);
    expect(s.runningToolUseIds.size).toBe(0);
    expect(s.thinkingStartedAt).toBeInstanceOf(Map);
    expect(s.thinkingStartedAt.size).toBe(0);
    expect(s.thinkingElapsed).toBeInstanceOf(Map);
    expect(s.thinkingElapsed.size).toBe(0);
  });

  it("assistant event with stop_reason=null sets streamingMessageId to message.id", () => {
    const evt = streamingAssistant({
      id: "msg_a",
      content: [{ type: "text", text: "hi" }],
      stopReason: null,
    });
    const state = reduceEvent(emptyState(), evt);
    expect(state.streamingMessageId).toBe("msg_a");
  });

  it("assistant event with stop_reason set clears streamingMessageId", () => {
    let state = reduceEvent(
      emptyState(),
      streamingAssistant({
        id: "msg_a",
        content: [{ type: "text", text: "partial" }],
        stopReason: null,
      }),
    );
    expect(state.streamingMessageId).toBe("msg_a");

    state = reduceEvent(
      state,
      streamingAssistant({
        id: "msg_a",
        content: [{ type: "text", text: " done" }],
        stopReason: "end_turn",
      }),
    );
    expect(state.streamingMessageId).toBeNull();
  });

  it("result event clears streamingMessageId", () => {
    let state = reduceEvent(
      emptyState(),
      streamingAssistant({
        id: "msg_a",
        content: [{ type: "text", text: "partial" }],
        stopReason: null,
      }),
    );
    expect(state.streamingMessageId).toBe("msg_a");

    state = reduceEvent(state, {
      type: "result",
      subtype: "success",
      is_error: false,
    } as ResultEvent);
    expect(state.streamingMessageId).toBeNull();
  });

  it("tool_use content block adds tool_use.id to runningToolUseIds", () => {
    const evt = streamingAssistant({
      id: "msg_a",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "Bash",
          input: { command: "ls" },
        } as ToolUseBlockData,
      ],
      stopReason: null,
    });
    const state = reduceEvent(emptyState(), evt);
    expect(state.runningToolUseIds.has("tu_1")).toBe(true);
    expect(state.runningToolUseIds.size).toBe(1);
  });

  it("multiple tool_use blocks across events accumulate in runningToolUseIds", () => {
    let state = reduceEvent(
      emptyState(),
      streamingAssistant({
        id: "msg_a",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Bash",
            input: {},
          } as ToolUseBlockData,
        ],
        stopReason: null,
      }),
    );
    state = reduceEvent(
      state,
      streamingAssistant({
        id: "msg_a",
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "Read",
            input: { file_path: "/x" },
          } as ToolUseBlockData,
        ],
        stopReason: null,
      }),
    );
    expect(state.runningToolUseIds.has("tu_1")).toBe(true);
    expect(state.runningToolUseIds.has("tu_2")).toBe(true);
    expect(state.runningToolUseIds.size).toBe(2);
  });

  it("user event with tool_result block removes tool_use_id from runningToolUseIds", () => {
    let state = reduceEvent(
      emptyState(),
      streamingAssistant({
        id: "msg_a",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Bash",
            input: { command: "ls" },
          } as ToolUseBlockData,
        ],
        stopReason: null,
      }),
    );
    expect(state.runningToolUseIds.has("tu_1")).toBe(true);

    const userEvt: UserEvent = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "hello\n",
          } as ToolResultBlockData,
        ],
      },
      uuid: "u-1",
    } as UserEvent;
    state = reduceEvent(state, userEvt);
    expect(state.runningToolUseIds.has("tu_1")).toBe(false);
    expect(state.runningToolUseIds.size).toBe(0);
    // toolResults map still records the result for inline pairing.
    expect(state.toolResults.has("tu_1")).toBe(true);
  });

  it("thinking block first-seen creates thinkingStartedAt entry at Date.now()", () => {
    const evt = streamingAssistant({
      id: "msg_a",
      content: [{ type: "thinking", thinking: "hmm" }],
      stopReason: null,
    });
    const state = reduceEvent(emptyState(), evt);
    expect(state.thinkingStartedAt.get("msg_a:0")).toBe(T0);
    expect(state.thinkingElapsed.has("msg_a:0")).toBe(false);
  });

  it("thinking block followed by text in same message captures elapsed and clears started", () => {
    // First event: thinking block alone (started at T0).
    let state = reduceEvent(
      emptyState(),
      streamingAssistant({
        id: "msg_a",
        content: [{ type: "thinking", thinking: "hmm" }],
        stopReason: null,
      }),
    );
    expect(state.thinkingStartedAt.get("msg_a:0")).toBe(T0);

    // Advance the clock 800ms.
    vi.setSystemTime(T0 + 800);

    // Second event: a text block appended to the same message.
    state = reduceEvent(
      state,
      streamingAssistant({
        id: "msg_a",
        content: [{ type: "text", text: "answer" }],
        stopReason: null,
      }),
    );
    // The thinking timer should be frozen and removed from `started`.
    expect(state.thinkingElapsed.get("msg_a:0")).toBe(800);
    expect(state.thinkingStartedAt.has("msg_a:0")).toBe(false);
  });

  it("result event with thinking still pending captures elapsed", () => {
    // Start a thinking block at T0.
    let state = reduceEvent(
      emptyState(),
      streamingAssistant({
        id: "msg_a",
        content: [{ type: "thinking", thinking: "hmm" }],
        stopReason: null,
      }),
    );

    // Advance 1500ms.
    vi.setSystemTime(T0 + 1500);

    // Result event arrives without a closing assistant event.
    state = reduceEvent(state, {
      type: "result",
      subtype: "success",
      is_error: false,
    } as ResultEvent);

    expect(state.thinkingElapsed.get("msg_a:0")).toBe(1500);
    expect(state.thinkingStartedAt.has("msg_a:0")).toBe(false);
    expect(state.streamingMessageId).toBeNull();
  });

  it("closing assistant event (stop_reason set) freezes pending thinking timers", () => {
    let state = reduceEvent(
      emptyState(),
      streamingAssistant({
        id: "msg_a",
        content: [{ type: "thinking", thinking: "hmm" }],
        stopReason: null,
      }),
    );
    vi.setSystemTime(T0 + 250);
    state = reduceEvent(
      state,
      streamingAssistant({
        id: "msg_a",
        content: [],
        stopReason: "end_turn",
      }),
    );
    expect(state.thinkingElapsed.get("msg_a:0")).toBe(250);
    expect(state.thinkingStartedAt.size).toBe(0);
    expect(state.streamingMessageId).toBeNull();
  });

  it("two thinking blocks in one message track elapsed independently", () => {
    // First event: thinking block at index 0.
    let state = reduceEvent(
      emptyState(),
      streamingAssistant({
        id: "msg_a",
        content: [{ type: "thinking", thinking: "first" }],
        stopReason: null,
      }),
    );
    expect(state.thinkingStartedAt.get("msg_a:0")).toBe(T0);

    // Advance 300ms — append a text block. First thinking ends with elapsed=300.
    vi.setSystemTime(T0 + 300);
    state = reduceEvent(
      state,
      streamingAssistant({
        id: "msg_a",
        content: [{ type: "text", text: "interim" }],
        stopReason: null,
      }),
    );
    expect(state.thinkingElapsed.get("msg_a:0")).toBe(300);

    // Advance 200ms — append a second thinking block at index 2.
    vi.setSystemTime(T0 + 500);
    state = reduceEvent(
      state,
      streamingAssistant({
        id: "msg_a",
        content: [{ type: "thinking", thinking: "second" }],
        stopReason: null,
      }),
    );
    expect(state.thinkingStartedAt.get("msg_a:2")).toBe(T0 + 500);
    // First one is unchanged.
    expect(state.thinkingElapsed.get("msg_a:0")).toBe(300);

    // Advance 700ms — append final text. Second thinking ends with elapsed=700.
    vi.setSystemTime(T0 + 1200);
    state = reduceEvent(
      state,
      streamingAssistant({
        id: "msg_a",
        content: [{ type: "text", text: "final" }],
        stopReason: "end_turn",
      }),
    );
    expect(state.thinkingElapsed.get("msg_a:2")).toBe(700);
    expect(state.thinkingStartedAt.size).toBe(0);
  });

  it("reconstructs Set/Map references on every state change for React identity", () => {
    const empty = emptyState();
    const evt = streamingAssistant({
      id: "msg_a",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "Bash",
          input: {},
        } as ToolUseBlockData,
      ],
      stopReason: null,
    });
    const next = reduceEvent(empty, evt);
    // Previous Set must not be mutated.
    expect(empty.runningToolUseIds.has("tu_1")).toBe(false);
    expect(next.runningToolUseIds.has("tu_1")).toBe(true);
    expect(next.runningToolUseIds).not.toBe(empty.runningToolUseIds);
  });

  it("an unrelated user text message does not touch streaming state", () => {
    let state = reduceEvent(
      emptyState(),
      streamingAssistant({
        id: "msg_a",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Bash",
            input: {},
          } as ToolUseBlockData,
        ],
        stopReason: null,
      }),
    );
    const beforeRunning = state.runningToolUseIds;
    const beforeStreamingId = state.streamingMessageId;

    state = reduceEvent(state, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "say hi" }],
      },
      uuid: "u-1",
    } as UserEvent);

    expect(state.runningToolUseIds).toBe(beforeRunning);
    expect(state.streamingMessageId).toBe(beforeStreamingId);
  });

  it("tool-bash fixture: replayed end-to-end, runningToolUseIds is empty and result clears streamingMessageId", () => {
    const events = loadFixture("tool-bash");
    const state = reduceAll(events);
    expect(state.runningToolUseIds.size).toBe(0);
    expect(state.streamingMessageId).toBeNull();
    expect(state.resultEvent).not.toBeNull();
  });
});
