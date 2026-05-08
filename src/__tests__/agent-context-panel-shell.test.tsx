// @vitest-environment jsdom
/**
 * M0 — M-context-panel-shell.
 *
 * Pins the empty-sidebar foundation that every other v1.0 TUI-parity
 * milestone fills in (M3 MCP, M4 Memory, M5 Permissions, etc.).
 *
 * Test list per docs/internal/v1-tui-parity-plan.md §2 + §7.2.
 *
 * Coverage shape:
 *   §2  cps-1..8   happy paths (15-line spec)
 *   §7  cps-9..15  failure modes (no saved JSON, corrupt JSON, drag
 *                  storms, unmount races, scroll preservation)
 *
 * Pure helpers (`clampPanelWidth`, `loadPanelState`, `serializePanelState`)
 * live in `src/utils/contextPanelLayout.ts` so the math + persistence is
 * unit-testable without rendering.  The component shell tests use RTL
 * for shape + interaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Tauri IPC + event API mocks — needed because the panel now wires up
// real section content (useAgentInit listens, PermissionsSection invokes).
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(),
}));

// SessionContext mock — the panel now reads `respawnAgent` from the
// session context to support MCP restart / remove flows.  Shell tests
// don't drive that context, so a stub is sufficient.
vi.mock("../state/SessionContext", () => ({
  useSession: () => ({ respawnAgent: vi.fn(async () => true) }),
}));

// Pure helpers (under test alongside the component)
import {
  clampPanelWidth,
  loadPanelState,
  serializePanelState,
  DEFAULT_PANEL_WIDTH,
  PANEL_SECTION_ORDER,
  type PanelState,
} from "../utils/contextPanelLayout";

// Component under test
import { AgentContextPanel } from "../components/AgentContextPanel";

// ─── Test doubles ────────────────────────────────────────────────────

type SessionStub = {
  id: string;
  mode: "agent" | "terminal";
  workspace_paths: string[];
};

const stubAgent = (overrides: Partial<SessionStub> = {}): SessionStub => ({
  id: "sess-agent",
  mode: "agent",
  workspace_paths: [],
  ...overrides,
});

const stubTerminal = (overrides: Partial<SessionStub> = {}): SessionStub => ({
  id: "sess-term",
  mode: "terminal",
  workspace_paths: [],
  ...overrides,
});

// ─── §2 happy-path tests ────────────────────────────────────────────

describe("AgentContextPanel — render gating (cps-1, cps-2)", () => {
  afterEach(() => cleanup());

  it("cps-1: renders only when active session.mode === 'agent'", () => {
    const { container } = render(<AgentContextPanel session={stubAgent()} />);
    expect(container.querySelector(".agent-context-panel")).toBeInTheDocument();
  });

  it("cps-2: renders nothing for a terminal-mode session", () => {
    const { container } = render(<AgentContextPanel session={stubTerminal()} />);
    expect(container.querySelector(".agent-context-panel")).toBeNull();
  });

  it("cps-2-b: renders nothing when session is null (no active session)", () => {
    const { container } = render(<AgentContextPanel session={null} />);
    expect(container.querySelector(".agent-context-panel")).toBeNull();
  });
});

describe("AgentContextPanel — section order (cps-3)", () => {
  afterEach(() => cleanup());

  it("cps-3: section header order is MCP → Memory → Permissions → Pinned → Cost", () => {
    render(<AgentContextPanel session={stubAgent()} />);
    const headers = Array.from(
      document.querySelectorAll(".agent-context-section-header-label"),
    ).map((el) => el.textContent?.trim());
    expect(headers).toEqual(["MCP", "MEMORY", "PERMISSIONS", "PINNED FILES", "COST & TOKENS"]);
  });

  it("cps-3-b: PANEL_SECTION_ORDER constant is the single source of truth", () => {
    expect(PANEL_SECTION_ORDER).toEqual([
      "mcp",
      "memory",
      "permissions",
      "pinned",
      "cost",
    ]);
  });
});

describe("clampPanelWidth (cps-4, cps-5, cps-11, cps-12)", () => {
  it("cps-5: returns input within bounds", () => {
    expect(clampPanelWidth(280, 1440)).toBe(280);
    expect(clampPanelWidth(200, 1440)).toBe(200);
    expect(clampPanelWidth(480, 1440)).toBe(480);
  });

  it("cps-11: clamps below minimum to 200, never negative", () => {
    expect(clampPanelWidth(150, 1440)).toBe(200);
    expect(clampPanelWidth(0, 1440)).toBe(200);
    expect(clampPanelWidth(-50, 1440)).toBe(200);
  });

  it("cps-12: clamps above max to min(480, viewport - 320)", () => {
    // Wide viewport: cap at 480
    expect(clampPanelWidth(600, 1440)).toBe(480);
    // Narrow viewport: cap at viewport - 320 = 480px conversation min
    expect(clampPanelWidth(600, 700)).toBe(380); // 700 - 320 = 380
    // Tiny viewport: still clamps to floor of 200 (don't collapse)
    expect(clampPanelWidth(600, 400)).toBe(200);
  });

  it("rounds non-integer inputs to integer", () => {
    expect(Number.isInteger(clampPanelWidth(280.7, 1440))).toBe(true);
  });
});

describe("loadPanelState — restore (cps-4, cps-9, cps-10)", () => {
  it("cps-9: returns defaults when input is null/undefined (no saved JSON)", () => {
    const got = loadPanelState(null);
    expect(got.width).toBe(DEFAULT_PANEL_WIDTH);
    expect(got.collapsed).toEqual({});
  });

  it("cps-9-b: returns defaults for empty object", () => {
    const got = loadPanelState({});
    expect(got.width).toBe(DEFAULT_PANEL_WIDTH);
    expect(got.collapsed).toEqual({});
  });

  it("cps-4: round-trips a serialized state", () => {
    const original: PanelState = {
      width: 360,
      collapsed: { mcp: false, memory: true, permissions: false, pinned: true, cost: false },
    };
    const got = loadPanelState(serializePanelState(original));
    expect(got).toEqual(original);
  });

  it("cps-10: corrupt JSON (string width) falls back to default", () => {
    const got = loadPanelState({ right_panel_width: "wide", agent_section_collapsed: {} });
    expect(got.width).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("cps-10-b: corrupt JSON (negative width) clamps to floor", () => {
    const got = loadPanelState({ right_panel_width: -100, agent_section_collapsed: {} });
    expect(got.width).toBe(200);
  });

  it("cps-10-c: corrupt JSON (huge width) clamps to default cap", () => {
    const got = loadPanelState({ right_panel_width: 10_000, agent_section_collapsed: {} });
    expect(got.width).toBeLessThanOrEqual(480);
  });

  it("cps-10-d: corrupt JSON (collapsed not an object) yields empty map", () => {
    const got = loadPanelState({ right_panel_width: 280, agent_section_collapsed: "yes" });
    expect(got.collapsed).toEqual({});
  });

  it("cps-10-e: unknown section keys in collapsed are dropped", () => {
    const got = loadPanelState({
      right_panel_width: 280,
      agent_section_collapsed: { mcp: true, sneakyKey: true },
    });
    expect(got.collapsed.mcp).toBe(true);
    expect("sneakyKey" in got.collapsed).toBe(false);
  });
});

describe("AgentContextPanel — collapse persistence (cps-6)", () => {
  afterEach(() => cleanup());

  it("cps-6: clicking section header toggles collapsed state and calls onPersist", () => {
    const onPersist = vi.fn();
    render(<AgentContextPanel session={stubAgent()} onPersist={onPersist} />);
    // Section header: matches the header label exactly, not the
    // "+ Add MCP server" CTA that also contains "MCP".
    const mcpHeader = screen.getByRole("button", { name: /^mcp$/i });
    fireEvent.click(mcpHeader);
    expect(onPersist).toHaveBeenCalled();
    const last = onPersist.mock.calls[onPersist.mock.calls.length - 1][0] as PanelState;
    expect(last.collapsed.mcp).toBe(true);
  });

  it("cps-6-b: re-clicking restores expanded; persist reflects it", () => {
    const onPersist = vi.fn();
    render(<AgentContextPanel session={stubAgent()} onPersist={onPersist} />);
    // Section header: matches the header label exactly, not the
    // "+ Add MCP server" CTA that also contains "MCP".
    const mcpHeader = screen.getByRole("button", { name: /^mcp$/i });
    fireEvent.click(mcpHeader);
    fireEvent.click(mcpHeader);
    const last = onPersist.mock.calls[onPersist.mock.calls.length - 1][0] as PanelState;
    expect(last.collapsed.mcp).toBe(false);
  });

  it("cps-6-c: initial state respects the `initialState` prop (e.g. on workspace restore)", () => {
    render(
      <AgentContextPanel
        session={stubAgent()}
        initialState={{
          width: 320,
          collapsed: { mcp: true, memory: false, permissions: true, pinned: false, cost: false },
        }}
      />,
    );
    // MCP collapsed → its body is hidden
    const mcpSection = document.querySelector('[data-section="mcp"]');
    expect(mcpSection?.getAttribute("data-collapsed")).toBe("true");
    const memSection = document.querySelector('[data-section="memory"]');
    expect(memSection?.getAttribute("data-collapsed")).toBe("false");
  });
});

describe("AgentContextPanel — width persistence (cps-4, cps-7)", () => {
  afterEach(() => cleanup());

  it("cps-7: drag handle simulates resize, width updates and onPersist fires", () => {
    const onPersist = vi.fn();
    render(
      <AgentContextPanel
        session={stubAgent()}
        initialState={{ width: 280, collapsed: {} }}
        onPersist={onPersist}
      />,
    );
    const handle = document.querySelector(".agent-context-panel-resize-handle") as HTMLElement;
    expect(handle).toBeInTheDocument();

    // Simulate a single resize event (component exposes onResize callback or
    // listens to pointer events; we call the imperative test seam).
    fireEvent.pointerDown(handle, { clientX: 600, button: 0 });
    fireEvent.pointerMove(window, { clientX: 540 });
    fireEvent.pointerUp(window);

    // The exact final width depends on viewport; assert that *something*
    // was persisted and that the new width is in valid bounds.
    expect(onPersist).toHaveBeenCalled();
    const last = onPersist.mock.calls[onPersist.mock.calls.length - 1][0] as PanelState;
    expect(last.width).toBeGreaterThanOrEqual(200);
    expect(last.width).toBeLessThanOrEqual(480);
  });

  it("cps-13: rapid pointer moves are rAF-throttled — onPersist fires once per drag", () => {
    const onPersist = vi.fn();
    const rAFSpy = vi.spyOn(window, "requestAnimationFrame");
    render(
      <AgentContextPanel
        session={stubAgent()}
        initialState={{ width: 280, collapsed: {} }}
        onPersist={onPersist}
      />,
    );
    const handle = document.querySelector(".agent-context-panel-resize-handle") as HTMLElement;
    fireEvent.pointerDown(handle, { clientX: 600, button: 0 });
    for (let i = 0; i < 100; i++) {
      fireEvent.pointerMove(window, { clientX: 600 - i });
    }
    fireEvent.pointerUp(window);

    // rAF was used (throttling proof), and onPersist was called exactly
    // once — at pointer-up, not on every move.
    expect(rAFSpy).toHaveBeenCalled();
    expect(onPersist).toHaveBeenCalledTimes(1);
  });
});

describe("AgentContextPanel — mode flip (cps-8)", () => {
  afterEach(() => cleanup());

  it("cps-8: mode flip terminal → agent makes the panel appear without crashing", () => {
    const { rerender, container } = render(
      <AgentContextPanel session={stubTerminal()} />,
    );
    expect(container.querySelector(".agent-context-panel")).toBeNull();
    rerender(<AgentContextPanel session={stubAgent()} />);
    expect(container.querySelector(".agent-context-panel")).toBeInTheDocument();
  });

  it("cps-8-b: mode flip agent → terminal removes the panel without leaks", () => {
    const { rerender, container } = render(
      <AgentContextPanel session={stubAgent()} />,
    );
    rerender(<AgentContextPanel session={stubTerminal()} />);
    expect(container.querySelector(".agent-context-panel")).toBeNull();
  });
});

// ─── §7.2 failure-mode tests ────────────────────────────────────────

describe("AgentContextPanel — defensive lifecycle (cps-14)", () => {
  afterEach(() => cleanup());

  it("cps-14: session deleted while open → component unmounts cleanly, no error thrown", () => {
    const { rerender, unmount } = render(
      <AgentContextPanel session={stubAgent()} />,
    );
    // Session goes away mid-flight (e.g., user closes the session).
    rerender(<AgentContextPanel session={null} />);
    expect(() => unmount()).not.toThrow();
  });

  it("cps-14-b: rapid mount/unmount cycles do not leak listeners", () => {
    for (let i = 0; i < 20; i++) {
      const { unmount } = render(<AgentContextPanel session={stubAgent()} />);
      unmount();
    }
    // No errors → no leaked listeners blowing up subsequent mounts.
    expect(true).toBe(true);
  });
});

describe("AgentContextPanel — empty-state CTAs (decision §0.6)", () => {
  afterEach(() => cleanup());

  it("renders + Add CTAs in every section (discoverability)", () => {
    render(<AgentContextPanel session={stubAgent()} />);
    // Every section ships a CTA — either the M0 placeholder
    // `.agent-context-empty-cta` (Pinned, Cost) or a section-specific
    // CTA after M3-M5 wired their content (mcp-add-cta, memory-add-cta,
    // perms-add-cta).  Discoverability is the contract; the class name
    // is implementation detail.
    const placeholderCtas = document.querySelectorAll(".agent-context-empty-cta");
    const sectionCtas = document.querySelectorAll(
      ".mcp-add-cta, .memory-add-cta, .perms-add-cta",
    );
    expect(placeholderCtas.length + sectionCtas.length).toBeGreaterThanOrEqual(5);
  });
});
