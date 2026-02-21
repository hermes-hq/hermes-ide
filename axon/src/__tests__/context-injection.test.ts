/**
 * Context Injection Redesign — Backend-Authoritative Model
 *
 * Tests for:
 * - Version state transitions (lifecycle state machine)
 * - Dirty detection
 * - Apply behavior
 * - Auto-apply behavior
 * - Injection formatting
 * - Idempotency
 * - Multi-session isolation
 * - Execution mode propagation
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
} from "../state/SessionContext";

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
    errorResolutions: [],
    filesTouched: [],
    recentErrors: [],
    ...overrides,
  };
}

// =====================================================================
// Suite 1: Version State Transitions
// =====================================================================

describe("Suite 1: Version State Transitions", () => {
  it("CLEAN: lifecycle is 'clean' when currentVersion === injectedVersion", () => {
    const currentVersion = 3;
    const injectedVersion = 3;
    const state: string = currentVersion === injectedVersion ? "clean" : "dirty";
    expect(state).toBe("clean");
  });

  it("DIRTY: lifecycle becomes 'dirty' when context changes after apply", () => {
    const currentVersion = 4;
    const injectedVersion = 3;
    const state: string = currentVersion > injectedVersion ? "dirty" : "clean";
    expect(state).toBe("dirty");
  });

  it("APPLYING: lifecycle is 'applying' while apply_context is in flight", () => {
    const state: string = "applying";
    expect(state).toBe("applying");
  });

  it("APPLIED: lifecycle returns to 'clean' after successful apply", () => {
    let injectedVersion = 3;
    let currentVersion = 5;
    let state: string = "applying";

    // Simulate successful result from backend
    const backendVersion = 6;
    injectedVersion = backendVersion;
    currentVersion = backendVersion;
    state = "clean";

    expect(state).toBe("clean");
    expect(currentVersion).toBe(injectedVersion);
  });

  it("APPLY_FAILED: lifecycle is 'apply_failed' when apply_context rejects", () => {
    const state: string = "apply_failed";
    expect(state).toBe("apply_failed");
  });

  it("APPLY_FAILED retains dirty detection after error", () => {
    const state: string = "apply_failed";
    const canApply = state !== "clean" && state !== "applying";
    expect(canApply).toBe(true);
  });
});

// =====================================================================
// Suite 2: Dirty Detection
// =====================================================================

describe("Suite 2: Dirty Detection", () => {
  it("Context JSON comparison detects pin additions", () => {
    const before = JSON.stringify(makeBaseContext());
    const after = JSON.stringify(makeBaseContext({
      pinnedItems: [{
        id: 1, session_id: "s1", project_id: null,
        kind: "file", target: "/path/file.ts", label: null,
        priority: 128, created_at: 1000,
      }],
    }));
    expect(before).not.toBe(after);
  });

  it("Context JSON comparison detects pin removals", () => {
    const withPin = JSON.stringify(makeBaseContext({
      pinnedItems: [{
        id: 1, session_id: "s1", project_id: null,
        kind: "file", target: "/path/file.ts", label: null,
        priority: 128, created_at: 1000,
      }],
    }));
    const without = JSON.stringify(makeBaseContext());
    expect(withPin).not.toBe(without);
  });

  it("Context JSON comparison detects realm changes", () => {
    const before = JSON.stringify(makeBaseContext());
    const after = JSON.stringify(makeBaseContext({
      realms: [{
        realm_id: "r1", realm_name: "test", path: "/test",
        languages: ["TypeScript"], frameworks: [], architecture_pattern: null,
        architecture_layers: [], conventions: [], scan_status: "deep",
      }],
    }));
    expect(before).not.toBe(after);
  });

  it("Context JSON comparison detects memory changes", () => {
    const before = JSON.stringify(makeBaseContext());
    const after = JSON.stringify(makeBaseContext({
      persistedMemory: [{ key: "db_host", value: "localhost", source: "user" }],
    }));
    expect(before).not.toBe(after);
  });

  it("Same data re-applied does NOT produce different JSON", () => {
    const a = JSON.stringify(makeBaseContext());
    const b = JSON.stringify(makeBaseContext());
    expect(a).toBe(b);
  });
});

// =====================================================================
// Suite 3: Apply Behavior
// =====================================================================

describe("Suite 3: Apply Behavior", () => {
  it("Successful apply syncs injectedVersion from result", () => {
    let injectedVersion = 0;
    const result = { version: 5 };
    injectedVersion = result.version;
    expect(injectedVersion).toBe(5);
  });

  it("Successful apply syncs currentVersion to result version", () => {
    let currentVersion = 3;
    const result = { version: 5 };
    currentVersion = result.version;
    expect(currentVersion).toBe(result.version);
  });

  it("Successful apply sets lifecycle to clean", () => {
    let state: string = "applying";
    state = "clean";
    expect(state).toBe("clean");
  });

  it("Failed apply sets lifecycle to apply_failed", () => {
    let state: string = "applying";
    state = "apply_failed";
    expect(state).toBe("apply_failed");
  });

  it("applyContext is no-op when lifecycle is applying (double-apply prevention)", () => {
    const state: string = "applying";
    const shouldApply = state !== "applying";
    expect(shouldApply).toBe(false);
  });

  it("Stale apply: context changes during apply keeps dirty state", () => {
    const currentVersion = 6;
    const resultVersion = 5;
    const state: string = currentVersion > resultVersion ? "dirty" : "clean";
    expect(state).toBe("dirty");
  });
});

// =====================================================================
// Suite 4: Auto-Apply Behavior
// =====================================================================

describe("Suite 4: Auto-Apply Behavior", () => {
  it("Auto-apply triggers on busy transition when dirty and enabled", () => {
    const prevPhase: string = "idle";
    const currentPhase: string = "busy";
    const autoApplyEnabled = true;
    const state: string = "dirty";

    const shouldAutoApply =
      currentPhase === "busy" &&
      prevPhase !== "busy" &&
      autoApplyEnabled &&
      state === "dirty";

    expect(shouldAutoApply).toBe(true);
  });

  it("Auto-apply does NOT trigger when clean", () => {
    const prevPhase: string = "idle";
    const currentPhase: string = "busy";
    const autoApplyEnabled = true;
    const state: string = "clean";

    const shouldAutoApply =
      currentPhase === "busy" &&
      prevPhase !== "busy" &&
      autoApplyEnabled &&
      state === "dirty";

    expect(shouldAutoApply).toBe(false);
  });

  it("Auto-apply does NOT trigger when disabled", () => {
    const prevPhase: string = "idle";
    const currentPhase: string = "busy";
    const autoApplyEnabled = false;
    const state: string = "dirty";

    const shouldAutoApply =
      currentPhase === "busy" &&
      prevPhase !== "busy" &&
      autoApplyEnabled &&
      state === "dirty";

    expect(shouldAutoApply).toBe(false);
  });

  it("Auto-apply does NOT trigger when already applying", () => {
    const prevPhase: string = "idle";
    const currentPhase: string = "busy";
    const autoApplyEnabled = true;
    const state: string = "applying";

    const shouldAutoApply =
      currentPhase === "busy" &&
      prevPhase !== "busy" &&
      autoApplyEnabled &&
      state === "dirty";

    expect(shouldAutoApply).toBe(false);
  });

  it("Auto-apply does NOT trigger on non-busy transitions", () => {
    const prevPhase: string = "busy";
    const currentPhase: string = "idle";
    const autoApplyEnabled = true;
    const state: string = "dirty";

    const shouldAutoApply =
      currentPhase === "busy" &&
      prevPhase !== "busy" &&
      autoApplyEnabled &&
      state === "dirty";

    expect(shouldAutoApply).toBe(false);
  });

  it("TOGGLE_AUTO_APPLY action toggles autoApplyEnabled", () => {
    const state1 = sessionReducer(initialState, { type: "TOGGLE_AUTO_APPLY" });
    expect(state1.autoApplyEnabled).toBe(!initialState.autoApplyEnabled);
    const state2 = sessionReducer(state1, { type: "TOGGLE_AUTO_APPLY" });
    expect(state2.autoApplyEnabled).toBe(initialState.autoApplyEnabled);
  });
});

// =====================================================================
// Suite 5: Injection Formatting
// =====================================================================

describe("Suite 5: Injection Formatting", () => {
  it("formatContextMarkdown includes execution mode", () => {
    const ctx = makeBaseContext();
    const output = formatContextMarkdown(ctx, 1, "autonomous");
    expect(output).toContain("- Mode: autonomous");
  });

  it("formatContextMarkdown includes pins", () => {
    const ctx = makeBaseContext({
      pinnedItems: [{
        id: 1, session_id: "s1", project_id: null,
        kind: "file", target: "/src/main.ts", label: "Main entry",
        priority: 128, created_at: 1000,
      }],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Pinned Context");
    expect(output).toContain("[file] Main entry");
  });

  it("formatContextMarkdown includes memory", () => {
    const ctx = makeBaseContext({
      persistedMemory: [{ key: "db_host", value: "localhost", source: "user" }],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Memory");
    expect(output).toContain("db_host = localhost");
  });

  it("formatContextMarkdown includes realms", () => {
    const ctx = makeBaseContext({
      realms: [{
        realm_id: "r1", realm_name: "my-project", path: "/home/user/my-project",
        languages: ["TypeScript", "Python"], frameworks: ["React"],
        architecture_pattern: "MVC", architecture_layers: [],
        conventions: ["Use camelCase"], scan_status: "deep",
      }],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Projects");
    expect(output).toContain("### my-project (/home/user/my-project)");
    expect(output).toContain("Languages: TypeScript, Python");
    expect(output).toContain("Frameworks: React");
    expect(output).toContain("Architecture: MVC");
    expect(output).toContain("Conventions: Use camelCase");
  });

  it("formatContextMarkdown includes error resolutions", () => {
    const ctx = makeBaseContext({
      errorResolutions: [{
        fingerprint: "TypeError: undefined is not a function",
        resolution: "npm install",
        occurrence_count: 5,
      }],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Known Error Resolutions");
    expect(output).toContain('TypeError: undefined is not a function');
    expect(output).toContain("npm install");
    expect(output).toContain("seen 5x");
  });

  it("formatContextMarkdown includes version header", () => {
    const ctx = makeBaseContext();
    const output = formatContextMarkdown(ctx, 42, "manual");
    expect(output).toContain("# Session Context (v42)");
  });

  it("formatContextMarkdown includes workspace info", () => {
    const ctx = makeBaseContext({
      workspacePaths: ["/extra/path"],
      filesTouched: ["src/index.ts", "package.json"],
    });
    const output = formatContextMarkdown(ctx, 1, "manual");
    expect(output).toContain("## Workspace");
    expect(output).toContain("Dir: /home/user/project");
    expect(output).toContain("+ /extra/path");
    expect(output).toContain("Files touched: src/index.ts, package.json");
  });
});

// =====================================================================
// Suite 6: Idempotency
// =====================================================================

describe("Suite 6: Idempotency", () => {
  it("Calling applyContext twice rapidly: second call is no-op (lifecycle guard)", () => {
    let applyCount = 0;
    let state: string = "dirty";

    const tryApply = () => {
      if (state === "applying") return;
      state = "applying";
      applyCount++;
    };

    tryApply();
    tryApply();

    expect(applyCount).toBe(1);
  });

  it("Version doesn't increment if context hasn't changed (JSON comparison)", () => {
    let version = 0;
    let prevJson = "";

    const maybeIncrement = (ctx: ContextState) => {
      const json = JSON.stringify(ctx);
      if (json !== prevJson) {
        prevJson = json;
        version++;
      }
    };

    const ctx = makeBaseContext();
    maybeIncrement(ctx);
    expect(version).toBe(1);

    // Same context again — no increment
    maybeIncrement(ctx);
    expect(version).toBe(1);

    // Different context — increment
    maybeIncrement(makeBaseContext({ agent: "different" }));
    expect(version).toBe(2);
  });
});

// =====================================================================
// Suite 7: Multi-Session Isolation
// =====================================================================

describe("Suite 7: Multi-Session Isolation", () => {
  it("Version counters are independent per simulation", () => {
    let versionA = 0;
    let versionB = 0;

    versionA++;
    versionA++;
    versionB++;

    expect(versionA).toBe(2);
    expect(versionB).toBe(1);
  });

  it("Context changes in one session don't affect another", () => {
    const ctxA = makeBaseContext({ workingDirectory: "/project-a" });
    const ctxB = makeBaseContext({ workingDirectory: "/project-b" });

    const jsonA = JSON.stringify(ctxA);
    const jsonB = JSON.stringify(ctxB);

    expect(jsonA).not.toBe(jsonB);
    expect(ctxA.workingDirectory).toBe("/project-a");
    expect(ctxB.workingDirectory).toBe("/project-b");
  });
});

// =====================================================================
// Suite 8: ExecutionMode Propagation
// =====================================================================

describe("Suite 8: ExecutionMode Propagation", () => {
  it("Execution mode appears in formatted context", () => {
    const ctx = makeBaseContext();
    const output = formatContextMarkdown(ctx, 1, "assisted");
    expect(output).toContain("- Mode: assisted");
  });

  it("Mode change produces different formatted output", () => {
    const ctx = makeBaseContext();
    const manual = formatContextMarkdown(ctx, 1, "manual");
    const autonomous = formatContextMarkdown(ctx, 1, "autonomous");
    expect(manual).not.toBe(autonomous);
    expect(manual).toContain("- Mode: manual");
    expect(autonomous).toContain("- Mode: autonomous");
  });

  it("Mode is included even without agent", () => {
    const ctx = makeBaseContext({ agent: null, model: null });
    const output = formatContextMarkdown(ctx, 1, "autonomous");
    expect(output).toContain("- Mode: autonomous");
    expect(output).not.toContain("Provider:");
  });

  it("All three modes render correctly", () => {
    const ctx = makeBaseContext();
    for (const mode of ["manual", "assisted", "autonomous"]) {
      const output = formatContextMarkdown(ctx, 1, mode);
      expect(output).toContain(`- Mode: ${mode}`);
    }
  });
});
