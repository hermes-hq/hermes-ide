// @vitest-environment jsdom
/**
 * A restored Agent-view session whose first start fails keeps its
 * conversation id: Retry resumes that conversation, and the next save
 * still holds the id. The id used to be remembered only once the start
 * succeeded, so Retry began a fresh conversation (the earlier one still on
 * screen) and the save forgot it.
 *
 * SessionProvider against a faked backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => unknown;
const listeners = new Map<string, Handler[]>();
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let settings: Record<string, string> = {};

const ID = "55555555-5555-4555-8555-555555555555";
const CONVERSATION = "66666666-6666-4666-8666-666666666666";

function session(id: string, label: string) {
  return {
    id, label, color: "#888888", group: null, phase: "idle", working_directory: "/work/project",
    shell: "zsh", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z",
    workspace_paths: [], detected_agent: null, ai_provider: "claude", context_injected: false, mode: "agent",
    metrics: {
      output_lines: 0, error_count: 0, stuck_score: 0, token_usage: {}, tool_calls: [], tool_call_summary: {},
      files_touched: [], recent_errors: [], recent_actions: [], available_actions: [], memory_facts: [],
      latency_p50_ms: null, latency_p95_ms: null, latency_samples: [], token_history: [],
    },
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "get_settings":
        return { ...settings };
      case "get_sessions":
        return [];
      case "create_session":
        return session(args.sessionId as string, args.label as string);
      case "spawn_agent_session":
        throw new Error("node was not found");
      case "restart_agent_session":
        return (args.priorUuid as string | undefined) ?? "77777777-7777-4777-8777-777777777777";
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
vi.mock("../utils/agentSpawnFailure", () => ({ reportAgentSpawnFailure: vi.fn(async () => {}) }));
vi.mock("../utils/themeManager", () => ({ applyTheme: vi.fn(), applyAgentTimelineStyle: vi.fn() }));
vi.mock("../utils/windowState", () => ({ restoreWindowState: vi.fn(async () => {}) }));
vi.mock("../utils/notifications", () => ({ initNotifications: vi.fn(async () => {}), notifyLongRunningDone: vi.fn() }));
vi.mock("../utils/analytics", () => ({ initAnalytics: vi.fn(async () => {}), trackAppStarted: vi.fn(), trackSessionCreated: vi.fn() }));

const SAVED = JSON.stringify({
  version: 2,
  sessions: [{
    id: ID, label: "Claude", color: "#888888", group: null, working_directory: "/work/project",
    ai_provider: "claude", project_ids: [], mode: "agent", claude_session_uuid: CONVERSATION,
  }],
  layout: null,
  focused_pane_id: null,
  active_session_id: ID,
});

async function flushAll() {
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
}

describe("a restored Agent-view session whose first start fails", () => {
  beforeEach(() => {
    vi.resetModules();
    listeners.clear();
    calls.length = 0;
    settings = { saved_workspace: SAVED, restore_sessions: "always" };
  });
  afterEach(() => {
    cleanup();
  });

  it("keeps its conversation id for Retry and for the next save", async () => {
    const { SessionProvider, useSession } = await import("../state/SessionContext");
    let ctx: ReturnType<typeof useSession> | null = null;
    function Grab() {
      ctx = useSession();
      return null;
    }
    render(<SessionProvider><Grab /></SessionProvider>);
    await flushAll();

    const spawn = calls.find((c) => c.cmd === "spawn_agent_session");
    expect(spawn?.args.priorUuid).toBe(CONVERSATION);

    await act(async () => { await ctx!.saveWorkspace(); });
    expect(JSON.parse(settings.saved_workspace).sessions[0].claude_session_uuid).toBe(CONVERSATION);

    await act(async () => { await ctx!.respawnAgent(ID); });
    const restart = calls.find((c) => c.cmd === "restart_agent_session");
    expect(restart?.args.priorUuid).toBe(CONVERSATION);
  });
});
