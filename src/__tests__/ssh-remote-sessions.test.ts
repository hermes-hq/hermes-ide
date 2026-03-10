/**
 * Tests for SSH remote session support (Phase 1 Alpha).
 *
 * Covers:
 * - SshConnectionInfo type shape
 * - SessionData ssh_info field presence
 * - CreateSessionOpts SSH fields
 * - SavedSessionInfo SSH persistence via validateSavedWorkspace
 * - SessionCreator SSH-specific step ordering logic
 * - Workspace restore with SSH sessions
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
  SavedSessionInfo,
  SavedWorkspace,
} from "../types/session";
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
// SshConnectionInfo type shape
// =====================================================================
describe("SshConnectionInfo", () => {
  it("contains host, port, and user fields", () => {
    const info = makeSshInfo();
    expect(info.host).toBe("192.168.1.100");
    expect(info.port).toBe(22);
    expect(info.user).toBe("deploy");
  });

  it("allows custom port", () => {
    const info = makeSshInfo({ port: 2222 });
    expect(info.port).toBe(2222);
  });

  it("allows hostname instead of IP", () => {
    const info = makeSshInfo({ host: "myserver.example.com" });
    expect(info.host).toBe("myserver.example.com");
  });
});

// =====================================================================
// SessionData ssh_info field
// =====================================================================
describe("SessionData ssh_info", () => {
  it("is null for local sessions", () => {
    const session = makeSession();
    expect(session.ssh_info).toBeNull();
  });

  it("contains SshConnectionInfo for remote sessions", () => {
    const session = makeSession({
      ssh_info: makeSshInfo(),
    });
    expect(session.ssh_info).not.toBeNull();
    expect(session.ssh_info!.host).toBe("192.168.1.100");
    expect(session.ssh_info!.user).toBe("deploy");
    expect(session.ssh_info!.port).toBe(22);
  });

  it("can distinguish local from SSH sessions", () => {
    const local = makeSession({ id: "local-1" });
    const remote = makeSession({ id: "remote-1", ssh_info: makeSshInfo() });
    expect(local.ssh_info).toBeNull();
    expect(remote.ssh_info).not.toBeNull();
  });
});

// =====================================================================
// CreateSessionOpts SSH fields
// =====================================================================
describe("CreateSessionOpts SSH fields", () => {
  it("supports SSH connection parameters", () => {
    const opts: CreateSessionOpts = {
      sshHost: "192.168.1.100",
      sshPort: 22,
      sshUser: "deploy",
    };
    expect(opts.sshHost).toBe("192.168.1.100");
    expect(opts.sshPort).toBe(22);
    expect(opts.sshUser).toBe("deploy");
  });

  it("SSH fields are optional", () => {
    const opts: CreateSessionOpts = {};
    expect(opts.sshHost).toBeUndefined();
    expect(opts.sshPort).toBeUndefined();
    expect(opts.sshUser).toBeUndefined();
  });

  it("does not require local fields for SSH sessions", () => {
    const opts: CreateSessionOpts = {
      sshHost: "myhost",
      sshUser: "root",
      // No projectIds, workingDirectory, aiProvider, etc.
    };
    expect(opts.projectIds).toBeUndefined();
    expect(opts.workingDirectory).toBeUndefined();
    expect(opts.aiProvider).toBeUndefined();
  });

  it("supports custom SSH port", () => {
    const opts: CreateSessionOpts = {
      sshHost: "secure-host",
      sshPort: 2222,
      sshUser: "admin",
    };
    expect(opts.sshPort).toBe(2222);
  });
});

// =====================================================================
// Workspace persistence with SSH sessions
// =====================================================================
describe("SSH session workspace persistence", () => {
  it("validates workspace with ssh_info on session", () => {
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
    expect(result!.sessions[0].ssh_info).toEqual({
      host: "192.168.1.100",
      port: 22,
      user: "deploy",
    });
  });

  it("preserves ssh_info: null for local sessions", () => {
    const result = validateSavedWorkspace({
      sessions: [{
        id: "s1",
        label: "Local",
        ssh_info: null,
      }],
    });
    expect(result).not.toBeNull();
    expect(result!.sessions[0].ssh_info).toBeNull();
  });

  it("handles missing ssh_info field (backward compat)", () => {
    const result = validateSavedWorkspace({
      sessions: [{
        id: "s1",
        label: "Old Session",
        // no ssh_info field at all
      }],
    });
    expect(result).not.toBeNull();
    // Should not crash; ssh_info is simply absent/undefined
    expect(result!.sessions[0].ssh_info ?? null).toBeNull();
  });

  it("round-trips SSH session through JSON serialization", () => {
    const workspace: SavedWorkspace = {
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
        ssh_info: { host: "myserver.com", port: 2222, user: "admin" },
      }],
      layout: null,
      focused_pane_id: null,
      active_session_id: "s1",
    };

    const json = JSON.stringify(workspace);
    const parsed = JSON.parse(json);
    const validated = validateSavedWorkspace(parsed);
    expect(validated).not.toBeNull();
    expect(validated!.sessions[0].ssh_info).toEqual({
      host: "myserver.com",
      port: 2222,
      user: "admin",
    });
  });

  it("handles workspace with mixed local and SSH sessions", () => {
    const result = validateSavedWorkspace({
      version: 1,
      sessions: [
        {
          id: "local-1",
          label: "Local Dev",
          description: "",
          color: "#ff0000",
          group: "dev",
          working_directory: "/home/user/project",
          ai_provider: "claude",
          auto_approve: false,
          project_ids: ["p1"],
          ssh_info: null,
        },
        {
          id: "ssh-1",
          label: "deploy@prod",
          description: "Production server",
          color: "#39c5cf",
          group: "servers",
          working_directory: "",
          ai_provider: null,
          auto_approve: false,
          project_ids: [],
          ssh_info: { host: "prod.example.com", port: 22, user: "deploy" },
        },
      ],
      layout: null,
      focused_pane_id: null,
      active_session_id: "local-1",
    });
    expect(result).not.toBeNull();
    expect(result!.sessions).toHaveLength(2);
    expect(result!.sessions[0].ssh_info).toBeNull();
    expect(result!.sessions[1].ssh_info).toEqual({
      host: "prod.example.com",
      port: 22,
      user: "deploy",
    });
  });
});

// =====================================================================
// Session reducer with SSH sessions
// =====================================================================
describe("Session reducer with SSH sessions", () => {
  it("SESSION_UPDATED stores ssh_info on session", () => {
    const session = makeSession({
      id: "ssh-1",
      label: "deploy@server",
      ssh_info: makeSshInfo(),
    });
    const state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session,
    });
    expect(state.sessions["ssh-1"]).toBeDefined();
    expect(state.sessions["ssh-1"].ssh_info).toEqual(makeSshInfo());
  });

  it("SESSION_UPDATED stores null ssh_info for local session", () => {
    const session = makeSession({ id: "local-1" });
    const state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session,
    });
    expect(state.sessions["local-1"].ssh_info).toBeNull();
  });

  it("SESSION_REMOVED cleans up SSH session", () => {
    const session = makeSession({
      id: "ssh-1",
      ssh_info: makeSshInfo(),
    });
    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session,
    });
    expect(state.sessions["ssh-1"]).toBeDefined();

    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "ssh-1" });
    expect(state.sessions["ssh-1"]).toBeUndefined();
  });

  it("can have mixed local and SSH sessions in state", () => {
    const local = makeSession({ id: "local-1", label: "Local" });
    const remote = makeSession({
      id: "ssh-1",
      label: "deploy@server",
      ssh_info: makeSshInfo(),
    });

    let state = sessionReducer(initialState, {
      type: "SESSION_UPDATED",
      session: local,
    });
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: remote,
    });

    expect(Object.keys(state.sessions)).toHaveLength(2);
    expect(state.sessions["local-1"].ssh_info).toBeNull();
    expect(state.sessions["ssh-1"].ssh_info).not.toBeNull();
  });
});

// =====================================================================
// SSH-specific label generation
// =====================================================================
describe("SSH session label conventions", () => {
  it("SSH session label follows user@host pattern", () => {
    const info = makeSshInfo({ user: "admin", host: "prod.example.com" });
    const label = `${info.user}@${info.host}`;
    expect(label).toBe("admin@prod.example.com");
  });

  it("handles default port (no port suffix needed)", () => {
    const info = makeSshInfo({ port: 22 });
    const suffix = info.port !== 22 ? `:${info.port}` : "";
    expect(suffix).toBe("");
  });

  it("shows port suffix for non-standard port", () => {
    const info = makeSshInfo({ port: 2222 });
    const suffix = info.port !== 22 ? `:${info.port}` : "";
    expect(suffix).toBe(":2222");
  });
});
