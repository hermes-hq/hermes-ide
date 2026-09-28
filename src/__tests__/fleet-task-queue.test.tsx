// @vitest-environment jsdom
/**
 * N22 — task queue and concurrency cap: with the cap at 3 and 5 agent tasks
 * launched, 2 wait and start as others finish. Driven through the real
 * hook (useFleetControls) with the backend's answers faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  running: new Set<string>(),
  memory: new Map<string, number>(),
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
  hasFreeSlot,
  listQueuedTasks,
  occupiesSlot,
  removeTask,
  startTaskNow,
  STARTUP_GRACE_MS,
  type SlotInput,
} from "../fleet/taskQueue";
import { _resetAgentLoadForTest, LOAD_POLL_IDLE_MS, LOAD_POLL_MS } from "../fleet/fleetLoad";
import { _resetFleetCapsForTest, FLEET_SETTING_KEYS, NO_CAPS, setFleetCap } from "../fleet/fleetSettings";
import { _resetSessionEventStoreForTest, dispatchSessionEvent } from "../agent/contract/sessionEventStore";
import { _resetRadarForTest } from "../fleet/radarStore";
import type { CreateSessionOpts, SessionData } from "../types/session";

const IDLE = { kind: "idle", confidence: "guessed", detail: "" } as const;
const base: SlotInput = {
  isAgent: true,
  closed: false,
  status: IDLE,
  statusReported: false,
  startupEnded: false,
  running: true,
  seenRunning: true,
  ageMs: 60_000,
};

describe("occupiesSlot", () => {
  it.each<[string, Partial<SlotInput>, boolean]>([
    ["a running agent holds a slot", {}, true],
    ["a plain shell never does", { isAgent: false }, false],
    ["a closed session never does", { closed: true }, false],
    ["the agent exited (hi helper)", { startupEnded: true }, false],
    ["the agent said its turn is done", { statusReported: true, status: { kind: "done_unread", confidence: "exact", detail: "" } }, false],
    ["the agent said it is idle", { statusReported: true, status: { kind: "idle", confidence: "exact", detail: "" } }, false],
    ["the agent exited (event)", { statusReported: true, status: { kind: "exited", confidence: "exact", detail: "" } }, false],
    ["waiting for approval still holds it", { statusReported: true, status: { kind: "needs_approval", confidence: "exact", detail: "" } }, true],
    ["the program ended after running", { running: false, seenRunning: true }, false],
    ["a new session whose agent has not shown up yet", { running: false, seenRunning: false, ageMs: 1000 }, true],
    ["...until the grace period is over", { running: false, seenRunning: false, ageMs: STARTUP_GRACE_MS }, false],
    ["no process to look at (Agent view)", { running: null }, true],
  ])("%s", (_name, over, expected) => {
    expect(occupiesSlot({ ...base, ...over })).toBe(expected);
  });
});

describe("hasFreeSlot", () => {
  const occ = (n: number, mb = 0) => ({ sessionIds: Array.from({ length: n }, (_, i) => `s${i}`), memoryBytes: mb * 1024 * 1024 });
  it("counts running agents and the ones starting against the count cap", () => {
    expect(hasFreeSlot(occ(2), { maxRunning: 3, maxMemoryMb: null })).toBe(true);
    expect(hasFreeSlot(occ(3), { maxRunning: 3, maxMemoryMb: null })).toBe(false);
    expect(hasFreeSlot(occ(2), { maxRunning: 3, maxMemoryMb: null }, 1)).toBe(false);
  });
  it("holds new tasks while running agents use the memory cap", () => {
    expect(hasFreeSlot(occ(1, 511), { maxRunning: null, maxMemoryMb: 512 })).toBe(true);
    expect(hasFreeSlot(occ(1, 512), { maxRunning: null, maxMemoryMb: 512 })).toBe(false);
  });
});

describe("the queue", () => {
  beforeEach(() => {
    _resetTaskQueueForTest(() => 7);
    _resetOccupancyForTest();
  });
  it("is first in, first out; remove and start-now take a task out once", () => {
    const a = enqueueTask({ aiProvider: "claude" }, "A");
    const b = enqueueTask({ aiProvider: "codex" }, "B");
    expect(listQueuedTasks().map((t) => t.label)).toEqual(["A", "B"]);
    expect(a.enqueuedAt).toBe(7);
    expect(removeTask(a.id)?.label).toBe("A");
    expect(removeTask(a.id)).toBeNull();
    expect(startTaskNow(b.id)).toBe(false); // nobody registered a starter
    expect(listQueuedTasks()).toHaveLength(1);
  });
});

// ── The whole loop through the hook ──────────────────────────────────

function session(id: string, over: Partial<SessionData> = {}): SessionData {
  const now = new Date().toISOString();
  return {
    id,
    label: id,
    description: "",
    color: "",
    group: null,
    phase: "idle",
    working_directory: "/work/repo",
    shell: "/bin/zsh",
    created_at: now,
    last_activity_at: now,
    workspace_paths: [],
    detected_agent: null,
    metrics: {
      output_lines: 0, error_count: 0, stuck_score: 0, token_usage: {}, tool_calls: [], tool_call_summary: {},
      files_touched: [], recent_errors: [], recent_actions: [], available_actions: [], memory_facts: [],
      latency_p50_ms: null, latency_p95_ms: null, latency_samples: [], token_history: [],
    },
    ai_provider: "custom",
    auto_approve: false,
    permission_mode: "default",
    custom_prefix: "",
    custom_suffix: "",
    channels: [],
    context_injected: false,
    ssh_info: null,
    mode: "terminal",
    ...over,
  };
}

describe("useFleetControls: cap 3, five tasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetTaskQueueForTest();
    _resetOccupancyForTest();
    _resetAgentLoadForTest();
    _resetFleetCapsForTest(NO_CAPS);
    _resetSessionEventStoreForTest();
    _resetRadarForTest();
    h.running.clear();
    h.memory.clear();
    h.settings = { [FLEET_SETTING_KEYS.maxRunning]: "3" };
    h.invoke.mockReset();
    h.invoke.mockImplementation(async (cmd: string, args: { sessionIds?: string[] }) => {
      if (cmd === "fleet_agent_load") {
        return (args.sessionIds ?? []).map((id) => ({ sessionId: id, running: h.running.has(id), memoryBytes: h.memory.get(id) ?? 0 }));
      }
      if (cmd === "list_turns") return [];
      return null;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mount() {
    let sessions: SessionData[] = [];
    const started: CreateSessionOpts[] = [];
    const startTask = vi.fn(async (opts: CreateSessionOpts) => {
      const id = `t${started.length + 1}`;
      started.push(opts);
      sessions = [...sessions, session(id, { label: opts.label ?? id })];
      h.running.add(id); // its agent starts
      hook.rerender({ sessions });
      return { id };
    });
    const hook = renderHook(
      ({ sessions: list }: { sessions: SessionData[] }) =>
        useFleetControls({ enabled: true, sessions: list, startTask, t: (k) => k }),
      { initialProps: { sessions } },
    );
    /** What the New Session wizard does on Create. */
    const launch = async (label: string) => {
      const opts: CreateSessionOpts = { aiProvider: "custom", label, agentCommand: "fake-agent" };
      if (!hook.result.current.queueIfFull(opts, label)) await startTask(opts);
    };
    const finish = async (id: string) => {
      h.running.delete(id);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
    };
    return { hook, launch, finish, started, sessionsOf: () => sessions };
  }

  it("runs 3, queues 2, and starts them as others finish, oldest first", async () => {
    const { launch, finish, started } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10); // the caps load
    });
    for (const label of ["one", "two", "three", "four", "five"]) {
      await act(async () => {
        await launch(label);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
    }
    expect(started.map((o) => o.label)).toEqual(["one", "two", "three"]);
    expect(listQueuedTasks().map((t) => t.label)).toEqual(["four", "five"]);

    await finish("t2");
    expect(started.map((o) => o.label)).toEqual(["one", "two", "three", "four"]);
    expect(listQueuedTasks().map((t) => t.label)).toEqual(["five"]);

    // Nothing else finished: five keeps waiting.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(started).toHaveLength(4);

    // An agent that says its turn is done frees its slot too.
    await act(async () => {
      dispatchSessionEvent("t1", { type: "status", at: 1, status: { kind: "done_unread", confidence: "exact", detail: "" } });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(started.map((o) => o.label)).toEqual(["one", "two", "three", "four", "five"]);
    expect(listQueuedTasks()).toEqual([]);
  });

  it("negative control: without a cap nothing waits", async () => {
    h.settings = {};
    const { launch, started } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    for (const label of ["one", "two", "three", "four", "five"]) {
      await act(async () => {
        await launch(label);
      });
    }
    expect(started).toHaveLength(5);
    expect(listQueuedTasks()).toEqual([]);
  });

  it("turning the cap off starts everything that waits; Start now skips the wait", async () => {
    const { launch, started } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    for (const label of ["one", "two", "three", "four", "five"]) {
      await act(async () => {
        await launch(label);
      });
    }
    expect(listQueuedTasks().map((t) => t.label)).toEqual(["four", "five"]);
    await act(async () => {
      startTaskNow(listQueuedTasks()[1].id);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(started.map((o) => o.label).at(-1)).toBe("five");
    expect(listQueuedTasks().map((t) => t.label)).toEqual(["four"]);
    await act(async () => {
      await setFleetCap("maxRunning", null);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(started).toHaveLength(5);
    expect(listQueuedTasks()).toEqual([]);
  });

  it("a memory cap holds tasks while running agents use that much", async () => {
    h.settings = { [FLEET_SETTING_KEYS.maxMemoryMb]: "100" };
    const { launch, finish, started } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await launch("big");
    });
    h.memory.set("t1", 150 * 1024 * 1024);
    await act(async () => {
      // Nothing waits yet: the load is read every LOAD_POLL_IDLE_MS.
      await vi.advanceTimersByTimeAsync(LOAD_POLL_IDLE_MS + 100);
    });
    await act(async () => {
      await launch("small");
    });
    expect(started.map((o) => o.label)).toEqual(["big"]);
    expect(listQueuedTasks().map((t) => t.label)).toEqual(["small"]);
    await finish("t1");
    expect(started.map((o) => o.label)).toEqual(["big", "small"]);
  });

  it("reads the process table every few seconds, and every second only while tasks wait", async () => {
    const { launch } = mount();
    const polls = () => h.invoke.mock.calls.filter(([cmd]) => cmd === "fleet_agent_load").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      await launch("one");
    });
    let before = polls();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    // Nothing waits: one poll per LOAD_POLL_IDLE_MS (3 s), not per second.
    expect(polls() - before).toBeLessThanOrEqual(Math.ceil(9_000 / LOAD_POLL_IDLE_MS));
    expect(polls() - before).toBeGreaterThanOrEqual(2);

    for (const label of ["two", "three", "four"]) {
      await act(async () => {
        await launch(label);
      });
    }
    expect(listQueuedTasks().map((t) => t.label)).toEqual(["four"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOAD_POLL_IDLE_MS); // the idle timer already set
    });
    before = polls();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    // "four" waits: the load is read every LOAD_POLL_MS (1 s).
    expect(polls() - before).toBeGreaterThanOrEqual(Math.floor(5_000 / LOAD_POLL_MS) - 1);
  });

  it("without a cap the process table is never read", async () => {
    h.settings = {};
    const { launch } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await launch("one");
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(h.invoke.mock.calls.some(([cmd]) => cmd === "fleet_agent_load")).toBe(false);
  });

  it("a plain shell (no agent) is never queued", async () => {
    const { hook } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(hook.result.current.queueIfFull({ label: "shell" }, "shell")).toBe(false);
  });
});
