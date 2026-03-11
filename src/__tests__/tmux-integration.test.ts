/**
 * Tests for tmux integration with SSH remote sessions.
 *
 * Covers:
 * - TmuxSessionEntry type shape
 * - TmuxWindowEntry type shape
 * - SshConnectionInfo with tmux_session field
 * - CreateSessionOpts tmuxSession field
 * - Workspace persistence with tmux sessions
 * - Session reducer with tmux sessions
 * - SSH+tmux label conventions
 * - SSH connection history helpers
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: vi.fn(() => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../terminal/TerminalPool", () => ({
  createTerminal: vi.fn(),
  destroy: vi.fn(),
  updateSettings: vi.fn(),
  writeScrollback: vi.fn(),
}));
vi.mock("../utils/notifications", () => ({
  initNotifications: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import type {
  SessionData,
  SshConnectionInfo,
  CreateSessionOpts,
  TmuxSessionEntry,
  TmuxWindowEntry,
  SavedWorkspace,
} from "../types/session";
import {
  parseSshHistory,
  addToSshHistory,
  type SshHistoryEntry,
} from "../components/SessionCreator";
import { validateSavedWorkspace } from "../types/session";
import { sessionReducer, initialState } from "../state/SessionContext";

// ─── Helpers ─────────────────────────────────────────────────────────
function makeSession(overrides?: Partial<SessionData>): SessionData {
  return {
    id: "sess-1",
    label: "Session 1",
    description: "",
    color: "#ff0000",
    group: null,
    phase: "idle",
    working_directory: "/home/user/project",
    shell: "bash",
    created_at: "2025-01-01T00:00:00Z",
    last_activity_at: "2025-01-01T00:00:00Z",
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
    context_injected: false,
    ssh_info: null,
    ...overrides,
  };
}

function makeSshInfo(overrides?: Partial<SshConnectionInfo>): SshConnectionInfo {
  return {
    host: "192.168.1.100",
    port: 22,
    user: "deploy",
    ...overrides,
  };
}

// =====================================================================
// TmuxSessionEntry type shape
// =====================================================================
describe("TmuxSessionEntry type shape", () => {
  it("has name, windows, and attached fields", () => {
    const entry: TmuxSessionEntry = {
      name: "main",
      windows: 3,
      attached: true,
    };
    expect(entry.name).toBe("main");
    expect(entry.windows).toBe(3);
    expect(entry.attached).toBe(true);
  });

  it("windows is a number", () => {
    const entry: TmuxSessionEntry = {
      name: "dev",
      windows: 5,
      attached: false,
    };
    expect(typeof entry.windows).toBe("number");
  });

  it("attached is boolean", () => {
    const attached: TmuxSessionEntry = { name: "a", windows: 1, attached: true };
    const detached: TmuxSessionEntry = { name: "b", windows: 1, attached: false };
    expect(typeof attached.attached).toBe("boolean");
    expect(typeof detached.attached).toBe("boolean");
    expect(attached.attached).toBe(true);
    expect(detached.attached).toBe(false);
  });
});

// =====================================================================
// TmuxWindowEntry type shape
// =====================================================================
describe("TmuxWindowEntry type shape", () => {
  it("has index, name, and active fields", () => {
    const entry: TmuxWindowEntry = {
      index: 0,
      name: "bash",
      active: true,
    };
    expect(entry.index).toBe(0);
    expect(entry.name).toBe("bash");
    expect(entry.active).toBe(true);
  });

  it("index is a number", () => {
    const entry: TmuxWindowEntry = {
      index: 3,
      name: "vim",
      active: false,
    };
    expect(typeof entry.index).toBe("number");
  });
});

// =====================================================================
// SshConnectionInfo with tmux_session
// =====================================================================
describe("SshConnectionInfo with tmux_session", () => {
  it("tmux_session is optional (undefined when not set)", () => {
    const info = makeSshInfo();
    expect(info.tmux_session).toBeUndefined();
  });

  it("can hold a tmux session name", () => {
    const info = makeSshInfo({ tmux_session: "my-dev-session" });
    expect(info.tmux_session).toBe("my-dev-session");
  });

  it("defaults to undefined for existing sessions (backward compat)", () => {
    const info: SshConnectionInfo = { host: "old-server", port: 22, user: "root" };
    expect(info.tmux_session).toBeUndefined();
    // Ensure accessing it does not throw
    expect(() => info.tmux_session).not.toThrow();
  });
});

// =====================================================================
// CreateSessionOpts tmuxSession field
// =====================================================================
describe("CreateSessionOpts tmuxSession field", () => {
  it("supports tmuxSession parameter", () => {
    const opts: CreateSessionOpts = {
      sshHost: "192.168.1.100",
      sshPort: 22,
      sshUser: "deploy",
      tmuxSession: "main",
    };
    expect(opts.tmuxSession).toBe("main");
  });

  it("tmuxSession is optional", () => {
    const opts: CreateSessionOpts = {
      sshHost: "192.168.1.100",
      sshUser: "deploy",
    };
    expect(opts.tmuxSession).toBeUndefined();
  });

  it("can combine SSH fields with tmuxSession", () => {
    const opts: CreateSessionOpts = {
      sshHost: "prod.example.com",
      sshPort: 2222,
      sshUser: "admin",
      tmuxSession: "deploy-session",
    };
    expect(opts.sshHost).toBe("prod.example.com");
    expect(opts.sshPort).toBe(2222);
    expect(opts.sshUser).toBe("admin");
    expect(opts.tmuxSession).toBe("deploy-session");
  });
});

// =====================================================================
// Workspace persistence with tmux sessions
// =====================================================================
describe("Workspace persistence with tmux sessions", () => {
  it("validates workspace with tmux_session on ssh_info", () => {
    const result = validateSavedWorkspace({
      version: 1,
      sessions: [{
        id: "s1",
        label: "deploy@server [main]",
        description: "",
        color: "#39c5cf",
        group: null,
        working_directory: "",
        ai_provider: null,
        auto_approve: false,
        project_ids: [],
        ssh_info: {
          host: "192.168.1.100",
          port: 22,
          user: "deploy",
          tmux_session: "main",
        },
      }],
      layout: null,
      focused_pane_id: null,
      active_session_id: "s1",
    });
    expect(result).not.toBeNull();
    expect(result!.sessions[0].ssh_info).toEqual({
      host: "192.168.1.100",
      port: 22,
      user: "deploy",
      tmux_session: "main",
    });
  });

  it("round-trips tmux session through JSON serialization", () => {
    const workspace: SavedWorkspace = {
      version: 1,
      sessions: [{
        id: "s1",
        label: "admin@prod [deploy]",
        description: "",
        color: "#39c5cf",
        group: null,
        working_directory: "",
        ai_provider: null,
        auto_approve: false,
        project_ids: [],
        ssh_info: {
          host: "prod.example.com",
          port: 2222,
          user: "admin",
          tmux_session: "deploy",
        },
      }],
      layout: null,
      focused_pane_id: null,
      active_session_id: "s1",
    };

    const json = JSON.stringify(workspace);
    const parsed = JSON.parse(json);
    const validated = validateSavedWorkspace(parsed);
    expect(validated).not.toBeNull();
    expect(validated!.sessions[0].ssh_info!.tmux_session).toBe("deploy");
  });

  it("handles ssh_info without tmux_session (backward compat)", () => {
    const result = validateSavedWorkspace({
      version: 1,
      sessions: [{
        id: "s1",
        label: "deploy@server",
        description: "",
        color: "#39c5cf",
        group: null,
        working_directory: "",
        ai_provider: null,
        auto_approve: false,
        project_ids: [],
        ssh_info: { host: "192.168.1.100", port: 22, user: "deploy" },
      }],
      layout: null,
      focused_pane_id: null,
      active_session_id: "s1",
    });
    expect(result).not.toBeNull();
    expect(result!.sessions[0].ssh_info).toBeDefined();
    expect(result!.sessions[0].ssh_info!.tmux_session).toBeUndefined();
  });

  it("preserves tmux_session in mixed local/SSH workspace", () => {
    const result = validateSavedWorkspace({
      version: 1,
      sessions: [
        {
          id: "local-1",
          label: "Local Dev",
          description: "",
          color: "#ff0000",
          group: null,
          working_directory: "/home/user/project",
          ai_provider: null,
          auto_approve: false,
          project_ids: [],
          ssh_info: null,
        },
        {
          id: "ssh-1",
          label: "deploy@prod [web]",
          description: "",
          color: "#39c5cf",
          group: null,
          working_directory: "",
          ai_provider: null,
          auto_approve: false,
          project_ids: [],
          ssh_info: {
            host: "prod.example.com",
            port: 22,
            user: "deploy",
            tmux_session: "web",
          },
        },
      ],
      layout: null,
      focused_pane_id: null,
      active_session_id: "local-1",
    });
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(2);
    expect(result!.sessions[0].ssh_info).toBeNull();
    expect(result!.sessions[1].ssh_info!.tmux_session).toBe("web");
  });
});

// =====================================================================
// Session reducer with tmux sessions
// =====================================================================
describe("Session reducer with tmux sessions", () => {
  it("SESSION_UPDATED stores tmux_session in ssh_info", () => {
    const session = makeSession({
      id: "ssh-tmux-1",
      label: "deploy@server [main]",
      ssh_info: makeSshInfo({ tmux_session: "main" }),
    });
    const state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session,
    });
    expect(state.sessions["ssh-tmux-1"]).toBeDefined();
    expect(state.sessions["ssh-tmux-1"].ssh_info!.tmux_session).toBe("main");
  });

  it("can update tmux session info independently", () => {
    const session = makeSession({
      id: "ssh-tmux-1",
      label: "deploy@server [dev]",
      ssh_info: makeSshInfo({ tmux_session: "dev" }),
    });
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session,
    });
    expect(state.sessions["ssh-tmux-1"].ssh_info!.tmux_session).toBe("dev");

    // Update to a different tmux session
    const updated = makeSession({
      id: "ssh-tmux-1",
      label: "deploy@server [prod]",
      ssh_info: makeSshInfo({ tmux_session: "prod" }),
    });
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: updated,
    });
    expect(state.sessions["ssh-tmux-1"].ssh_info!.tmux_session).toBe("prod");
  });

  it("SESSION_REMOVED cleans up tmux SSH session", () => {
    const session = makeSession({
      id: "ssh-tmux-1",
      label: "deploy@server [main]",
      ssh_info: makeSshInfo({ tmux_session: "main" }),
    });
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session,
    });
    expect(state.sessions["ssh-tmux-1"]).toBeDefined();

    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "ssh-tmux-1" });
    expect(state.sessions["ssh-tmux-1"]).toBeUndefined();
  });
});

// =====================================================================
// SSH+tmux label conventions
// =====================================================================
describe("SSH+tmux label conventions", () => {
  it("label includes tmux session name in brackets: \"user@host [session]\"", () => {
    const info = makeSshInfo({
      user: "admin",
      host: "prod.example.com",
      tmux_session: "web",
    });
    const label = info.tmux_session
      ? `${info.user}@${info.host} [${info.tmux_session}]`
      : `${info.user}@${info.host}`;
    expect(label).toBe("admin@prod.example.com [web]");
  });

  it("label without tmux session is just \"user@host\"", () => {
    const info = makeSshInfo({
      user: "deploy",
      host: "staging.example.com",
    });
    const label = info.tmux_session
      ? `${info.user}@${info.host} [${info.tmux_session}]`
      : `${info.user}@${info.host}`;
    expect(label).toBe("deploy@staging.example.com");
  });
});

// =====================================================================
// SSH connection history helpers
// =====================================================================
describe("SSH connection history helpers", () => {
  it("parseSshHistory returns empty array for invalid JSON", () => {
    expect(parseSshHistory("not-json")).toEqual([]);
    expect(parseSshHistory("")).toEqual([]);
    expect(parseSshHistory("{broken")).toEqual([]);
  });

  it("parseSshHistory parses valid JSON array", () => {
    const entries: SshHistoryEntry[] = [
      { host: "server1", user: "root", port: 22, lastUsed: "2025-01-01" },
      { host: "server2", user: "admin", port: 2222, lastUsed: "2025-01-02" },
    ];
    const result = parseSshHistory(JSON.stringify(entries));
    expect(result).toHaveLength(2);
    expect(result[0].host).toBe("server1");
    expect(result[1].port).toBe(2222);
  });

  it("addToSshHistory adds new entry at the front", () => {
    const existing: SshHistoryEntry[] = [
      { host: "old-server", user: "root", port: 22, lastUsed: "2025-01-01" },
    ];
    const newEntry: SshHistoryEntry = {
      host: "new-server",
      user: "deploy",
      port: 22,
      lastUsed: "2025-06-01",
    };
    const result = addToSshHistory(existing, newEntry);
    expect(result).toHaveLength(2);
    expect(result[0].host).toBe("new-server");
    expect(result[1].host).toBe("old-server");
  });

  it("addToSshHistory deduplicates by host+user+port (moves to front)", () => {
    const existing: SshHistoryEntry[] = [
      { host: "server-a", user: "root", port: 22, lastUsed: "2025-01-01" },
      { host: "server-b", user: "deploy", port: 22, lastUsed: "2025-01-02" },
      { host: "server-c", user: "admin", port: 2222, lastUsed: "2025-01-03" },
    ];
    const duplicate: SshHistoryEntry = {
      host: "server-b",
      user: "deploy",
      port: 22,
      lastUsed: "2025-06-15",
    };
    const result = addToSshHistory(existing, duplicate);
    expect(result).toHaveLength(3);
    expect(result[0].host).toBe("server-b");
    expect(result[0].lastUsed).toBe("2025-06-15");
    expect(result[1].host).toBe("server-a");
    expect(result[2].host).toBe("server-c");
  });

  it("addToSshHistory respects maxEntries limit", () => {
    const existing: SshHistoryEntry[] = Array.from({ length: 5 }, (_, i) => ({
      host: `server-${i}`,
      user: "root",
      port: 22,
      lastUsed: `2025-01-0${i + 1}`,
    }));
    const newEntry: SshHistoryEntry = {
      host: "newest",
      user: "root",
      port: 22,
      lastUsed: "2025-06-01",
    };
    const result = addToSshHistory(existing, newEntry, 3);
    expect(result).toHaveLength(3);
    expect(result[0].host).toBe("newest");
  });

  it("addToSshHistory updates lastUsed on duplicate", () => {
    const existing: SshHistoryEntry[] = [
      { host: "myhost", user: "admin", port: 22, lastUsed: "2025-01-01" },
    ];
    const updated: SshHistoryEntry = {
      host: "myhost",
      user: "admin",
      port: 22,
      lastUsed: "2025-12-25",
    };
    const result = addToSshHistory(existing, updated);
    expect(result).toHaveLength(1);
    expect(result[0].lastUsed).toBe("2025-12-25");
  });
});
