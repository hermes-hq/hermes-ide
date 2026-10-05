// @vitest-environment jsdom
/**
 * QA-host-restored-scrollback (CHAOS-03): a restored session's grey history
 * is on screen before anything its new shell prints. The shell starts while
 * the restore is still waiting for create_session and the label/group
 * updates; on macOS CI its banner and prompt landed first and the grey text
 * went below the live prompt, losing "--- session restored ---".
 *
 * SessionProvider and the real terminal pool against a faked backend and a
 * fake xterm that records what is written to it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

type Handler = (event: { payload: unknown }) => unknown;
const listeners = new Map<string, Handler[]>();
/** Everything written to any terminal, in order, as text. */
const written: string[] = [];
let settings: Record<string, string> = {};
let openGroupUpdate: () => void = () => {};

const KEEP_ID = "11111111-1111-4111-8111-111111111111";
const HISTORY = "$ echo restore-me-please\nrestore-me-please";
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
        return HISTORY;
      case "create_session":
        // The new shell prints its prompt before create_session answers.
        fire(`pty-output-${args.sessionId as string}`, toBase64(LIVE));
        return session(args.sessionId as string, args.label as string);
      case "update_session_group":
        // The restore waits for this before it used to write the history;
        // the shell keeps printing meanwhile.
        return new Promise<null>((resolve) => {
          openGroupUpdate = () => resolve(null);
        });
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

const SAVED = JSON.stringify({
  version: 2,
  sessions: [{ id: KEEP_ID, label: "Keep me", color: "#888888", group: "Work", working_directory: "/work/project", ai_provider: null, project_ids: [] }],
  layout: null,
  focused_pane_id: null,
  active_session_id: KEEP_ID,
});

async function flushAll() {
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
}

describe("a restored session's history comes before its new shell's output", () => {
  beforeEach(() => {
    vi.resetModules();
    listeners.clear();
    written.length = 0;
    settings = { saved_workspace: SAVED, restore_sessions: "always" };
  });
  afterEach(() => {
    openGroupUpdate();
    cleanup();
  });

  it("writes the grey history and its marker first, then what the shell printed, in order", async () => {
    const { SessionProvider } = await import("../state/SessionContext");
    render(<SessionProvider><div /></SessionProvider>);
    await flushAll();
    // More output while the restore still waits on the group update.
    fire(`pty-output-${KEEP_ID}`, toBase64("ls\r\n"));
    await flushAll();
    openGroupUpdate();
    await flushAll();

    const screen = written.join("");
    const history = screen.indexOf("restore-me-please");
    const marker = screen.indexOf("--- session restored ---");
    const prompt = screen.indexOf(LIVE);
    expect(history).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(history);
    expect(prompt).toBeGreaterThan(marker);
    expect(screen.indexOf("ls\r\n")).toBeGreaterThan(prompt);

    // Once released, output goes straight to the terminal.
    const before = written.length;
    fire(`pty-output-${KEEP_ID}`, toBase64("after\r\n"));
    expect(written.slice(before)).toEqual(["after\r\n"]);
  });
});
