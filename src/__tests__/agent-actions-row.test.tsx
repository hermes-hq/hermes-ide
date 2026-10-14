// @vitest-environment jsdom
/**
 * The Agent view's action row (above the composer): the same row as a
 * terminal pane's, sent through the composer's own path. The composer's
 * model chip is the Model action there (not repeated), Plan switches the
 * composer's permission mode, a draft in the composer is never replaced,
 * and nothing runs while the agent works.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({ working: false, listeners: new Set<() => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../terminal/TerminalPool", () => ({ setSubmittedCommandListener: vi.fn(), focusTerminal: vi.fn(), getTerminal: () => null }));
vi.mock("../agent/agentSessionStore", () => ({
  getOrCreateAgentSessionStore: () => ({
    subscribe: (cb: () => void) => {
      h.listeners.add(cb);
      return () => h.listeners.delete(cb);
    },
    getSnapshot: () => ({ state: { working: h.working } }),
  }),
}));
vi.mock("../agent/workingState", () => ({ selectWorkingState: (s: { working: boolean }) => ({ active: s.working }) }));

import { AgentActionsRow } from "../components/AgentActionsRow";
import { I18nProvider } from "../i18n/I18nProvider";
import { _resetPinnedActionsForTest } from "../sessionActions/pins";

function renderRow(props: Partial<Parameters<typeof AgentActionsRow>[0]> = {}) {
  const sendCommand = vi.fn(async () => {});
  const setPermissionMode = vi.fn();
  render(
    <I18nProvider>
      <AgentActionsRow
        sessionId="a1"
        agentName="Claude Code"
        cwd="/fixture-home/project"
        liveCommands={[{ command: "/compact", description: "Compact" }, { command: "/pr-comments", description: "PR comments" }]}
        hasDraft={false}
        sendCommand={sendCommand}
        permissionMode="default"
        setPermissionMode={setPermissionMode}
        {...props}
      />
    </I18nProvider>,
  );
  return { sendCommand, setPermissionMode };
}

beforeEach(() => {
  h.working = false;
  _resetPinnedActionsForTest();
});
afterEach(cleanup);

describe("Agent view action row", () => {
  it("does not repeat the composer's model chip; Plan toggles the permission mode", () => {
    const { setPermissionMode } = renderRow();
    expect(document.querySelector('[data-session-action="model"]')).toBeNull();
    const plan = document.querySelector<HTMLButtonElement>('[data-session-action="plan"]')!;
    expect(plan).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(plan);
    expect(setPermissionMode).toHaveBeenCalledWith("plan");
    cleanup();
    const again = renderRow({ permissionMode: "plan" });
    const pressed = document.querySelector<HTMLButtonElement>('[data-session-action="plan"]')!;
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(pressed);
    expect(again.setPermissionMode).toHaveBeenCalledWith("default");
  });

  it("sends through the composer's own path when the agent waits and the composer is empty", async () => {
    const { sendCommand } = renderRow();
    await act(async () => fireEvent.click(document.querySelector('[data-session-action="review"]')!));
    expect(sendCommand).toHaveBeenCalledWith("/code-review");
  });

  it("never replaces a draft in the composer", async () => {
    const { sendCommand } = renderRow({ hasDraft: true });
    await act(async () => fireEvent.click(document.querySelector('[data-session-action="review"]')!));
    expect(sendCommand).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Finish or clear your message first");
  });

  it("waits while the agent works", () => {
    h.working = true;
    renderRow();
    expect(document.querySelector('[data-session-action="review"]')).toBeDisabled();
  });

  it("lists the agent's live commands in the Commands list", async () => {
    renderRow();
    fireEvent.click(document.querySelector("[data-session-commands]")!);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(document.querySelector('[data-command="/pr-comments"]')).toBeInTheDocument();
  });
});
