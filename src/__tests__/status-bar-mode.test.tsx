/**
 * Phase 7 (v1.0.0 redesign) — StatusBar mode-conditional behaviour.
 *
 * Two narrow assertions:
 *   1. The Manual / Assisted / Auto cycle button (`.status-mode-btn`) is
 *      rendered for terminal-mode sessions but hidden for agent-mode sessions
 *      — it controls the terminal-mode auto-execute pipeline and has no
 *      meaning when the session is a Claude conversation.
 *   2. The CWD label tooltip uses `Project context: …` in agent mode and
 *      `Working directory: …` in terminal mode (visible basename unchanged).
 */
import { describe, expect, it, vi } from "vitest";

// ─── Module-level mocks (must come before any import that pulls them in) ──

// `@tauri-apps/plugin-shell` is invoked when the bug-report button is clicked,
// but its module-load `import` would still try to reach Tauri.  Stub it.
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(),
}));

// `api/settings` and `terminal/TerminalPool` (transitively via themeManager)
// reach into the Tauri runtime at module load.  Replace with no-op stubs.
vi.mock("../api/settings", () => ({
  setSetting: vi.fn(async () => {}),
  getSetting: vi.fn(async () => null),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("../api/menu", () => ({
  showContextMenu: vi.fn(async () => null),
  separator: () => ({ type: "separator" as const }),
  menuItem: (id: string, label: string) => ({ type: "item" as const, id, label }),
  subMenu: (label: string, items: unknown[]) => ({ type: "submenu" as const, label, items }),
}));
vi.mock("../hooks/nativeMenuBridge", () => ({
  ensureListener: vi.fn(),
  registerContextMenuHandler: vi.fn(),
  clearContextMenuHandler: vi.fn(),
}));
vi.mock("../utils/themeManager", () => ({
  DARK_THEMES: [],
  LIGHT_THEMES: [],
  applyTheme: vi.fn(),
}));

// Mockable session/context hooks.  `currentSession` is mutated per test so
// individual cases can swap the active session before calling renderToString.
let currentSession: SessionData | null = null;

vi.mock("../state/SessionContext", () => ({
  useActiveSession: () => currentSession,
  useSessionList: () => (currentSession ? [currentSession] : []),
  useTotalCost: () => 0,
  useTotalTokens: () => ({ input: 0, output: 0 }),
  useExecutionMode: () => "manual",
  useSession: () => ({ dispatch: vi.fn() }),
}));

import { renderToString } from "react-dom/server";
import type { SessionData, SessionMode } from "../types/session";
import { StatusBar } from "../components/StatusBar";

function makeSession(mode: SessionMode, workingDir = "/Users/me/projects/h-ide"): SessionData {
  return {
    id: "s1",
    label: "session-1",
    description: "",
    color: "#7b93db",
    group: null,
    phase: "idle",
    working_directory: workingDir,
    shell: "/bin/zsh",
    created_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    workspace_paths: [],
    detected_agent: null,
    metrics: {
      output_lines: 0,
      error_count: 0,
      stuck_score: 0,
      token_usage: {},
      tool_calls: [],
      tool_call_summary: {},
      files_touched: [],
      recent_errors: [],
      recent_actions: [],
      available_actions: [],
      memory_facts: [],
      latency_p50_ms: null,
      latency_p95_ms: null,
      latency_samples: [],
      token_history: [],
    },
    ai_provider: null,
    auto_approve: false,
    permission_mode: "default",
    custom_prefix: "",
    custom_suffix: "",
    channels: [],
    context_injected: false,
    ssh_info: null,
    mode,
  };
}

describe("StatusBar mode-conditional cycle button (Phase 7)", () => {
  it("hides the Manual/Assisted/Auto cycle button when active session is in agent mode", () => {
    currentSession = makeSession("agent");
    const html = renderToString(<StatusBar />);
    expect(html).not.toContain("status-mode-btn");
    // Also confirm the labels themselves don't bleed into the bar.
    expect(html).not.toMatch(/>Manual</);
    expect(html).not.toMatch(/>Assisted</);
    expect(html).not.toMatch(/>Auto</);
  });

  it("renders the cycle button when active session is in terminal mode", () => {
    currentSession = makeSession("terminal");
    const html = renderToString(<StatusBar />);
    expect(html).toContain("status-mode-btn");
    expect(html).toMatch(/>Manual</);
  });

  it("does not crash when there is no active session", () => {
    currentSession = null;
    expect(() => renderToString(<StatusBar />)).not.toThrow();
    const html = renderToString(<StatusBar />);
    // No active session → no cycle button is gated through.
    expect(html).not.toContain("status-mode-btn");
  });
});

describe("StatusBar CWD tooltip semantics (Phase 7)", () => {
  it("uses 'Project context: <path>' in agent mode", () => {
    currentSession = makeSession("agent", "/Users/me/projects/h-ide");
    const html = renderToString(<StatusBar />);
    expect(html).toContain('title="Project context: /Users/me/projects/h-ide"');
    expect(html).not.toContain('title="Working directory: /Users/me/projects/h-ide"');
  });

  it("uses 'Working directory: <path>' in terminal mode", () => {
    currentSession = makeSession("terminal", "/Users/me/projects/h-ide");
    const html = renderToString(<StatusBar />);
    expect(html).toContain('title="Working directory: /Users/me/projects/h-ide"');
    expect(html).not.toContain('title="Project context: /Users/me/projects/h-ide"');
  });

  it("renders the basename only as visible text", () => {
    currentSession = makeSession("agent", "/Users/me/projects/h-ide");
    const html = renderToString(<StatusBar />);
    // The visible text inside the cwd span is the basename.
    expect(html).toContain(">h-ide<");
    // The full path is not rendered as visible text — only as a title attr.
    expect(html).not.toMatch(/>\/Users\/me\/projects\/h-ide</);
  });
});
