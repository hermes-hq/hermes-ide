// @vitest-environment jsdom
/**
 * N22 — when a queued task may start, through the real hook
 * (useFleetControls) with the backend's answers faked:
 *   - a queue restored at startup waits for the caps and the restored sessions;
 *   - the ⌘N launcher's first agent holds its slot before the list shows it
 *     ("Also on" a second agent must wait);
 *   - a queued task whose start fails stays in the queue, marked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  running: new Set<string>(),
  settings: {} as Record<string, string>,
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../api/git", () => ({ listAllWorktrees: vi.fn(async () => []) }));
vi.mock("../api/settings", () => ({
  getSettings: vi.fn(async () => ({ ...h.settings })),
  setSetting: vi.fn(async (k: string, v: string) => {
    h.settings[k] = v;
  }),
}));

import { useFleetControls } from "../fleet/useFleetControls";
import {
  _resetOccupancyForTest,
  _resetTaskQueueForTest,
  enqueueTask,
  listQueuedTasks,
  queuedNewBranches,
  restoreTaskQueue,
  serializeTaskQueue,
  startTaskNow,
} from "../fleet/taskQueue";
import { _resetAgentLoadForTest } from "../fleet/fleetLoad";
import { _resetFleetCapsForTest, FLEET_SETTING_KEYS, NO_CAPS } from "../fleet/fleetSettings";
import { _resetSessionEventStoreForTest } from "../agent/contract/sessionEventStore";
import { _resetRadarForTest } from "../fleet/radarStore";
import { launchTask, type LaunchTaskDeps } from "../launcher/launchTask";
import type { PlannedAgent, TaskLaunchRequest } from "../components/TaskLauncher";
import type { LaunchChoice } from "../agent/capabilities/types";
import type { CreateSessionOpts, SessionData } from "../types/session";

function session(id: string): SessionData {
  const now = new Date().toISOString();
  return {
    id, label: id, description: "", color: "", group: null, phase: "idle", working_directory: "/work/repo", shell: "/bin/zsh",
    created_at: now, last_activity_at: now, workspace_paths: [], detected_agent: null,
    metrics: {
      output_lines: 0, error_count: 0, stuck_score: 0, token_usage: {}, tool_calls: [], tool_call_summary: {},
      files_touched: [], recent_errors: [], memory_facts: [],
      latency_p50_ms: null, latency_p95_ms: null, latency_samples: [], token_history: [],
    },
    ai_provider: "custom", auto_approve: false, permission_mode: "default", custom_prefix: "", custom_suffix: "",
    channels: [], context_injected: false, ssh_info: null, mode: "terminal",
  };
}

const opts = (label: string): CreateSessionOpts => ({ aiProvider: "custom", label, agentCommand: "fake-agent" });

beforeEach(() => {
  vi.useFakeTimers();
  _resetTaskQueueForTest();
  _resetOccupancyForTest();
  _resetAgentLoadForTest();
  _resetFleetCapsForTest(NO_CAPS);
  _resetSessionEventStoreForTest();
  _resetRadarForTest();
  h.running.clear();
  h.settings = { [FLEET_SETTING_KEYS.maxRunning]: "1" };
  h.invoke.mockReset();
  h.invoke.mockImplementation(async (cmd: string, args: { sessionIds?: string[] }) => {
    if (cmd === "fleet_agent_load") return (args.sessionIds ?? []).map((id) => ({ sessionId: id, running: h.running.has(id), memoryBytes: 0 }));
    if (cmd === "list_turns") return [];
    return null;
  });
});
afterEach(() => {
  vi.useRealTimers();
});

type Props = { sessions: SessionData[]; ready: boolean };

function mount(startTask: (o: CreateSessionOpts) => Promise<{ id: string } | null>, initial: Props) {
  return renderHook(
    ({ sessions, ready }: Props) => useFleetControls({ enabled: true, ready, sessions, startTask, t: (k) => k }),
    { initialProps: initial },
  );
}

describe("a queue restored at startup", () => {
  it("waits for the caps and the restored sessions, then keeps to the cap", async () => {
    const started: string[] = [];
    const startTask = vi.fn(async (o: CreateSessionOpts) => {
      started.push(o.label ?? "");
      return { id: `q${started.length}` };
    });
    const stored = serializeTaskQueue([
      { id: "a", opts: opts("queued one"), label: "queued one", enqueuedAt: 1 },
      { id: "b", opts: opts("queued two"), label: "queued two", enqueuedAt: 2 },
    ]);
    const hook = mount(startTask, { sessions: [], ready: false });
    // App reads the stored queue before the caps are read and the workspace is restored.
    act(() => {
      restoreTaskQueue(stored);
    });
    expect(started).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10); // the caps load
    });
    expect(started).toEqual([]);
    // The agent kept running by the session host is back: the one slot is taken.
    h.running.add("restored");
    await act(async () => {
      hook.rerender({ sessions: [session("restored")], ready: true });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(started).toEqual([]);
    expect(listQueuedTasks().map((t) => t.label)).toEqual(["queued one", "queued two"]);
  });

  it("read before the caps: never started as if there were no cap", async () => {
    const started: string[] = [];
    const startTask = vi.fn(async (o: CreateSessionOpts) => {
      started.push(o.label ?? "");
      return { id: `q${started.length}` };
    });
    mount(startTask, { sessions: [], ready: true });
    act(() => {
      restoreTaskQueue(serializeTaskQueue([
        { id: "a", opts: opts("queued one"), label: "queued one", enqueuedAt: 1 },
        { id: "b", opts: opts("queued two"), label: "queued two", enqueuedAt: 2 },
      ]));
    });
    expect(started).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10); // the caps load: cap 1
    });
    expect(started).toEqual(["queued one"]);
    expect(listQueuedTasks().map((t) => t.label)).toEqual(["queued two"]);
  });
});

const CHOICE: LaunchChoice = {
  agentId: "claude", accountId: "default", approvalModeId: "acceptEdits", modelId: "default", effort: null,
  extraArgs: "", prefix: "", channels: [], where: { kind: "new-worktree", baseBranch: "", branch: "" }, trackAsFeature: false,
};
function agent(id: string, branch: string): PlannedAgent {
  return {
    id, mode: "terminal", branch, createBranch: true, baseBranch: "", worktree: true,
    launch: { permissionMode: "acceptEdits", customPrefix: "", customSuffix: "", channels: [] },
    choice: { ...CHOICE, agentId: id },
  };
}

describe("the launcher's \"Also on\" second agent", () => {
  it("waits in the queue when the first agent takes the last slot", async () => {
    let sessions: SessionData[] = [];
    const hook = mount(async () => null, { sessions, ready: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10); // the caps load
    });
    const created: string[] = [];
    const deps: LaunchTaskDeps = {
      projectFor: async () => "p1",
      // React shows the new session in a later task, not before the next agent is judged.
      createSession: async (o) => {
        created.push(o.aiProvider ?? "");
        const s = session(`s${created.length}`);
        setTimeout(() => {
          sessions = [...sessions, s];
          hook.rerender({ sessions, ready: true });
        }, 0);
        return s;
      },
      queue: (o, label, launch) => hook.result.current.queueIfFull(o, label, launch),
      started: (id) => hook.result.current.noteStarted(id),
      place: () => {},
      worktreePath: async () => null,
      writeFeatureFile: async () => "",
      copyText: async () => {},
      readRecords: async () => "",
      writeRecords: async () => {},
      now: () => 1,
    };
    const req: TaskLaunchRequest = {
      task: "Fix the login bug", repoRoot: "/work/repo", track: "Quick", doneWhen: [], choice: CHOICE,
      agents: [agent("claude", "hermes/fix-the-login-bug"), agent("codex", "hermes/fix-the-login-bug-codex")],
    };
    let queued = 0;
    await act(async () => {
      queued = (await launchTask(req, deps)).queued;
    });
    expect(created).toEqual(["claude"]);
    expect(queued).toBe(1);
  });
});

describe("a launcher agent closed before the next queue check", () => {
  it("frees its slot: the next task starts instead of waiting", async () => {
    const hook = mount(async () => null, { sessions: [], ready: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10); // the caps load: cap 1
    });
    // The launcher's agent holds the slot until the list shows it...
    act(() => hook.result.current.noteStarted("s1"));
    await act(async () => {
      hook.rerender({ sessions: [session("s1")], ready: true });
      await vi.advanceTimersByTimeAsync(10);
    });
    // ...then it finishes and is closed, with nothing waiting in between.
    await act(async () => {
      hook.rerender({ sessions: [], ready: true });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(hook.result.current.queueIfFull(opts("two"), "two")).toBe(false);
    expect(listQueuedTasks()).toEqual([]);
  });
});

describe("a queued task whose start fails", () => {
  it("stays in the queue, marked, never retried on its own; the next one still starts; Start now tries it again", async () => {
    let fail = true;
    const started: string[] = [];
    const startTask = vi.fn(async (o: CreateSessionOpts) => {
      started.push(o.label ?? "");
      if (fail && o.label === "broken") return null;
      return { id: `q${started.length}` };
    });
    mount(startTask, { sessions: [], ready: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10); // the caps load
    });
    // Cap 1 and a free slot: it starts at once, and its start fails.
    await act(async () => {
      enqueueTask(opts("broken"), "broken");
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(started).toEqual(["broken"]);
    expect(listQueuedTasks().map((t) => [t.label, !!t.failed])).toEqual([["broken", true]]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(started).toEqual(["broken"]);
    await act(async () => {
      enqueueTask(opts("fine"), "fine");
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(started).toEqual(["broken", "fine"]);
    expect(listQueuedTasks().map((t) => t.label)).toEqual(["broken"]);
    fail = false;
    await act(async () => {
      startTaskNow(listQueuedTasks()[0].id);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(started).toEqual(["broken", "fine", "broken"]);
    expect(listQueuedTasks()).toEqual([]);
  });
});

describe("queuedNewBranches", () => {
  it("lists the new branches queued tasks in that folder will make", () => {
    const sel = (branch: string, createNew: boolean) => ({ p1: { branch, createNew } });
    const list = [
      { id: "a", label: "a", enqueuedAt: 1, opts: { ...opts("a"), workingDirectory: "/work/repo", branchSelections: sel("hermes/fix-login", true) } },
      { id: "b", label: "b", enqueuedAt: 2, opts: { ...opts("b"), workingDirectory: "/work/repo/", branchSelections: sel("main", false) } },
      { id: "c", label: "c", enqueuedAt: 3, opts: { ...opts("c"), workingDirectory: "/work/other", branchSelections: sel("hermes/other", true) } },
    ];
    expect(queuedNewBranches(list, "/work/repo/")).toEqual(["hermes/fix-login"]);
    expect(queuedNewBranches(list, "")).toEqual([]);
  });
});
