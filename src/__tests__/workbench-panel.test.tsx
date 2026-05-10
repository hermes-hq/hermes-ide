// @vitest-environment jsdom
/**
 * Component-level coverage for the right-rail Workbench (1.1.14).
 *
 * Pins the contracts a user can see:
 *   - returns null for terminal-mode sessions (mode-gated)
 *   - returns null when state.ui.workbench.open is false (toggle off)
 *   - renders Files tab body by default; switches to Context on tab click
 *   - renders the Notes section regardless of active tab
 *   - clicking the close button dispatches SET_WORKBENCH_OPEN { open:false }
 *
 * Files / Context tab content is mocked so this test stays focused on
 * the panel's tab + visibility logic.  The embedded panels have their
 * own tests elsewhere.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const dispatchMock = vi.fn();

interface FakeUiWorkbench {
  open: boolean;
  tab: "files" | "context";
  ratio: number;
  filesNotesSplit: number;
}

const fakeWb: { ui: { workbench: FakeUiWorkbench }; notes: Record<string, string> } = {
  ui: { workbench: { open: true, tab: "files", ratio: 0.5, filesNotesSplit: 0.7 } },
  notes: {},
};

vi.mock("../state/SessionContext", () => ({
  useSession: () => ({ state: fakeWb, dispatch: dispatchMock }),
}));

// Stub the embedded panels so this test only exercises the workbench
// shell (tabs / visibility / toggle).  Each replacement renders a
// data-attributed marker we can assert on.  vitest resolves these
// paths relative to the test file, NOT relative to the module under
// test — that's why "../components/..." not "./...".
vi.mock("../components/FileExplorerPanel", () => ({
  FileExplorerPanel: () => <div data-testid="file-explorer-stub">files</div>,
}));
vi.mock("../components/AgentContextPanel", () => ({
  AgentContextPanel: () => <div data-testid="agent-context-stub">context</div>,
}));
vi.mock("../components/GitPanel", () => ({
  GitPanel: () => <div data-testid="git-panel-stub">git</div>,
}));
vi.mock("../components/WorkbenchNotes", () => ({
  WorkbenchNotes: () => <div data-testid="workbench-notes">notes</div>,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { WorkbenchPanel } from "../components/WorkbenchPanel";
import type { SessionData } from "../types/session";

function agentSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: "s1",
    label: "test-session",
    mode: "agent",
    phase: "idle",
    workspace_paths: [],
    ai_provider: null,
    ...overrides,
  } as unknown as SessionData;
}

function terminalSession(): SessionData {
  return {
    id: "s2",
    label: "term",
    mode: "terminal",
    phase: "idle",
    workspace_paths: [],
    ai_provider: null,
  } as unknown as SessionData;
}

afterEach(() => {
  cleanup();
  dispatchMock.mockClear();
  fakeWb.ui.workbench = { open: true, tab: "files", ratio: 0.5, filesNotesSplit: 0.7 };
  fakeWb.notes = {};
});

describe("WorkbenchPanel · render-gating", () => {
  it("returns null for terminal-mode sessions", () => {
    const { container } = render(<WorkbenchPanel session={terminalSession()} />);
    expect(container.querySelector("[data-testid='workbench-panel']")).toBeNull();
  });

  it("returns null when no session is active", () => {
    const { container } = render(<WorkbenchPanel session={null} />);
    expect(container.querySelector("[data-testid='workbench-panel']")).toBeNull();
  });

  it("returns null when workbench is closed", () => {
    fakeWb.ui.workbench.open = false;
    const { container } = render(<WorkbenchPanel session={agentSession()} />);
    expect(container.querySelector("[data-testid='workbench-panel']")).toBeNull();
  });

  it("mounts for an agent session when open", () => {
    const { container } = render(<WorkbenchPanel session={agentSession()} />);
    expect(container.querySelector("[data-testid='workbench-panel']")).toBeTruthy();
  });
});

describe("WorkbenchPanel · tabs", () => {
  // testing-library skips elements behind `hidden` when querying by
  // role, so we look up the bodies directly via aria-label.  The
  // `hidden` attribute is what we're verifying, so the assertion has
  // to read it off the element regardless of its semantic visibility.
  function getTabBody(name: string): HTMLElement {
    const all = document.querySelectorAll<HTMLElement>("[role='tabpanel']");
    for (const el of Array.from(all)) {
      if (el.getAttribute("aria-label") === name) return el;
    }
    throw new Error(`tabpanel '${name}' not found`);
  }

  it("shows the Files tab by default and the body is visible", () => {
    render(<WorkbenchPanel session={agentSession()} />);
    expect(getTabBody("Files")).not.toHaveAttribute("hidden");
    expect(getTabBody("Context")).toHaveAttribute("hidden");
  });

  it("clicking the Context tab dispatches SET_WORKBENCH_TAB", () => {
    render(<WorkbenchPanel session={agentSession()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Context" }));
    const dispatched = dispatchMock.mock.calls.map((c) => c[0]);
    expect(dispatched).toContainEqual({ type: "SET_WORKBENCH_TAB", tab: "context" });
  });

  it("when state.ui.workbench.tab is 'context', the Context panel is visible", () => {
    fakeWb.ui.workbench.tab = "context";
    render(<WorkbenchPanel session={agentSession()} />);
    expect(getTabBody("Files")).toHaveAttribute("hidden");
    expect(getTabBody("Context")).not.toHaveAttribute("hidden");
  });

  it("Notes section renders regardless of active tab (always pinned to bottom)", () => {
    render(<WorkbenchPanel session={agentSession()} />);
    expect(screen.getByTestId("workbench-notes")).toBeInTheDocument();

    fakeWb.ui.workbench.tab = "context";
    cleanup();
    render(<WorkbenchPanel session={agentSession()} />);
    expect(screen.getByTestId("workbench-notes")).toBeInTheDocument();
  });
});

describe("WorkbenchPanel · close button", () => {
  it("dispatches SET_WORKBENCH_OPEN { open: false } when clicked", () => {
    render(<WorkbenchPanel session={agentSession()} />);
    fireEvent.click(screen.getByRole("button", { name: /close workbench/i }));
    const dispatched = dispatchMock.mock.calls.map((c) => c[0]);
    expect(dispatched).toContainEqual({ type: "SET_WORKBENCH_OPEN", open: false });
  });
});

describe("WorkbenchPanel · session pill", () => {
  it("displays the session label in the pill", () => {
    const sess = agentSession({ label: "auth-refactor" } as Partial<SessionData>);
    const { container } = render(<WorkbenchPanel session={sess} />);
    const pill = container.querySelector(".workbench-session-pill");
    expect(pill?.textContent).toContain("auth-refactor");
  });

  it("falls back to a truncated session id when no label is set", () => {
    const sess = {
      ...agentSession(),
      id: "abcdef0123456789",
      label: "",
    } as SessionData;
    const { container } = render(<WorkbenchPanel session={sess} />);
    const pill = container.querySelector(".workbench-session-pill");
    // First 8 chars of the id appear inside the pill.
    expect(pill?.textContent).toContain("abcdef01");
  });
});
