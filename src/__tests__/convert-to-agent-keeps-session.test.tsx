// @vitest-environment jsdom
/**
 * Convert to agent on a terminal Claude session keeps the session.
 *
 * The conversion used to close the session with close_session, which
 * removes it from the app (session-removed) and deletes its worktree with
 * every uncommitted file in it. The session vanished from the sidebar while
 * its agent started anyway, with no pane. Now only the terminal is stopped:
 * the session stays, in Agent view, and close_session never runs.
 *
 * SessionProvider against a faked backend that behaves like the real one:
 * close_session reports the session destroyed and removed; stopping the
 * terminal reports it destroyed once the terminal has closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import type { SessionMode } from "../types/session";

type Handler = (event: { payload: unknown }) => unknown;
const listeners = new Map<string, Handler[]>();
const calls: string[] = [];

const ID = "33333333-3333-4333-8333-333333333333";

function fire(name: string, payload: unknown) {
  for (const h of listeners.get(name) ?? []) h({ payload });
}

function session(phase: string) {
  return {
    id: ID, label: "Claude", description: "", color: "#888888", group: null, phase,
    working_directory: "/work/project", shell: "bash", created_at: "2026-01-01T00:00:00Z",
    last_activity_at: "2026-01-01T00:00:00Z", workspace_paths: [], detected_agent: null,
    ai_provider: "claude", auto_approve: false, permission_mode: "default", custom_prefix: "",
    custom_suffix: "", channels: [], context_injected: false, ssh_info: null, mode: "terminal",
    metrics: {
      output_lines: 0, error_count: 0, stuck_score: 0, token_usage: {}, tool_calls: [], tool_call_summary: {},
      files_touched: [], recent_errors: [], recent_actions: [], available_actions: [], memory_facts: [],
      latency_p50_ms: null, latency_p95_ms: null, latency_samples: [], token_history: [],
    },
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    calls.push(cmd);
    switch (cmd) {
      case "get_settings":
        return { restore_sessions: "never" };
      case "close_session":
        // What the Rust command emits.
        fire("session-updated", session("destroyed"));
        fire("session-removed", ID);
        return null;
      case "stop_session_terminal":
        // The terminal's reader reports the end a moment later.
        setTimeout(() => fire("session-updated", session("destroyed")), 5);
        return null;
      case "spawn_agent_session":
        return "44444444-4444-4444-8444-444444444444";
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
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("../utils/themeManager", () => ({ applyTheme: vi.fn(), applyAgentTimelineStyle: vi.fn() }));
vi.mock("../utils/windowState", () => ({ restoreWindowState: vi.fn(async () => {}) }));
vi.mock("../utils/notifications", () => ({ initNotifications: vi.fn(async () => {}), notifyLongRunningDone: vi.fn() }));
vi.mock("../utils/analytics", () => ({ initAnalytics: vi.fn(async () => {}), trackAppStarted: vi.fn(), trackSessionCreated: vi.fn() }));

async function flushAll() {
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
}

describe("Convert to agent keeps the session", () => {
  beforeEach(() => {
    vi.resetModules();
    listeners.clear();
    calls.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("stays in the app in Agent view, and close_session (which deletes the worktree) never runs", async () => {
    const { SessionProvider, useSession, ENDED_BURST_MS } = await import("../state/SessionContext");
    let ctx: ReturnType<typeof useSession> | null = null;
    function Grab() {
      ctx = useSession();
      return null;
    }
    render(<SessionProvider><Grab /></SessionProvider>);
    await flushAll();

    await act(async () => { fire("session-updated", session("idle")); });
    expect(ctx!.state.sessions[ID]?.mode).toBe("terminal");

    let ok = false;
    await act(async () => {
      ok = await ctx!.convertSessionMode(ID, "agent" as SessionMode);
    });
    // Past the reader's late report and the ended-session wait.
    await act(async () => { await new Promise((r) => setTimeout(r, ENDED_BURST_MS + 200)); });
    await flushAll();

    expect(ok).toBe(true);
    expect(calls).toContain("spawn_agent_session");
    expect(ctx!.state.sessions[ID]?.mode).toBe("agent");
    expect(calls).not.toContain("close_session");
  }, 10_000);
});
