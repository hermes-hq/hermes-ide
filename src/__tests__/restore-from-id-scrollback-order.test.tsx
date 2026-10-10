// @vitest-environment jsdom
/**
 * Restoring one closed session by id (Session history → Restore with
 * scrollback): the grey history is on screen before anything the new shell
 * prints. The shell starts while create_session is still answering, so
 * without a hold its prompt landed first and the old scrollback went below
 * it. Same ordering as the workspace restore (restored-scrollback-order).
 *
 * SessionProvider and the real terminal pool against a faked backend and a
 * fake xterm that records what is written to it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import type { CreateSessionOpts } from "../types/session";

type Handler = (event: { payload: unknown }) => unknown;
const listeners = new Map<string, Handler[]>();
/** Everything written to any terminal, in order, as text. */
const written: string[] = [];
let settings: Record<string, string> = {};
let newSessionId = "";
let snapshotReads: string[] = [];

const OLD_ID = "22222222-2222-4222-8222-222222222222";
const HISTORY = "$ echo restore-me-by-id\nrestore-me-by-id";
const LIVE = "bash-3.2$ ";

const toBase64 = (s: string) => btoa(s);

function fire(name: string, payload: unknown) {
  for (const h of listeners.get(name) ?? []) h({ payload });
}

function session(id: string, label: string) {
  return {
    id, label, color: "#888888", group: null, phase: "idle", working_directory: "/work/project",
    shell: "bash", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z",
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
      case "get_session_snapshot":
        snapshotReads.push(args.sessionId as string);
        return args.sessionId === OLD_ID ? HISTORY : null;
      case "create_session":
        newSessionId = args.sessionId as string;
        // The new shell prints its prompt before create_session answers.
        fire(`pty-output-${newSessionId}`, toBase64(LIVE));
        return session(newSessionId, args.label as string);
      case "set_setting":
        settings[args.key as string] = args.value as string;
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
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    rows = 24;
    cols = 80;
    options = {};
    buffer = { active: { viewportY: 0, baseY: 0, length: 0 } };
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    onScroll() { return { dispose() {} }; }
    hasSelection() { return false; }
    write(data: string | Uint8Array) {
      written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("../utils/themeManager", () => ({ applyTheme: vi.fn(), applyAgentTimelineStyle: vi.fn() }));
vi.mock("../utils/windowState", () => ({ restoreWindowState: vi.fn(async () => {}) }));
vi.mock("../utils/notifications", () => ({ initNotifications: vi.fn(async () => {}), notifyLongRunningDone: vi.fn() }));
vi.mock("../utils/analytics", () => ({ initAnalytics: vi.fn(async () => {}), trackAppStarted: vi.fn(), trackSessionCreated: vi.fn() }));

async function flushAll() {
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
}

describe("restoring a closed session by id puts its history before the new shell's output", () => {
  beforeEach(() => {
    vi.resetModules();
    listeners.clear();
    written.length = 0;
    snapshotReads = [];
    newSessionId = "";
    settings = { restore_sessions: "never" };
  });
  afterEach(() => {
    cleanup();
  });

  async function mount() {
    const { SessionProvider, useSession } = await import("../state/SessionContext");
    let create: ((opts?: CreateSessionOpts) => Promise<unknown>) | null = null;
    function Grab() {
      create = useSession().createSession as (opts?: CreateSessionOpts) => Promise<unknown>;
      return null;
    }
    render(<SessionProvider><Grab /></SessionProvider>);
    await flushAll();
    return () => create!;
  }

  it("writes the grey history and its marker first, then what the shell printed, in order", async () => {
    const getCreate = await mount();
    await act(async () => {
      await getCreate()({ label: "Again", workingDirectory: "/work/project", restoreFromId: OLD_ID });
    });
    await flushAll();

    expect(snapshotReads).toContain(OLD_ID);
    const screen = written.join("");
    const history = screen.indexOf("restore-me-by-id");
    const marker = screen.indexOf("--- session restored ---");
    const prompt = screen.indexOf(LIVE);
    expect(history).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(history);
    expect(prompt).toBeGreaterThan(marker);

    // Once released, output goes straight to the terminal.
    const before = written.length;
    fire(`pty-output-${newSessionId}`, toBase64("after\r\n"));
    expect(written.slice(before)).toEqual(["after\r\n"]);
  });

  it("a new session without restoreFromId shows its output live, with no history", async () => {
    const getCreate = await mount();
    await act(async () => {
      await getCreate()({ label: "Fresh", workingDirectory: "/work/project" });
    });
    await flushAll();
    expect(snapshotReads).toEqual([]);
    expect(written.join("")).toContain(LIVE);
    expect(written.join("")).not.toContain("--- session restored ---");
  });
});
