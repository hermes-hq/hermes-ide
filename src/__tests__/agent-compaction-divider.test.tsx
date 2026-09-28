// @vitest-environment jsdom
/**
 * F14 — when the agent compacts its context (a `system`/`compact_boundary`
 * event), the Agent view draws a "Context compacted" divider right after the
 * message that was last at that moment. Before this, the event was dropped.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async () => ""),
  setSetting: vi.fn(async () => {}),
}));
vi.mock("../featureFlags", () => ({ isFeatureFlagEnabled: () => false }));

const SID = "sess-f14";
vi.mock("../state/SessionContext", () => ({
  useSession: () => ({
    sendAgentEnvelope: vi.fn(async () => {}),
    respawnAgent: vi.fn(async () => true),
    createSession: vi.fn(async () => null),
    state: { sessions: { [SID]: { id: SID, ai_provider: "claude", working_directory: "/work/project", mode: "agent" } } },
  }),
}));

import { AgentSessionView } from "../agent/AgentSessionView";
import { getOrCreateAgentSessionStore, _resetAgentSessionStoresForTest } from "../agent/agentSessionStore";
import { emptyState, reduceEvent } from "../agent/messageStore";
import type { AgentEvent } from "../agent/types";

const user = (text: string): AgentEvent =>
  ({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, session_id: SID }) as AgentEvent;
const reply = (id: string, text: string): AgentEvent =>
  ({
    type: "assistant",
    message: { id, type: "message", role: "assistant", model: "fake-model", content: [{ type: "text", text }], stop_reason: "end_turn" },
    parent_tool_use_id: null,
    session_id: SID,
  }) as AgentEvent;
const compact = (trigger = "manual"): AgentEvent =>
  ({ type: "system", subtype: "compact_boundary", session_id: SID, compact_metadata: { trigger, pre_tokens: 150000 } }) as AgentEvent;

afterEach(() => {
  cleanup();
  _resetAgentSessionStoresForTest();
});

describe("messageStore: compact_boundary", () => {
  it("is recorded after the last top-level message, with its trigger and size", () => {
    let s = emptyState();
    s = reduceEvent(s, compact("auto"));
    expect(s.compactions).toHaveLength(1);
    expect(s.compactions[0]).toMatchObject({ afterMessageId: null, trigger: "auto", preTokens: 150000 });
    s = reduceEvent(s, user("first"));
    s = reduceEvent(s, reply("m1", "one"));
    s = reduceEvent(s, compact());
    expect(s.compactions[1]).toMatchObject({ afterMessageId: "m1", trigger: "manual" });
  });

  it("other system events still change nothing", () => {
    const s = emptyState();
    expect(reduceEvent(s, { type: "system", subtype: "status", session_id: SID } as AgentEvent)).toBe(s);
  });
});

describe("Agent view: the divider", () => {
  it("appears where the compaction happened, and nowhere before it", () => {
    const view = render(<AgentSessionView sessionId={SID} workspacePathCount={1} />);
    const store = getOrCreateAgentSessionStore(SID, async () => () => {});
    act(() => {
      store.injectEvent(user("first"));
      store.injectEvent(reply("m1", "fake reply: first"));
    });
    const dividers = () => [...view.container.querySelectorAll(".agent-compaction-divider")];
    expect(dividers()).toHaveLength(0);

    act(() => {
      store.injectEvent(user("/compact"));
      store.injectEvent(compact());
      store.injectEvent(reply("m2", "fake reply: after"));
    });
    expect(dividers()).toHaveLength(1);
    const divider = dividers()[0];
    expect(divider.textContent).toBe("Context compacted");
    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.getAttribute("data-trigger")).toBe("manual");
    // It sits between the "/compact" message and the reply that follows.
    const text = view.container.querySelector(".agent-session-messages")!.textContent!;
    expect(text.indexOf("/compact")).toBeLessThan(text.indexOf("Context compacted"));
    expect(text.indexOf("Context compacted")).toBeLessThan(text.indexOf("fake reply: after"));
    expect(text.indexOf("fake reply: first")).toBeLessThan(text.indexOf("/compact"));
  });
});
