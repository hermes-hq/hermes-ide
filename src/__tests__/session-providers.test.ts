/**
 * F19 — one event contract for every session.
 *
 *  - The TerminalProvider turns what Hermes sees of any terminal session
 *    (PTY phase, launch-helper startup, exit, identity) into SessionEvents.
 *  - The Agent view provider maps the optional structured view into the
 *    same events.
 *  - The contract test runs ONE event script against every provider (the
 *    terminal, the Agent view, and the hook-signal mapping F11 extends):
 *    each step a provider can observe must derive the same status, and
 *    every event it emits must survive the wire parser unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { parseSessionEvent, type SessionEvent } from "../agent/contract/events";
import {
  _resetSessionEventStoreForTest,
  dispatchSessionEvent,
  getSessionEventSnapshot,
  reduceSessionEvent,
  type SessionEventSnapshot,
} from "../agent/contract/sessionEventStore";
import type { AgentStatusKind, Confidence } from "../agent/contract/status";
import { signalRecordToSessionEvent, type SignalRecord } from "../agent/contract/signal";
import { AgentSessionStore, type AgentViewSnapshot } from "../agent/agentSessionStore";
import type { AgentEvent } from "../agent/types";
import { deriveStatus, certaintyRank } from "../agent/status/deriveStatus";
import { _resetAttentionStoreForTest, getSessionStatus, markSessionSeen } from "../agent/status/attentionStore";
import { terminalObservationOf, terminalProvider, type TerminalObservation } from "../agent/providers/terminalProvider";
import { agentViewObservationOf, agentViewProvider, approvalDetail, type AgentViewObservation } from "../agent/providers/agentViewProvider";
import { ProviderRegistry } from "../agent/providers/types";
import { syncTerminalSessions, terminalRegistry } from "../agent/providers/useSessionProviders";
import { trustedStatus } from "../attention/statusBridge";
import type { SessionData } from "../types/session";

afterEach(() => {
  _resetSessionEventStoreForTest();
  _resetAttentionStoreForTest();
  for (const id of terminalRegistry.ids()) terminalRegistry.forget(id);
});

const EMPTY: SessionEventSnapshot = getSessionEventSnapshot("__empty__");

function session(over: Partial<SessionData> = {}): SessionData {
  return {
    id: "t1",
    label: "t1",
    description: "",
    color: "",
    group: null,
    phase: "creating",
    working_directory: "/work/project",
    shell: "/bin/zsh",
    created_at: "2026-01-01T00:00:00Z",
    last_activity_at: "2026-01-01T00:00:00Z",
    workspace_paths: [],
    detected_agent: null,
    metrics: {} as SessionData["metrics"],
    ai_provider: null,
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

const obs = (over: Partial<TerminalObservation> = {}): TerminalObservation => ({
  phase: "idle",
  startup: null,
  vendorSessionId: null,
  model: null,
  permissionMode: null,
  ...over,
});

describe("TerminalProvider", () => {
  it("every terminal phase maps to a guessed status from the pty", () => {
    const table: [string, AgentStatusKind][] = [
      ["creating", "starting"],
      ["shell_ready", "idle"],
      ["idle", "idle"],
      ["busy", "working"],
      ["needs_input", "needs_answer"],
    ];
    for (const [phase, kind] of table) {
      const [e] = terminalProvider.observe(null, obs({ phase }), 5);
      expect(e).toEqual({ type: "status", at: 5, source: "pty", status: { kind, confidence: "guessed", detail: "" } });
    }
  });

  it("a destroyed session is an exit; an unknown phase says nothing", () => {
    expect(terminalProvider.observe(obs(), obs({ phase: "destroyed" }), 1)).toEqual([
      { type: "exit", at: 1, source: "pty", code: null, signal: null },
    ]);
    expect(terminalProvider.observe(obs(), obs({ phase: "disconnected" }), 1)).toEqual([]);
  });

  it("emits nothing when nothing changed", () => {
    expect(terminalProvider.observe(obs(), obs(), 1)).toEqual([]);
  });

  it("the launch helper's startup states come first, with the helper's confidence and detail", () => {
    const waiting = obs({ phase: "busy", startup: { state: "waiting_at_startup_prompt", confidence: "guessed", detail: "folder trust" } });
    const events = terminalProvider.observe(obs({ phase: "busy", startup: { state: "launching", confidence: "exact", detail: "" } }), waiting, 7);
    expect(events[0]).toEqual({ type: "status", at: 7, source: "hi", status: { kind: "startup_prompt", confidence: "guessed", detail: "folder trust" } });
    // The terminal's current phase follows, so it takes over once allowed.
    expect(events[1]).toMatchObject({ type: "status", source: "pty", status: { kind: "working" } });
  });

  it("identity: Hermes's conversation id, the model seen, the permission mode of an agent session", () => {
    const s = session({ ai_provider: "some-agent", vendor_session_id: "vs-1", detected_agent: { name: "A", provider: "p", model: "m-1", detected_at: "", confidence: 1 } });
    const events = terminalProvider.observe(null, terminalObservationOf(s), 1);
    expect(events.find((e) => e.type === "identity")).toEqual({
      type: "identity",
      at: 1,
      source: "hermes",
      vendorSessionId: "vs-1",
      model: "m-1",
      permissionMode: "default",
    });
    // A plain shell has no permission mode to report.
    expect(terminalObservationOf(session()).permissionMode).toBeNull();
  });

  it("drives the real precedence: a hi launch shows starting, then the startup-prompt guess, then activity", () => {
    const reg = new ProviderRegistry(terminalProvider, dispatchSessionEvent);
    const at = (s: Partial<SessionData>, t: number) => reg.observe("h", terminalObservationOf(session({ id: "h", ...s })), t);
    const kind = () => getSessionStatus("h").kind;
    at({ phase: "creating", agent_startup: { state: "launching", since: "", confidence: "exact" } }, 1);
    expect(kind()).toBe("starting");
    at({ phase: "busy", agent_startup: { state: "launching", since: "", confidence: "exact" } }, 2);
    expect(kind()).toBe("starting"); // the agent booting is not "working"
    at({ phase: "needs_input", agent_startup: { state: "waiting_at_startup_prompt", since: "", confidence: "guessed", detail: "trust?" } }, 3);
    expect(getSessionStatus("h")).toMatchObject({ kind: "startup_prompt", confidence: "guessed", detail: "trust?" });
    at({ phase: "idle", agent_startup: { state: "started", since: "", confidence: "exact" } }, 4);
    expect(kind()).toBe("idle");
    at({ phase: "busy", agent_startup: { state: "started", since: "", confidence: "exact" } }, 5);
    expect(getSessionStatus("h")).toMatchObject({ kind: "working", confidence: "guessed" });
    at({ phase: "idle", agent_startup: { state: "ended", since: "", confidence: "exact", detail: "the agent exited with status 2" } }, 6);
    expect(getSessionStatus("h")).toMatchObject({ kind: "exited", confidence: "exact" });
  });

  it("an agent that asks as soon as it (re)starts keeps its question: the helper's later 'started' does not turn it idle", () => {
    const known = new Set<string>();
    const launching = { state: "launching" as const, since: "", confidence: "exact" };
    const started = { state: "started" as const, since: "", confidence: "exact" };
    syncTerminalSessions([session({ id: "r", phase: "busy", ai_provider: "claude", agent_startup: launching })], known, 1);
    // The agent's own hooks arrive first (SessionStart, then its question)…
    dispatchSessionEvent("r", { type: "status", at: 2, source: "hook:claude", status: { kind: "idle", confidence: "exact", detail: "" } });
    dispatchSessionEvent("r", { type: "status", at: 2, source: "hook:claude", status: { kind: "needs_approval", confidence: "exact", detail: "Bash" } });
    // …then the session update that says the helper saw it start.
    syncTerminalSessions([session({ id: "r", phase: "busy", ai_provider: "claude", agent_startup: started })], known, 3);
    // What the inbox and the strip read: the last status that is not the terminal's own guess.
    const reported = getSessionEventSnapshot("r").events.filter((e) => e.type === "status" && e.source !== "pty").at(-1);
    expect(reported).toMatchObject({ source: "hook:claude", status: { kind: "needs_approval", confidence: "exact" } });
    expect(trustedStatus(getSessionEventSnapshot("r"))).toMatchObject({ kind: "needs_approval", confidence: "exact" });

    // An agent that reported nothing still becomes idle when the helper says it started.
    syncTerminalSessions([session({ id: "q", phase: "busy", ai_provider: "claude", agent_startup: launching })], known, 4);
    syncTerminalSessions([session({ id: "q", phase: "idle", ai_provider: "claude", agent_startup: started })], known, 5);
    expect(getSessionEventSnapshot("q").events.some((e) => e.type === "status" && e.source === "hi" && e.status.kind === "idle")).toBe(true);
  });

  it("a relaunch after the previous run ended or was refused: the helper's 'started' is the news again", () => {
    const known = new Set<string>();
    const started = (detail: string) => ({ state: "started" as const, since: "", confidence: "exact", detail });
    const hiIdle = () => getSessionEventSnapshot("t").events.filter((e) => e.type === "status" && e.source === "hi" && e.status.kind === "idle").length;
    syncTerminalSessions([session({ id: "t", phase: "idle", ai_provider: "claude", agent_startup: started("run 1") })], known, 1);
    expect(hiIdle()).toBe(1);
    // The CLI refused the model: its hook said it ended, the launch was refused…
    dispatchSessionEvent("t", { type: "status", at: 2, source: "hook:claude", status: { kind: "working", confidence: "exact", detail: "" } });
    dispatchSessionEvent("t", { type: "status", at: 3, source: "hook:claude", status: { kind: "exited", confidence: "exact", detail: "" } });
    // …and "Retry with default" started it again.
    syncTerminalSessions([session({ id: "t", phase: "idle", ai_provider: "claude", agent_startup: started("run 2") })], known, 4);
    expect(hiIdle()).toBe(2);
    expect(trustedStatus(getSessionEventSnapshot("t"))).toMatchObject({ kind: "idle" });

    const rejected = parseSessionEvent({ type: "launch_rejected", at: 5, source: "hermes", reason: "model", vendorMessage: "unknown model", suggestion: "retry-default" });
    if (rejected) dispatchSessionEvent("t", rejected);
    syncTerminalSessions([session({ id: "t", phase: "idle", ai_provider: "claude", agent_startup: started("run 3") })], known, 6);
    expect(hiIdle()).toBe(rejected ? 3 : 2);
    expect(rejected).not.toBeNull();
  });

  it("syncTerminalSessions observes terminal sessions, skips Agent-view ones, forgets closed ones", () => {
    const known = new Set<string>();
    syncTerminalSessions([session({ id: "x", phase: "busy" }), session({ id: "v", mode: "agent", phase: "idle" })], known, 1);
    expect(getSessionEventSnapshot("x").status.kind).toBe("working");
    expect(getSessionEventSnapshot("v").version).toBe(0);
    markSessionSeen("x", 1);
    syncTerminalSessions([], known, 2);
    expect(getSessionEventSnapshot("x").version).toBe(0);
    expect(terminalRegistry.has("x")).toBe(false);
    expect(known.size).toBe(0);
  });
});

// ── Agent view ─────────────────────────────────────────────────────────

const INIT = {
  type: "system",
  subtype: "init",
  cwd: "/work/project",
  session_id: "vs-agent-1",
  uuid: "u0",
  tools: ["Bash"],
  slash_commands: [],
  mcp_servers: [],
  model: "fake-model-1",
  permissionMode: "default",
} as unknown as AgentEvent;
const TOOL_USE = {
  type: "assistant",
  message: { id: "m1", type: "message", role: "assistant", model: "fake-model-1", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "rm -rf build" } }], stop_reason: "tool_use" },
  session_id: "vs-agent-1",
  parent_tool_use_id: null,
} as unknown as AgentEvent;
const PERM = { type: "_hermes_perm_request", id: "p1", toolName: "Bash", input: { command: "rm -rf build" } } as unknown as AgentEvent;
const TOOL_RESULT = {
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
  session_id: "vs-agent-1",
  parent_tool_use_id: null,
} as unknown as AgentEvent;
const RESULT_OK = { type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "vs-agent-1", uuid: "r1" } as unknown as AgentEvent;
const RESULT_ERR = { type: "result", subtype: "error_during_execution", is_error: true, session_id: "vs-agent-1", uuid: "r2" } as unknown as AgentEvent;

/** The store ignores an exit within 300 ms of an init (a respawn race); step past it. */
function afterInitGrace(): void {
  vi.setSystemTime(Date.now() + 1_000);
}

function agentStore(): AgentSessionStore {
  return new AgentSessionStore("av", async () => () => {});
}

describe("Agent view provider", () => {
  it("maps the view's picture: starting, idle, working, needs approval (with the command), done, error, exited", () => {
    const store = agentStore();
    const seen: AgentStatusKind[] = [];
    const push = () => seen.push(agentViewObservationOf(store.getSnapshot()).kind);
    push();
    store.injectEvent(INIT);
    push();
    store.injectEvent(TOOL_USE);
    push();
    store.injectEvent(PERM);
    const waiting = agentViewObservationOf(store.getSnapshot());
    expect(waiting).toMatchObject({ kind: "needs_approval", detail: "Bash: rm -rf build", vendorSessionId: "vs-agent-1", model: "fake-model-1", permissionMode: "default" });
    push();
    store.clearPendingPermRequest();
    store.injectEvent(TOOL_RESULT);
    store.injectEvent(RESULT_OK);
    push();
    store.injectEvent(RESULT_ERR);
    push();
    vi.useFakeTimers();
    afterInitGrace();
    store.injectExit({ code: 1, signal: null });
    vi.useRealTimers();
    push();
    expect(seen).toEqual(["starting", "idle", "working", "needs_approval", "done_unread", "error", "exited"]);
  });

  it("emits a status only when it changes, identity once, and an exit instead of a status", () => {
    const a: AgentViewObservation = { kind: "idle", detail: "", exit: null, vendorSessionId: "v", model: "m", permissionMode: "default" };
    const first = agentViewProvider.observe(null, a, 1);
    expect(first.map((e) => e.type)).toEqual(["identity", "status"]);
    expect(agentViewProvider.observe(a, a, 2)).toEqual([]);
    const exited = agentViewProvider.observe(a, { ...a, kind: "exited", exit: { code: 0, signal: null } }, 3);
    expect(exited).toEqual([{ type: "exit", at: 3, source: "agent-view", code: 0, signal: null }]);
  });

  it("approvalDetail names the tool and what it acts on, on one short line", () => {
    expect(approvalDetail("Edit", { file_path: "src/a.ts" })).toBe("Edit: src/a.ts");
    expect(approvalDetail("Mystery", {})).toBe("Mystery");
    expect(approvalDetail("Bash", { command: "echo\n".repeat(100) }).length).toBeLessThanOrEqual(200);
  });
});

// ── The contract test: one script, every provider ─────────────────────

type Step = "start" | "ready" | "working" | "approval" | "question" | "done" | "exit";
const SCRIPT: [Step, AgentStatusKind][] = [
  ["start", "starting"],
  ["ready", "idle"],
  ["working", "working"],
  ["approval", "needs_approval"],
  ["working", "working"],
  ["question", "needs_answer"],
  ["working", "working"],
  ["done", "done_unread"],
  ["exit", "exited"],
];

/** Drives one provider through its own native inputs. Null: cannot observe this step. */
interface Harness {
  name: string;
  capability: Confidence;
  step(step: Step, at: number): SessionEvent[] | null;
}

function terminalHarness(): Harness {
  let prev: TerminalObservation | null = null;
  const phaseOf: Partial<Record<Step, string>> = { start: "creating", ready: "shell_ready", working: "busy", question: "needs_input", exit: "destroyed" };
  return {
    name: "terminal",
    capability: terminalProvider.capabilities.status,
    step(step, at) {
      const phase = phaseOf[step];
      if (!phase) return null;
      const next = obs({ phase });
      const events = terminalProvider.observe(prev, next, at);
      prev = next;
      return events;
    },
  };
}

function agentViewHarness(): Harness {
  const store = agentStore();
  let prev: AgentViewObservation | null = null;
  let turn = 0;
  const feed: Partial<Record<Step, () => void>> = {
    start: () => {},
    ready: () => store.injectEvent(INIT),
    working: () => {
      turn++;
      store.clearPendingPermRequest();
      store.injectEvent({ ...(TOOL_USE as object), message: { ...(TOOL_USE as { message: object }).message, id: `m${turn}`, content: [{ type: "tool_use", id: `tu${turn}`, name: "Bash", input: { command: "ls" } }] } } as unknown as AgentEvent);
    },
    approval: () => store.injectEvent(PERM),
    done: () => {
      store.injectEvent({ ...(TOOL_RESULT as object), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu${turn}`, content: "ok" }] } } as unknown as AgentEvent);
      store.injectEvent(RESULT_OK);
    },
    exit: () => {
      vi.useFakeTimers();
      afterInitGrace();
      store.injectExit({ code: 0, signal: null });
      vi.useRealTimers();
    },
  };
  return {
    name: "agent-view",
    capability: agentViewProvider.capabilities.status,
    step(step, at) {
      const f = feed[step];
      if (!f) return null;
      f();
      const next = agentViewObservationOf(store.getSnapshot() as AgentViewSnapshot);
      const events = agentViewProvider.observe(prev, next, at);
      prev = next;
      return events;
    },
  };
}

function hookSignalHarness(): Harness {
  const eventName: Partial<Record<Step, string>> = {
    working: "PostToolUse",
    approval: "PermissionRequest",
    question: "AskUserQuestion",
    done: "Stop",
    exit: "SessionEnd",
  };
  return {
    name: "hook signals",
    capability: "exact",
    step(step, at) {
      const event = eventName[step];
      if (!event) return null;
      const record: SignalRecord = { v: 1, ts: at / 1000, session: "s", agent: "fake-agent", nonce: "n0", event, payload: {} };
      const e = signalRecordToSessionEvent(record, "n0");
      return e ? [e] : [];
    },
  };
}

describe("contract: the same event script against every provider", () => {
  const harnesses = [terminalHarness, agentViewHarness, hookSignalHarness];

  it.each(harnesses.map((h) => [h().name, h] as const))("%s", (_name, make) => {
    const h = make();
    let snapshot = EMPTY;
    let observed = 0;
    SCRIPT.forEach(([step, expected], i) => {
      const at = 1_000 * (i + 1);
      const events = h.step(step, at);
      if (events === null) return; // this provider cannot see this step
      observed++;
      for (const e of events) {
        // Wire-valid: survives JSON and the validating parser unchanged.
        expect(parseSessionEvent(JSON.parse(JSON.stringify(e)))).toEqual(e);
        if (e.type === "status") {
          expect(certaintyRank(e.status.confidence, e.source)).toBeLessThanOrEqual(certaintyRank(h.capability, e.source));
        }
        snapshot = reduceSessionEvent(snapshot, e);
      }
      const derived = deriveStatus({ snapshot, seenAt: null });
      expect(`${step} -> ${derived.kind}`).toBe(`${step} -> ${expected}`);
    });
    expect(observed).toBeGreaterThanOrEqual(4);
  });

  it("a wrong mapping fails the script (negative control)", () => {
    const h = hookSignalHarness();
    const e = h.step("approval", 1000)!;
    const snapshot = e.reduce(reduceSessionEvent, EMPTY);
    expect(deriveStatus({ snapshot, seenAt: null }).kind).not.toBe("idle");
  });
});
