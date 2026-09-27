/**
 * Phase 7 (v1.0.0 redesign) — StatusBar mode-conditional behaviour.
 *
 * Two narrow assertions:
 *   1. There is no Manual / Assisted / Auto switch in any session (the
 *      execution modes were retired in 2.0).
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
}));

import { renderToString } from "react-dom/server";
import type { SessionData, SessionMode } from "../types/session";
import { StatusBar } from "../components/StatusBar";
import { I18nProvider } from "../i18n/I18nProvider";

// StatusBar reads its copy through useI18n() — wrap every render.
function renderBar(): string {
  return renderToString(
    <I18nProvider>
      <StatusBar />
    </I18nProvider>,
  );
}

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

describe("StatusBar has no execution-mode switch (retired in 2.0)", () => {
  // Hermes never types into a terminal on its own, so there is no
  // Manual / Assisted / Auto choice to offer in any kind of session.
  for (const mode of ["terminal", "agent"] as const) {
    it(`shows no Manual/Assisted/Auto control for a ${mode}-mode session`, () => {
      currentSession = makeSession(mode);
      const html = renderBar();
      expect(html).not.toContain('role="radiogroup"');
      expect(html).not.toContain("status-mode-seg");
      expect(html).not.toMatch(/>Manual</);
      expect(html).not.toMatch(/>Assisted</);
      expect(html).not.toMatch(/>Auto</);
    });
  }

  it("does not crash when there is no active session", () => {
    currentSession = null;
    expect(() => renderBar()).not.toThrow();
    expect(renderBar()).not.toContain('role="radiogroup"');
  });
});

describe("StatusBar CWD tooltip semantics (Phase 7)", () => {
  it("uses 'Project context: <path>' in agent mode", () => {
    currentSession = makeSession("agent", "/Users/me/projects/h-ide");
    const html = renderBar();
    expect(html).toContain('title="Project context: /Users/me/projects/h-ide"');
    expect(html).not.toContain('title="Working directory: /Users/me/projects/h-ide"');
  });

  it("uses 'Working directory: <path>' in terminal mode", () => {
    currentSession = makeSession("terminal", "/Users/me/projects/h-ide");
    const html = renderBar();
    expect(html).toContain('title="Working directory: /Users/me/projects/h-ide"');
    expect(html).not.toContain('title="Project context: /Users/me/projects/h-ide"');
  });

  it("renders the basename only as visible text", () => {
    currentSession = makeSession("agent", "/Users/me/projects/h-ide");
    const html = renderBar();
    // The visible text inside the cwd span is the basename.
    expect(html).toContain(">h-ide<");
    // The full path is not rendered as visible text — only as a title attr.
    expect(html).not.toMatch(/>\/Users\/me\/projects\/h-ide</);
  });
});
