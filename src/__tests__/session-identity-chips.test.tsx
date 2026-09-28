// @vitest-environment jsdom
/**
 * F08 — read-only model / permission-mode chips on terminal sessions.
 *
 * Contract C0 (docs/adr/004-2.0-contracts.md #2): the chips render only
 * from the `identity` SessionEvent the store holds for a session
 * (`useSessionEvents`), never a heuristic, and are hidden field-by-field
 * when the agent hasn't reported that field. Agent-mode sessions never
 * show them — that mode already has its own model display.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn(() => ({ onDragDropEvent: vi.fn(async () => () => {}) })) }));

import { SessionIdentityChips } from "../components/SessionList";
import { I18nProvider } from "../i18n/I18nProvider";
import type { SessionData } from "../types/session";
import { dispatchSessionEvent, _resetSessionEventStoreForTest } from "../agent/contract/sessionEventStore";

function makeSession(overrides?: Partial<SessionData>): SessionData {
  return {
    id: "sess-1",
    label: "Session 1",
    description: "",
    color: "#ff0000",
    group: null,
    phase: "idle",
    working_directory: "/tmp/fixture-project",
    shell: "bash",
    created_at: "2025-01-01T00:00:00Z",
    last_activity_at: "2025-01-01T00:00:00Z",
    workspace_paths: [],
    detected_agent: null,
    metrics: {
      output_lines: 0,
      error_count: 0,
      stuck_score: 0,
      token_usage: {},
      tool_calls: [],
      tool_call_summary: {},
      files_touched: [],
      recent_errors: [],
    } as unknown as SessionData["metrics"],
    ai_provider: null,
    auto_approve: false,
    permission_mode: "default",
    custom_prefix: "",
    custom_suffix: "",
    channels: [],
    context_injected: false,
    ssh_info: null,
    mode: "terminal",
    ...overrides,
  };
}

function renderChips(session: SessionData) {
  return render(
    <I18nProvider>
      <SessionIdentityChips session={session} />
    </I18nProvider>,
  );
}

describe("SessionIdentityChips (F08)", () => {
  beforeEach(() => _resetSessionEventStoreForTest());
  afterEach(() => {
    cleanup();
    _resetSessionEventStoreForTest();
  });

  it("renders nothing for a terminal session the agent has reported nothing about", () => {
    const { container } = renderChips(makeSession());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an agent-mode session, even with identity reported", () => {
    dispatchSessionEvent("sess-1", {
      type: "identity",
      at: 1,
      vendorSessionId: "vs-1",
      model: "fake-model-1",
      permissionMode: "plan",
    });
    const { container } = renderChips(makeSession({ mode: "agent" }));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the model chip once the agent reports its model (real-app scenario: a fake agent reporting a model change updates the chip)", () => {
    dispatchSessionEvent("sess-1", { type: "identity", at: 1, vendorSessionId: null, model: "fake-model-1", permissionMode: null });
    const { getByTestId, queryByTestId, rerender } = renderChips(makeSession());
    expect(getByTestId("session-model-chip")).toHaveTextContent("fake-model-1");
    expect(queryByTestId("session-permission-chip")).toBeNull();

    // The agent reports a model change mid-session — the chip follows it.
    dispatchSessionEvent("sess-1", { type: "identity", at: 2, vendorSessionId: null, model: "fake-model-2", permissionMode: "acceptEdits" });
    rerender(
      <I18nProvider>
        <SessionIdentityChips session={makeSession()} />
      </I18nProvider>,
    );
    expect(getByTestId("session-model-chip")).toHaveTextContent("fake-model-2");
    expect(getByTestId("session-permission-chip")).toHaveTextContent("acceptEdits");
  });

  it("hides the permission chip alone when only the model is known (hidden field-by-field, never guessed)", () => {
    dispatchSessionEvent("sess-1", { type: "identity", at: 1, vendorSessionId: null, model: "fake-model-1", permissionMode: null });
    const { getByTestId, queryByTestId } = renderChips(makeSession());
    expect(getByTestId("session-model-chip")).toBeInTheDocument();
    expect(queryByTestId("session-permission-chip")).toBeNull();
  });

  it("negative control: a different session's identity never bleeds into this one", () => {
    dispatchSessionEvent("some-other-session", { type: "identity", at: 1, vendorSessionId: null, model: "fake-model-1", permissionMode: "plan" });
    const { container } = renderChips(makeSession({ id: "sess-1" }));
    expect(container).toBeEmptyDOMElement();
  });
});
