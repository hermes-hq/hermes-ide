// @vitest-environment jsdom
/**
 * A restored split layout focuses the pane of the active session. It used
 * to focus the first pane whatever was active, so with B active on the
 * right, the left pane (A) took the keyboard and the pane actions while
 * the sidebar and composer showed B.
 *
 * SessionProvider against a faked backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => unknown;
const listeners = new Map<string, Handler[]>();
let settings: Record<string, string> = {};

const A = "88888888-8888-4888-8888-888888888881";
const B = "88888888-8888-4888-8888-888888888882";

function session(id: string, label: string) {
  return {
    id, label, color: "#888888", group: null, phase: "idle", working_directory: "/work/project",
    shell: "zsh", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z",
    workspace_paths: [], detected_agent: null, ai_provider: null, context_injected: false, mode: "terminal",
    metrics: {
      output_lines: 0, error_count: 0, stuck_score: 0, token_usage: {}, tool_calls: [], tool_call_summary: {},
      files_touched: [], recent_errors: [], recent_actions: [], available_actions: [], memory_facts: [],
      latency_p50_ms: null, latency_p95_ms: null, latency_samples: [], token_history: [],
    },
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    switch (cmd) {
      case "get_settings":
        return { ...settings };
      case "get_sessions":
        return [];
      case "create_session":
        return session(args.sessionId as string, args.label as string);
      case "set_setting":
        settings[args.key as string] = args.value as string;
        return null;
      case "get_session_snapshot":
        return null;
      default:
        return [];
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    return () => listeners.set(name, (listeners.get(name) ?? []).filter((h) => h !== handler));
  }),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn(() => ({})) }));
vi.mock("../terminal/TerminalPool", () => ({
  createTerminal: vi.fn(async () => {}),
  destroy: vi.fn(),
  writeScrollback: vi.fn(),
  releaseOutput: vi.fn(),
  estimateInitialDimensions: vi.fn(() => ({ rows: 24, cols: 80 })),
  updateSettings: vi.fn(),
  focusTerminal: vi.fn(),
  refitActive: vi.fn(),
}));
vi.mock("../utils/themeManager", () => ({ applyTheme: vi.fn(), applyAgentTimelineStyle: vi.fn() }));
vi.mock("../utils/windowState", () => ({ restoreWindowState: vi.fn(async () => {}) }));
vi.mock("../utils/notifications", () => ({ initNotifications: vi.fn(async () => {}), notifyLongRunningDone: vi.fn() }));
vi.mock("../utils/analytics", () => ({ initAnalytics: vi.fn(async () => {}), trackAppStarted: vi.fn(), trackSessionCreated: vi.fn() }));

function saved(active: string | null) {
  return JSON.stringify({
    version: 2,
    // Listed in another order than the panes: B first, A on the left.
    sessions: [B, A].map((id, i) => ({
      id, label: `S${i}`, color: "#888888", group: null, working_directory: "/work/project", ai_provider: null, project_ids: [],
    })),
    layout: {
      type: "split", id: "split-old", direction: "horizontal", ratio: 0.5,
      children: [{ type: "pane", id: "pane-old-a", sessionId: A }, { type: "pane", id: "pane-old-b", sessionId: B }],
    },
    focused_pane_id: "pane-old-b",
    active_session_id: active,
  });
}

async function flushAll() {
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
}

async function restore() {
  const { SessionProvider, useSession } = await import("../state/SessionContext");
  const { collectPanes } = await import("../state/layoutTypes");
  let ctx: ReturnType<typeof useSession> | null = null;
  function Grab() {
    ctx = useSession();
    return null;
  }
  render(<SessionProvider><Grab /></SessionProvider>);
  await flushAll();
  const { layout, activeSessionId } = ctx!.state;
  const focused = collectPanes(layout.root!).find((p) => p.id === layout.focusedPaneId);
  return { focusedSession: focused?.sessionId, activeSessionId };
}

describe("a restored split layout", () => {
  beforeEach(() => {
    vi.resetModules();
    listeners.clear();
  });
  afterEach(() => {
    cleanup();
  });

  it("focuses the pane of the active session, not the first pane", async () => {
    settings = { saved_workspace: saved(B), restore_sessions: "always" };
    const { focusedSession, activeSessionId } = await restore();
    expect(activeSessionId).toBe(B);
    expect(focusedSession).toBe(B);
  });

  it("with no active session saved, the active session is the focused pane's", async () => {
    settings = { saved_workspace: saved(null), restore_sessions: "always" };
    const { focusedSession, activeSessionId } = await restore();
    expect(focusedSession).toBeDefined();
    expect(activeSessionId).toBe(focusedSession);
  });
});
