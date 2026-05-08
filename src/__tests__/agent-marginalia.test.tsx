/**
 * Engineering-logbook layout (post-frontend-design rethink) — replaces the
 * earlier marginalia + 2px-bar treatment with a numbered turn gutter
 * (`№ 01 · 17:15:23`).  Each user message starts a new turn; assistant
 * continuations leave the gutter empty so the eye groups them together.
 *
 * These tests pin:
 *   - No ASSISTANT/USER caps headers anywhere.
 *   - Each role uses `data-role=…` for styling hooks.
 *   - The gutter element is rendered for every message.
 *   - The number + timestamp render only when `isFirstOfTurn` is true.
 */
import { describe, expect, it, vi } from "vitest";

// Mock Tauri event API — `AgentSessionView.tsx` imports it at module load.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { renderToString } from "react-dom/server";
import { MessageRow, formatHHMMSS } from "../agent/AgentSessionView";
import type { RenderedMessage } from "../agent/messageStore";
import type { ToolResultBlockData } from "../agent/types";

function userMessage(text: string, id = "user-1"): RenderedMessage {
  return {
    id,
    role: "user",
    blocks: [{ type: "text", text }],
    timestamp: 1700000000000,
  };
}

function assistantMessage(text: string, id = "msg_1"): RenderedMessage {
  return {
    id,
    role: "assistant",
    blocks: [{ type: "text", text }],
    timestamp: 1700000000000,
  };
}

const emptyToolResults = new Map<string, ToolResultBlockData>();

describe("engineering-logbook message rows", () => {
  it("renders no ASSISTANT or USER caps headers anywhere", () => {
    const html = [
      renderToString(
        <MessageRow message={userMessage("hello")} toolResults={emptyToolResults} />,
      ),
      renderToString(
        <MessageRow
          message={assistantMessage("hi back")}
          toolResults={emptyToolResults}
        />,
      ),
    ].join("\n");

    expect(html).not.toMatch(/>ASSISTANT</);
    expect(html).not.toMatch(/>USER</);
    expect(html).not.toContain("agent-message-role-label");
    expect(html).not.toContain("agent-message-role");
  });

  it("user message has data-role=user and the body wrapper", () => {
    const html = renderToString(
      <MessageRow message={userMessage("hi")} toolResults={emptyToolResults} />,
    );
    expect(html).toContain('data-role="user"');
    expect(html).toContain("agent-message-user");
    expect(html).toContain("agent-message-body");
    expect(html).toContain("agent-message-gutter");
  });

  it("assistant message has data-role=assistant and the same DOM shape", () => {
    const html = renderToString(
      <MessageRow
        message={assistantMessage("ok")}
        toolResults={emptyToolResults}
      />,
    );
    expect(html).toContain('data-role="assistant"');
    expect(html).toContain("agent-message-assistant");
    expect(html).toContain("agent-message-body");
    expect(html).toContain("agent-message-gutter");
  });

  it("renders the timestamp in the gutter on the first message of a turn", () => {
    const html = renderToString(
      <MessageRow
        message={userMessage("hi")}
        toolResults={emptyToolResults}
        turnNumber={1}
        isFirstOfTurn={true}
      />,
    );
    expect(html).toContain("agent-message-time");
    // The "№ NN" turn-number lockup was rejected by the user — assert it's
    // gone and stays gone.  Only the timestamp lives in the gutter now.
    expect(html).not.toContain("agent-message-num");
    expect(html).not.toContain("№");
  });

  it("leaves the gutter empty on assistant continuations within a turn", () => {
    // The assistant reply that follows a user prompt should not duplicate
    // the timestamp — the eye should pair it with the prompt above.
    const html = renderToString(
      <MessageRow
        message={assistantMessage("ok")}
        toolResults={emptyToolResults}
        turnNumber={1}
        isFirstOfTurn={false}
      />,
    );
    expect(html).toContain("agent-message-gutter");
    expect(html).not.toContain("agent-message-time");
    expect(html).not.toContain("agent-message-num");
    expect(html).not.toContain("№");
  });
});

describe("formatHHMMSS", () => {
  it("returns empty string for undefined timestamp", () => {
    expect(formatHHMMSS(undefined)).toBe("");
  });

  it("zero-pads hours, minutes, seconds", () => {
    // 2024-01-01 03:04:05 in local time.
    const d = new Date(2024, 0, 1, 3, 4, 5);
    expect(formatHHMMSS(d.getTime())).toBe("03:04:05");
  });

  it("handles late-day times (23:59:59)", () => {
    const d = new Date(2024, 0, 1, 23, 59, 59);
    expect(formatHHMMSS(d.getTime())).toBe("23:59:59");
  });
});
