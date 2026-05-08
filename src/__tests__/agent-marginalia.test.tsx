/**
 * Modern speaker-chip layout — replaces the earlier engineering-logbook
 * gutter (`№ 01 · 17:15:23`) with an inline speaker row above each
 * message body:
 *
 *   [avatar]  You · 14:27
 *             body content (sans-serif)
 *
 * No left gutter, no marginalia numbering, no brass margin bar.  These
 * tests pin the new contract:
 *
 *   - data-role="user" / data-role="assistant" still drive styling
 *   - Speaker chip carries the avatar + name + (optional) timestamp
 *   - Timestamp shows on the first-of-turn message only — assistant
 *     continuations within a turn drop it so the eye groups the turn
 *   - Old logbook artefacts (gutter, № sigil, role-label headers) are
 *     gone and stay gone.
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

describe("modern speaker-chip message rows", () => {
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

  it("user message has data-role=user, the body wrapper, and a 'You' speaker", () => {
    const html = renderToString(
      <MessageRow message={userMessage("hi")} toolResults={emptyToolResults} />,
    );
    expect(html).toContain('data-role="user"');
    expect(html).toContain("agent-message-user");
    expect(html).toContain("agent-message-body");
    expect(html).toContain("agent-message-speaker");
    expect(html).toContain("agent-message-avatar");
    expect(html).toMatch(/agent-message-name[^>]*>You</);
  });

  it("assistant message has data-role=assistant and a 'Hermes' speaker", () => {
    const html = renderToString(
      <MessageRow
        message={assistantMessage("ok")}
        toolResults={emptyToolResults}
      />,
    );
    expect(html).toContain('data-role="assistant"');
    expect(html).toContain("agent-message-assistant");
    expect(html).toContain("agent-message-body");
    expect(html).toContain("agent-message-speaker");
    expect(html).toContain("agent-message-avatar");
    expect(html).toMatch(/agent-message-name[^>]*>Hermes</);
  });

  it("renders the timestamp inline in the speaker chip on the first message of a turn", () => {
    const html = renderToString(
      <MessageRow
        message={userMessage("hi")}
        toolResults={emptyToolResults}
        turnNumber={1}
        isFirstOfTurn={true}
      />,
    );
    expect(html).toContain("agent-message-time");
    // Old gutter / marginalia artefacts must stay gone.
    expect(html).not.toContain("agent-message-num");
    expect(html).not.toContain("agent-message-gutter");
    expect(html).not.toContain("№");
  });

  it("drops the timestamp on continuation messages within a turn", () => {
    // Assistant continuations within the same turn should not duplicate
    // the timestamp — the eye groups the user prompt with its reply.
    const html = renderToString(
      <MessageRow
        message={assistantMessage("ok")}
        toolResults={emptyToolResults}
        turnNumber={1}
        isFirstOfTurn={false}
      />,
    );
    expect(html).toContain("agent-message-speaker");
    expect(html).toContain("agent-message-avatar");
    expect(html).not.toContain("agent-message-time");
    expect(html).not.toContain("agent-message-num");
    expect(html).not.toContain("agent-message-gutter");
    expect(html).not.toContain("№");
  });

  it("user avatar has data-role=user (theme accent paints the disc)", () => {
    const html = renderToString(
      <MessageRow message={userMessage("hi")} toolResults={emptyToolResults} />,
    );
    // The disc inherits its color from theme-scoped CSS via [data-role].
    expect(html).toMatch(/agent-message-avatar[^>]*data-role="user"/);
  });

  it("assistant avatar has data-role=assistant", () => {
    const html = renderToString(
      <MessageRow
        message={assistantMessage("ok")}
        toolResults={emptyToolResults}
      />,
    );
    expect(html).toMatch(/agent-message-avatar[^>]*data-role="assistant"/);
  });
});

describe("formatHHMMSS", () => {
  it("returns empty string for undefined timestamp", () => {
    expect(formatHHMMSS(undefined)).toBe("");
  });

  it("zero-pads hours, minutes, seconds", () => {
    const d = new Date(2024, 0, 1, 3, 4, 5);
    expect(formatHHMMSS(d.getTime())).toBe("03:04:05");
  });

  it("handles late-day times (23:59:59)", () => {
    const d = new Date(2024, 0, 1, 23, 59, 59);
    expect(formatHHMMSS(d.getTime())).toBe("23:59:59");
  });
});
