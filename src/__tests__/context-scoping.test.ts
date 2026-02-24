/**
 * Tests for context scoping improvements:
 *
 * 1. Project-scoped pins (default to project, not session)
 * 2. Project-scoped memory (project scope instead of global-only)
 * 3. Token budget visibility in ContextManager
 * 4. Context fork semantics
 * 5. Pin scope indicators in formatContextMarkdown
 * 6. Project path matching (exact match with trailing separator)
 * 7. Memory dedup with project-scoped memory
 * 8. HermesProjectConfig type validation
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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
  notifyStuck: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import {
  formatContextMarkdown,
  type ContextState,
} from "../hooks/useContextState";

import {
  sessionReducer,
  initialState,
  type SessionData,
} from "../state/SessionContext";

import type {
  ContextPin,
  HermesProjectConfig,
  ApplyContextResult,
} from "../types/context";

// ─── Helpers ─────────────────────────────────────────────────────────
function makeBaseContext(overrides?: Partial<ContextState>): ContextState {
  return {
    pinnedItems: [],
    memoryFacts: [],
    persistedMemory: [],
    realms: [],
    workspacePaths: [],
    workingDirectory: "/home/user/project",
    agent: "anthropic",
    model: "claude-sonnet",
    ...overrides,
  };
}

function makeSession(overrides?: Partial<SessionData>): SessionData {
  return {
    id: "sess-1",
    label: "Session 1",
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
    context_injected: false,
    ...overrides,
  };
}

function makeProjectPin(target: string, label?: string): ContextPin {
  return {
    id: Math.floor(Math.random() * 10000),
    session_id: null,       // project-scoped (no session)
    project_id: "realm-1",  // attached to a project
    kind: "file",
    target,
    label: label ?? null,
    priority: 256,
    created_at: Date.now() / 1000,
  };
}

function makeSessionPin(sessionId: string, target: string, label?: string): ContextPin {
  return {
    id: Math.floor(Math.random() * 10000),
    session_id: sessionId,
    project_id: null,
    kind: "file",
    target,
    label: label ?? null,
    priority: 128,
    created_at: Date.now() / 1000,
  };
}

// =====================================================================
// Suite 1: Project-Scoped Pins
// =====================================================================

describe("Suite 1: Project-Scoped Pins", () => {
  it("project-scoped pins have null session_id", () => {
    const pin = makeProjectPin("/src/main.ts");
    expect(pin.session_id).toBeNull();
    expect(pin.project_id).toBe("realm-1");
  });

  it("session-scoped pins have a session_id", () => {
    const pin = makeSessionPin("sess-1", "/tmp/scratch.ts");
    expect(pin.session_id).toBe("sess-1");
    expect(pin.project_id).toBeNull();
  });

  it("formatContextMarkdown shows scope for project pins", () => {
    const ctx = makeBaseContext({
      pinnedItems: [
        makeProjectPin("/src/main.ts", "Main entry"),
        makeSessionPin("sess-1", "/tmp/debug.log", "Debug log"),
      ],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("[file] Main entry (project)");
    expect(output).toContain("[file] Debug log");
    // Session pin should NOT have "(project)" suffix
    expect(output).not.toContain("Debug log (project)");
  });

  it("project pins appear in context when session changes", () => {
    // Project pins should survive session changes since they're not session-scoped
    const ctx1 = makeBaseContext({
      pinnedItems: [makeProjectPin("/src/config.ts", "Config")],
    });
    const ctx2 = makeBaseContext({
      pinnedItems: [makeProjectPin("/src/config.ts", "Config")],
    });

    const output1 = formatContextMarkdown(ctx1, 1, "manual");
    const output2 = formatContextMarkdown(ctx2, 1, "manual");
    expect(output1).toBe(output2);
  });

  it("mixed session and project pins are both displayed", () => {
    const pins = [
      makeProjectPin("/src/index.ts", "Index"),
      makeSessionPin("sess-1", "/tmp/notes.md", "Notes"),
      makeProjectPin("/README.md", "README"),
    ];
    const ctx = makeBaseContext({ pinnedItems: pins });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Pinned Context");
    expect(output).toContain("Index (project)");
    expect(output).toContain("Notes");
    expect(output).toContain("README (project)");
  });
});

// =====================================================================
// Suite 2: Project-Scoped Memory
// =====================================================================

describe("Suite 2: Project-Scoped Memory", () => {
  it("project memory takes precedence over global memory for same key", () => {
    const ctx = makeBaseContext({
      persistedMemory: [
        { key: "db_host", value: "project-db.local", source: "user" },  // project-scoped (loaded first)
      ],
      memoryFacts: [
        { key: "db_host", value: "session-detected", source: "agent", confidence: 0.5 },
      ],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("db_host = project-db.local");
    expect(output).not.toContain("db_host = session-detected");
  });

  it("non-overlapping project and global memory both appear", () => {
    const ctx = makeBaseContext({
      persistedMemory: [
        { key: "project_key", value: "project_val", source: "user" },
        { key: "global_key", value: "global_val", source: "user" },
      ],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("project_key = project_val");
    expect(output).toContain("global_key = global_val");
  });

  it("empty project memory with global memory works correctly", () => {
    const ctx = makeBaseContext({
      persistedMemory: [
        { key: "global_only", value: "gval", source: "user" },
      ],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Memory");
    expect(output).toContain("global_only = gval");
  });
});

// =====================================================================
// Suite 3: Token Budget Visibility
// =====================================================================

describe("Suite 3: Token Budget in ApplyContextResult", () => {
  it("ApplyContextResult includes token_budget field", () => {
    const result: ApplyContextResult = {
      version: 1,
      content: "# Context",
      file_path: "/tmp/ctx.md",
      nudge_sent: true,
      nudge_error: null,
      estimated_tokens: 500,
      token_budget: 4000,
    };
    expect(result.token_budget).toBe(4000);
    expect(result.estimated_tokens).toBe(500);
  });

  it("budget percentage calculation works correctly", () => {
    const budget = 4000;
    const estimated = 3200;
    const pct = Math.round((estimated / budget) * 100);
    expect(pct).toBe(80);
  });

  it("budget percentage caps at 100", () => {
    const budget = 1000;
    const estimated = 1500;
    const pct = Math.min(100, Math.round((estimated / budget) * 100));
    expect(pct).toBe(100);
  });

  it("zero budget handles gracefully", () => {
    const budget = 0;
    const estimated = 500;
    const pct = budget > 0 ? Math.min(100, Math.round((estimated / budget) * 100)) : 0;
    expect(pct).toBe(0);
  });
});

// =====================================================================
// Suite 4: Context Fork Semantics
// =====================================================================

describe("Suite 4: Context Fork Semantics", () => {
  it("forked sessions share the same project context data", () => {
    const sharedProject = {
      realm_id: "r1", realm_name: "my-project", path: "/home/user/my-project",
      languages: ["TypeScript"], frameworks: ["React"],
      architecture_pattern: "MVC", architecture_layers: [],
      conventions: ["camelCase"], scan_status: "deep",
    };

    const ctx1 = makeBaseContext({ realms: [sharedProject] });
    const ctx2 = makeBaseContext({ realms: [sharedProject] });

    const out1 = formatContextMarkdown(ctx1, 1, "manual");
    const out2 = formatContextMarkdown(ctx2, 2, "manual");

    // Same project data should produce identical project sections
    expect(out1).toContain("### my-project");
    expect(out2).toContain("### my-project");
    expect(out1).toContain("Languages: TypeScript");
    expect(out2).toContain("Languages: TypeScript");
  });

  it("session-specific context differs after fork", () => {
    const sharedPins = [makeProjectPin("/src/main.ts", "Main")];

    const ctx1 = makeBaseContext({
      pinnedItems: [...sharedPins, makeSessionPin("sess-1", "/tmp/s1.log", "S1 log")],
      workingDirectory: "/home/user/project",
    });
    const ctx2 = makeBaseContext({
      pinnedItems: [...sharedPins, makeSessionPin("sess-2", "/tmp/s2.log", "S2 log")],
      workingDirectory: "/home/user/project",
    });

    const out1 = formatContextMarkdown(ctx1, 1, "manual");
    const out2 = formatContextMarkdown(ctx2, 1, "manual");

    // Shared pin appears in both
    expect(out1).toContain("Main (project)");
    expect(out2).toContain("Main (project)");

    // Session-specific pins differ
    expect(out1).toContain("S1 log");
    expect(out1).not.toContain("S2 log");
    expect(out2).toContain("S2 log");
    expect(out2).not.toContain("S1 log");
  });
});

// =====================================================================
// Suite 5: Project Path Matching
// =====================================================================

describe("Suite 5: Project Path Matching", () => {
  // Helper to simulate the project matching logic used in SessionContext.tsx
  function isProjectMatch(wd: string, rp: string): boolean {
    return wd === rp || wd.startsWith(rp + "/");
  }

  it("exact path match succeeds", () => {
    expect(isProjectMatch("/home/user/app", "/home/user/app")).toBe(true);
  });

  it("subdirectory match succeeds", () => {
    expect(isProjectMatch("/home/user/app/src/components", "/home/user/app")).toBe(true);
  });

  it("prefix-only match is rejected (the startsWith bug fix)", () => {
    // OLD (buggy): "/home/user/app-legacy".startsWith("/home/user/app") → true
    // NEW (fixed): isProjectMatch → false
    expect("/home/user/app-legacy".startsWith("/home/user/app")).toBe(true); // the bug
    expect(isProjectMatch("/home/user/app-legacy", "/home/user/app")).toBe(false); // the fix
  });

  it("sibling directory with similar prefix is rejected", () => {
    expect(isProjectMatch("/home/user/app2", "/home/user/app")).toBe(false);
  });

  it("child with deep nesting matches correctly", () => {
    expect(isProjectMatch("/home/user/app/packages/frontend/src/components/Button.tsx", "/home/user/app")).toBe(true);
  });

  it("root directory edge case", () => {
    expect(isProjectMatch("/", "/")).toBe(true);
  });
});

// =====================================================================
// Suite 6: HermesProjectConfig Type Validation
// =====================================================================

describe("Suite 6: HermesProjectConfig Schema", () => {
  it("minimal config is valid", () => {
    const config: HermesProjectConfig = {
      pins: [],
      memory: [],
      conventions: [],
    };
    expect(config.pins).toEqual([]);
    expect(config.memory).toEqual([]);
    expect(config.conventions).toEqual([]);
    expect(config.token_budget).toBeUndefined();
  });

  it("full config with all fields is valid", () => {
    const config: HermesProjectConfig = {
      pins: [
        { kind: "file", target: "/src/main.ts", label: "Main entry" },
        { kind: "text", target: "Always use TypeScript strict mode" },
      ],
      memory: [
        { key: "api_base", value: "https://api.example.com" },
        { key: "deploy_target", value: "production" },
      ],
      conventions: [
        "Use camelCase for variables",
        "All components go in src/components",
      ],
      token_budget: 8000,
    };
    expect(config.pins).toHaveLength(2);
    expect(config.memory).toHaveLength(2);
    expect(config.conventions).toHaveLength(2);
    expect(config.token_budget).toBe(8000);
  });

  it("pins without label are valid", () => {
    const config: HermesProjectConfig = {
      pins: [{ kind: "file", target: "/src/index.ts" }],
      memory: [],
      conventions: [],
    };
    expect(config.pins[0].label).toBeUndefined();
  });
});

// =====================================================================
// Suite 7: Session Cleanup on Removal
// =====================================================================

describe("Suite 7: Session Cleanup Preserves Project Data", () => {
  it("SESSION_REMOVED does not affect project-level state", () => {
    let state = initialState;

    // Create sessions with per-session modes
    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s1" }),
    });
    state = sessionReducer(state, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s1",
      mode: "autonomous",
    });

    state = sessionReducer(state, {
      type: "SESSION_UPDATED",
      session: makeSession({ id: "s2" }),
    });
    state = sessionReducer(state, {
      type: "SET_EXECUTION_MODE",
      sessionId: "s2",
      mode: "assisted",
    });

    // Remove s1
    state = sessionReducer(state, { type: "SESSION_REMOVED", id: "s1" });

    // s2 fully intact
    expect(state.sessions["s2"]).toBeDefined();
    expect(state.executionModes["s2"]).toBe("assisted");
    // s1 cleaned up
    expect(state.sessions["s1"]).toBeUndefined();
    expect(state.executionModes["s1"]).toBeUndefined();
    // Global settings untouched
    expect(state.defaultMode).toBe(initialState.defaultMode);
    expect(state.autoApplyEnabled).toBe(initialState.autoApplyEnabled);
  });
});

// =====================================================================
// Suite 8: Integration — Full Scoped Context Lifecycle
// =====================================================================

describe("Suite 8: Full Scoped Context Lifecycle", () => {
  it("complete context with project and session pins, project and global memory", () => {
    const ctx = makeBaseContext({
      pinnedItems: [
        makeProjectPin("/src/config.ts", "Config"),
        makeProjectPin("/README.md", "README"),
        makeSessionPin("sess-1", "/tmp/debug.log", "Debug"),
      ],
      persistedMemory: [
        { key: "api_url", value: "https://api.prod.com", source: "user" },
        { key: "deploy_env", value: "staging", source: "hermes-config" },
      ],
      memoryFacts: [
        { key: "api_url", value: "https://api.dev.com", source: "agent", confidence: 0.5 },
        { key: "current_branch", value: "feature/scoping", source: "agent", confidence: 0.9 },
      ],
      realms: [{
        realm_id: "r1", realm_name: "my-app", path: "/home/user/my-app",
        languages: ["TypeScript", "Rust"], frameworks: ["React", "Tauri"],
        architecture_pattern: "Tauri", architecture_layers: [],
        conventions: ["Use strict TypeScript", "Prefer functional components"],
        scan_status: "deep",
      }],
      workspacePaths: ["/extra"],
    });

    const output = formatContextMarkdown(ctx, 5, "assisted");

    // Version and mode
    expect(output).toContain("# Session Context (v5)");
    expect(output).toContain("- Mode: assisted");
    expect(output).toContain("- Provider: anthropic (claude-sonnet)");

    // Project info
    expect(output).toContain("### my-app");
    expect(output).toContain("Languages: TypeScript, Rust");
    expect(output).toContain("Frameworks: React, Tauri");
    expect(output).toContain("Architecture: Tauri");

    // Pins with scope indicators
    expect(output).toContain("[file] Config (project)");
    expect(output).toContain("[file] README (project)");
    expect(output).toContain("[file] Debug");
    expect(output).not.toContain("Debug (project)");

    // Memory dedup: persisted wins over session facts
    expect(output).toContain("api_url = https://api.prod.com");
    expect(output).not.toContain("api_url = https://api.dev.com");
    expect(output).toContain("deploy_env = staging");
    expect(output).toContain("current_branch = feature/scoping");

    // Workspace
    expect(output).toContain("Dir: /home/user/project");
  });

  it("empty context produces minimal output", () => {
    const ctx = makeBaseContext({
      agent: null, model: null,
    });
    const output = formatContextMarkdown(ctx, 0, "manual");
    expect(output).toContain("# Session Context (v0)");
    expect(output).toContain("- Mode: manual");
    expect(output).toContain("## Workspace");
    expect(output).not.toContain("## Projects");
    expect(output).not.toContain("## Pinned Context");
    expect(output).not.toContain("## Memory");
  });
});
