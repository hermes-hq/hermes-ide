// @vitest-environment jsdom
/**
 * Sessions are never lost on quit (SessionProvider against a faked backend):
 *   - a restore never clears the saved workspace; the restored workspace is
 *     written again right away;
 *   - a quit asks the frontend to write the latest workspace, and the
 *     frontend answers once it is written (even when the save fails);
 *   - a save asked for before the launch's restore has settled writes nothing;
 *   - a launch that restores no session (every session fails to start,
 *     unreadable data, restore turned off) never writes an empty workspace
 *     over the saved one, until a session exists in this run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => unknown;
const listeners = new Map<string, Handler[]>();
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let settings: Record<string, string> = {};
let setSettingGate: Promise<void> | null = null;
let failSetSetting = false;
let failCreateSession = false;

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
    calls.push({ cmd, args });
    switch (cmd) {
      case "get_settings":
        return { ...settings };
      case "get_sessions":
        return [];
      case "create_session":
        if (failCreateSession) throw new Error("the shell could not start");
        return session(args.sessionId as string, args.label as string);
      case "set_setting":
        if (setSettingGate) await setSettingGate;
        if (failSetSetting) throw new Error("disk full");
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

/** Saved ids that are UUIDs are restored under the same id. */
const KEEP_ID = "11111111-1111-4111-8111-111111111111";
const SAVED = JSON.stringify({
  version: 2,
  sessions: [{ id: KEEP_ID, label: "Keep me", color: "#888888", group: null, working_directory: "/work/project", ai_provider: null, project_ids: [] }],
  layout: null,
  focused_pane_id: null,
  active_session_id: KEEP_ID,
});

const workspaceWrites = () =>
  calls.filter((c) => c.cmd === "set_setting" && c.args.key === "saved_workspace").map((c) => c.args.value as string);

async function fire(name: string, payload: unknown) {
  await Promise.all((listeners.get(name) ?? []).map((h) => h({ payload })));
}

async function flushAll() {
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
}

/** A fresh module graph: SessionContext keeps launch state at module level. */
async function mountProvider() {
  const { SessionProvider } = await import("../state/SessionContext");
  render(<SessionProvider><div /></SessionProvider>);
  await flushAll();
}

describe("sessions are never lost on quit", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listeners.clear();
    calls.length = 0;
    settings = { saved_workspace: SAVED, restore_sessions: "always" };
    setSettingGate = null;
    failSetSetting = false;
    failCreateSession = false;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("restores without clearing the saved workspace, then writes the restored one right away", async () => {
    await mountProvider();
    expect(calls.some((c) => c.cmd === "create_session" && c.args.sessionId === KEEP_ID)).toBe(true);
    // Nothing has cleared it, even for a moment.
    expect(workspaceWrites()).not.toContain("");
    expect(settings.saved_workspace).toContain(KEEP_ID);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAll();
    const writes = workspaceWrites();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.includes(KEEP_ID))).toBe(true);
    expect(JSON.parse(settings.saved_workspace).sessions.map((s: { id: string }) => s.id)).toEqual([KEEP_ID]);
  });

  it("answers a quit only after the latest workspace is written", async () => {
    await mountProvider();
    expect(calls.some((c) => c.cmd === "workspace_flush_ready")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAll();
    calls.length = 0;

    let open!: () => void;
    setSettingGate = new Promise((r) => { open = r; });
    const flushing = fire("workspace-flush-requested", 7);
    await flushAll();
    expect(calls.some((c) => c.cmd === "set_setting")).toBe(true);
    expect(calls.some((c) => c.cmd === "workspace_flush_done")).toBe(false);

    open();
    await flushing;
    await flushAll();
    const order = calls.map((c) => c.cmd);
    expect(order.lastIndexOf("set_setting")).toBeLessThan(order.indexOf("workspace_flush_done"));
    expect(calls.find((c) => c.cmd === "workspace_flush_done")?.args).toEqual({ id: 7 });
  });

  it("still answers a quit when the save fails", async () => {
    await mountProvider();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAll();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    failSetSetting = true;
    await fire("workspace-flush-requested", 3);
    await flushAll();
    expect(calls.find((c) => c.cmd === "workspace_flush_done")?.args).toEqual({ id: 3 });
    error.mockRestore();
  });

  it("writes nothing when a quit comes before the restore has settled", async () => {
    // The restore hangs on its first session: the launch is not loaded yet.
    const { invoke } = await import("@tauri-apps/api/core");
    const real = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "create_session") return new Promise(() => {});
      return real(cmd, args);
    });
    try {
      await mountProvider();
      await fire("workspace-flush-requested", 1);
      await flushAll();
      expect(calls.find((c) => c.cmd === "workspace_flush_done")?.args).toEqual({ id: 1 });
      expect(workspaceWrites()).toEqual([]);
      expect(settings.saved_workspace).toBe(SAVED);
    } finally {
      vi.mocked(invoke).mockImplementation(real);
    }
  });

  /** Let the save after load run, then quit: what a person does next. */
  async function settleAndQuit(id: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAll();
    await fire("workspace-flush-requested", id);
    await flushAll();
    expect(calls.find((c) => c.cmd === "workspace_flush_done")?.args).toEqual({ id });
  }

  it("keeps the saved workspace when every saved session fails to start", async () => {
    failCreateSession = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mountProvider();
    expect(calls.some((c) => c.cmd === "create_session")).toBe(true);
    await settleAndQuit(2);
    expect(workspaceWrites()).toEqual([]);
    expect(settings.saved_workspace).toBe(SAVED);
    warn.mockRestore();
  });

  it("keeps an unreadable saved workspace instead of emptying it", async () => {
    settings.saved_workspace = "{not json";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mountProvider();
    await settleAndQuit(4);
    expect(workspaceWrites()).toEqual([]);
    expect(settings.saved_workspace).toBe("{not json");
    warn.mockRestore();
  });

  it("leaves the saved workspace alone when restoring is turned off", async () => {
    settings.restore_sessions = "never";
    await mountProvider();
    expect(calls.some((c) => c.cmd === "create_session")).toBe(false);
    await settleAndQuit(5);
    expect(workspaceWrites()).toEqual([]);
    expect(settings.saved_workspace).toBe(SAVED);
  });

  it("after a failed restore, a session opened and closed again saves again, keeping the entry that failed to restore", async () => {
    failCreateSession = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mountProvider();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAll();
    expect(settings.saved_workspace).toBe(SAVED);

    const NEW_ID = "22222222-2222-4222-8222-222222222222";
    await act(async () => { await fire("session-updated", session(NEW_ID, "Opened now")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAll();
    // The session that failed to restore keeps its entry for the next launch.
    expect(JSON.parse(settings.saved_workspace).sessions.map((s: { id: string }) => s.id)).toEqual([NEW_ID, KEEP_ID]);

    await act(async () => { await fire("session-removed", NEW_ID); });
    await settleAndQuit(6);
    expect(JSON.parse(settings.saved_workspace).sessions.map((s: { id: string }) => s.id)).toEqual([KEEP_ID]);
    warn.mockRestore();
  });
});
