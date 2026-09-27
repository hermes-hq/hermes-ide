// @vitest-environment jsdom
/**
 * Issue #317 — the pane header (ScopeBar) and session card named the
 * provider ("claude") instead of the model actually in use.
 *
 * Renders the real components against the real `useAgentInit` cache /
 * event path (Tauri `listen` is mocked with a live-delivery channel).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { SessionData } from "../types/session";

const handlers: { channel: string; handler: (msg: { payload: unknown }) => void }[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (channel: string, handler: (msg: { payload: unknown }) => void) => {
    const entry = { channel, handler };
    handlers.push(entry);
    return () => handlers.splice(handlers.indexOf(entry), 1);
  }),
  emit: vi.fn(),
}));
function emit(channel: string, payload: unknown) {
  handlers.filter((h) => h.channel === channel).forEach((h) => h.handler({ payload }));
}

let sessions: Record<string, SessionData> = {};
vi.mock("../state/SessionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/SessionContext")>()),
  useSession: () => ({ state: { sessions }, createSession: vi.fn() }),
}));
vi.mock("../hooks/useSessionProjects", () => ({
  useSessionProjects: () => ({
    projects: [{ id: "p1", name: "proj", path: "/tmp/proj", languages: [], scan_status: "done" }],
    detach: vi.fn(),
  }),
}));
vi.mock("../hooks/useSessionGitSummary", () => ({ useSessionGitSummary: () => ({ allBranches: [] }) }));
vi.mock("../hooks/useContextMenu", () => ({
  useContextMenu: () => ({ showMenu: vi.fn() }),
  menuItem: vi.fn(), separator: vi.fn(), subMenu: vi.fn(),
}));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home") }));
vi.mock("../components/ProjectPicker", () => ({ ProjectPicker: () => null }));

import { ScopeBar } from "../components/ScopeBar";
import { SessionAgentTag } from "../components/SessionList";
import { cacheAgentInit, clearAgentInitCache } from "../agent/useAgentInit";
import type { InitEvent } from "../agent/types";

function init(model: string): InitEvent {
  return {
    type: "system", subtype: "init", cwd: "/tmp", session_id: "c", uuid: "u",
    tools: [], slash_commands: [], mcp_servers: [], model, permissionMode: "default",
  };
}

function session(over: Partial<SessionData>): SessionData {
  return { id: "s1", mode: "agent", ai_provider: "claude", detected_agent: null, ...over } as SessionData;
}

const claudeCode = (model: string | null) =>
  ({ name: "Claude Code", provider: "anthropic", model, detected_at: "", confidence: 1 });

beforeEach(() => {
  cleanup();
  handlers.length = 0;
  clearAgentInitCache("s1");
});

describe("ScopeBar model label (#317)", () => {
  it("agent mode: shows the active model, and follows a model switch (respawn init)", async () => {
    sessions = { s1: session({}) };
    cacheAgentInit("s1", init("claude-opus-4-7"));
    const { container } = render(<ScopeBar sessionId="s1" />);
    await act(async () => {});
    const label = container.querySelector(".scope-bar-provider");
    expect(label).toHaveTextContent(/^opus$/);

    act(() => emit("agent-event-s1", init("claude-sonnet-4-6")));
    expect(label).toHaveTextContent(/^sonnet$/);
  });

  it("agent mode: falls back to the provider before any init arrives", async () => {
    sessions = { s1: session({}) };
    const { container } = render(<ScopeBar sessionId="s1" />);
    await act(async () => {});
    expect(container.querySelector(".scope-bar-provider")).toHaveTextContent(/^claude$/);
  });

  it("terminal mode: shows the detected model", async () => {
    sessions = { s1: session({ mode: "terminal", detected_agent: claudeCode("sonnet") }) };
    const { container } = render(<ScopeBar sessionId="s1" />);
    await act(async () => {});
    expect(container.querySelector(".scope-bar-provider")).toHaveTextContent(/^sonnet$/);
  });
});

describe("SessionAgentTag (#317)", () => {
  it("agent mode: shows the active model", async () => {
    cacheAgentInit("s1", init("claude-fable-5"));
    render(<SessionAgentTag session={session({})} />);
    await act(async () => {});
    expect(screen.getByText("fable")).toBeInTheDocument();
  });

  it("terminal mode: agent name plus detected model, or name alone when unknown", () => {
    const { rerender } = render(
      <SessionAgentTag session={session({ mode: "terminal", detected_agent: claudeCode("opus") })} />,
    );
    expect(screen.getByText("Claude Code · opus")).toBeInTheDocument();
    rerender(<SessionAgentTag session={session({ mode: "terminal", detected_agent: claudeCode(null) })} />);
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
  });

  it("terminal mode, Custom agent (F06): shows the name the user gave it", () => {
    const { container, rerender } = render(
      <SessionAgentTag session={session({ id: "s-custom", mode: "terminal", ai_provider: "custom", agent_name: "Fake Agent" })} />,
    );
    expect(screen.getByText("Fake Agent")).toBeInTheDocument();
    // A plain terminal session gets no tag at all.
    rerender(<SessionAgentTag session={session({ id: "s-plain", mode: "terminal", ai_provider: null })} />);
    expect(container.querySelector(".session-agent-tag")).toBeNull();
  });
});
