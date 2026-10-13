// @vitest-environment jsdom
/**
 * A launcher task's extra folders reach the agent as --add-dir, in both of
 * Claude's modes: launchTask → the app's createSession → the backend.
 *   - Agent view: create_session attaches every project and folds their
 *     paths into workspace_paths (pty/commands.rs, mirrored by the fake
 *     below); the agent is spawned with them as addDirs, and the Rust test
 *     build_spawn_args_initial_emits_one_add_dir_per_path_in_input_order
 *     turns each into one --add-dir.
 *   - Terminal: the extra folders travel as extraDirs, which become the
 *     session's extra_dirs (never its workspace_paths: projects attached
 *     later are not --add-dir), and the Rust tests
 *     a_launcher_tasks_extra_folders_are_one_add_dir_each_for_claude_only and
 *     extra_folders_that_are_gone_or_the_sessions_own_repository_are_dropped
 *     turn each into one --add-dir on the launch line.
 * SessionProvider against a faked backend. Every path here is made up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import type { CreateSessionOpts, SessionData } from "../types/session";
import type { PlannedAgent, TaskLaunchRequest } from "../components/TaskLauncher";
import type { LaunchChoice } from "../agent/capabilities/types";

const PROJECTS: Record<string, string> = { "proj-main": "/fixture-home/code/atlas", "proj-a": "/fixture-home/code/plugins", "proj-b": "/fixture-home/notes/docs" };
const calls: { cmd: string; args: Record<string, unknown> }[] = [];

function session(args: Record<string, unknown>) {
  const mode = (args.mode as string) ?? "terminal";
  const paths = [...((args.workspacePaths as string[] | null) ?? [])];
  // The Agent view's create_session folds every attached project's path in.
  if (mode === "agent") for (const id of (args.projectIds as string[] | null) ?? []) if (!paths.includes(PROJECTS[id])) paths.push(PROJECTS[id]);
  return {
    id: args.sessionId, label: args.label, color: "#888888", group: null, phase: "idle", working_directory: args.workingDirectory,
    shell: "bash", created_at: "2026-01-01T00:00:00Z", last_activity_at: "2026-01-01T00:00:00Z",
    workspace_paths: paths, detected_agent: null, ai_provider: args.aiProvider, context_injected: false, mode,
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
        return { restore_sessions: "never" };
      case "create_session":
        return session(args);
      case "spawn_agent_session":
        return "claude-uuid-1";
      default:
        return [];
    }
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn(() => ({})) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    unicode = { activeVersion: "6" };
    rows = 24;
    cols = 80;
    options = {};
    buffer = { active: { viewportY: 0, baseY: 0, length: 0 } };
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    onScroll() { return { dispose() {} }; }
    hasSelection() { return false; }
    write() {}
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

const CHOICE: LaunchChoice = {
  agentId: "claude",
  accountId: "default",
  approvalModeId: "acceptEdits",
  modelId: "default",
  effort: null,
  extraArgs: "",
  prefix: "",
  channels: [],
  where: { kind: "current-checkout" },
  trackAsFeature: false,
};
const claude = (mode: "agent" | "terminal"): PlannedAgent => ({
  id: "claude",
  mode,
  branch: "",
  createBranch: false,
  baseBranch: "",
  worktree: false,
  launch: { permissionMode: "acceptEdits", customPrefix: "", customSuffix: "", channels: [] },
  choice: CHOICE,
});
const request = (mode: "agent" | "terminal"): TaskLaunchRequest => ({
  task: "Wire the plugin into the docs",
  repoRoot: PROJECTS["proj-main"],
  extraRoots: [PROJECTS["proj-a"], PROJECTS["proj-b"]],
  agents: [claude(mode)],
  track: "Quick",
  doneWhen: [],
  choice: CHOICE,
});

async function flushAll() {
  for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); });
}

describe("a launcher task's extra folders reach Claude as --add-dir", () => {
  beforeEach(() => {
    vi.resetModules();
    calls.length = 0;
  });
  afterEach(() => cleanup());

  async function launch(mode: "agent" | "terminal") {
    const { SessionProvider, useSession } = await import("../state/SessionContext");
    const { launchTask } = await import("../launcher/launchTask");
    let create: ((opts?: CreateSessionOpts) => Promise<SessionData | null>) | null = null;
    function Grab() {
      create = useSession().createSession as (opts?: CreateSessionOpts) => Promise<SessionData | null>;
      return null;
    }
    render(<SessionProvider><Grab /></SessionProvider>);
    await flushAll();
    const byPath = Object.fromEntries(Object.entries(PROJECTS).map(([id, path]) => [path, id]));
    await act(async () => {
      await launchTask(request(mode), {
        projectFor: async (root) => byPath[root],
        createSession: (opts) => create!(opts),
        place: () => {},
        worktreePath: async () => null,
        writeFeatureFile: async () => "",
        copyText: async () => {},
        readRecords: async () => "",
        writeRecords: async () => {},
        now: () => 1,
      });
    });
    await flushAll();
    return calls.find((c) => c.cmd === "create_session")!.args;
  }

  it("Agent view: the agent is spawned with every extra folder as an add-dir", async () => {
    const created = await launch("agent");
    expect(created.projectIds).toEqual(["proj-main", "proj-a", "proj-b"]);
    const spawn = calls.find((c) => c.cmd === "spawn_agent_session")?.args;
    expect(spawn?.addDirs).toEqual(expect.arrayContaining([PROJECTS["proj-a"], PROJECTS["proj-b"]]));
  });

  it("Terminal: create_session gets the extra folders as the session's extra dirs (its --add-dir)", async () => {
    const created = await launch("terminal");
    expect(created.projectIds).toEqual(["proj-main", "proj-a", "proj-b"]);
    expect(created.extraDirs).toEqual([PROJECTS["proj-a"], PROJECTS["proj-b"]]);
    expect(created.workspacePaths).toBeNull();
    expect(calls.some((c) => c.cmd === "spawn_agent_session")).toBe(false);
  });
});
