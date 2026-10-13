// @vitest-environment jsdom
/**
 * A launcher task's extra folders are the only folders a terminal Claude
 * gets as --add-dir, across a restart: they are saved as
 * `launcher_extra_dirs` and handed back to create_session as `extraDirs`.
 * Projects attached later (`workspace_paths`, saved as `agent_add_dirs` for
 * the Agent view) never become a terminal agent's --add-dir, and a save made
 * before the field existed restores with none.
 *
 * SessionProvider against a faked backend. Every path here is made up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let settings: Record<string, string> = {};

const ID = "88888888-8888-4888-8888-888888888888";
const EXTRA = "/fixture-home/code/plugins";
const ATTACHED = "/fixture-home/code/atlas";

function session(args: Record<string, unknown>) {
  const extra = (args.extraDirs as string[] | null) ?? [];
  return {
    id: args.sessionId, label: args.label, color: "#888888", group: null, phase: "idle", working_directory: "/fixture-home/code/atlas-wt",
    shell: "zsh", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z",
    workspace_paths: (args.workspacePaths as string[] | null) ?? [], detected_agent: null, ai_provider: "claude", context_injected: false,
    mode: args.mode ?? "terminal",
    // The backend leaves the field out when there are none.
    ...(extra.length > 0 ? { extra_dirs: extra } : {}),
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
        return session(args);
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
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
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

const saved = (extra: Record<string, unknown>) =>
  JSON.stringify({
    version: 2,
    sessions: [{
      id: ID, label: "Claude", color: "#888888", group: null, working_directory: "/fixture-home/code/atlas-wt",
      ai_provider: "claude", project_ids: [], mode: "terminal", agent_add_dirs: [ATTACHED], ...extra,
    }],
    layout: null,
    focused_pane_id: null,
    active_session_id: ID,
  });

async function flushAll() {
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
}

async function restoreAndSave() {
  const { SessionProvider, useSession } = await import("../state/SessionContext");
  let ctx: ReturnType<typeof useSession> | null = null;
  function Grab() {
    ctx = useSession();
    return null;
  }
  render(<SessionProvider><Grab /></SessionProvider>);
  await flushAll();
  const created = calls.find((c) => c.cmd === "create_session")!.args;
  await act(async () => { await ctx!.saveWorkspace(); });
  return { created, resaved: JSON.parse(settings.saved_workspace).sessions[0] };
}

describe("a terminal Claude's launcher extra folders across a restart", () => {
  beforeEach(() => {
    vi.resetModules();
    calls.length = 0;
  });
  afterEach(() => cleanup());

  it("are restored as extraDirs and saved again; attached folders are not", async () => {
    settings = { saved_workspace: saved({ launcher_extra_dirs: [EXTRA] }), restore_sessions: "always" };
    const { created, resaved } = await restoreAndSave();
    expect(created.extraDirs).toEqual([EXTRA]);
    expect(created.workspacePaths).toBeNull();
    expect(resaved.launcher_extra_dirs).toEqual([EXTRA]);
  });

  it("an older save without the field restores with no extra folders", async () => {
    settings = { saved_workspace: saved({}), restore_sessions: "always" };
    const { created, resaved } = await restoreAndSave();
    expect(created.extraDirs).toBeNull();
    expect(created.workspacePaths).toBeNull();
    expect(resaved.launcher_extra_dirs).toBeUndefined();
  });
});
