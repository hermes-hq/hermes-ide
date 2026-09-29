/**
 * N19: usage limits and handoff — the store's `limit` event, the words for
 * a limit, the inbox item, the seed prompt, the child branch, the agents a
 * task can go to, the list nesting and the handoff's order and undo.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  _resetSessionEventStoreForTest,
  clearSessionEvents,
  dispatchSessionEvent,
  getSessionEventSnapshot,
  reduceSessionEvent,
  subscribeAllSessionEvents,
} from "../agent/contract/sessionEventStore";
import { parseSessionEvent, type SessionEvent } from "../agent/contract/events";
import { _resetInboxForTest, listInboxItems } from "../agent/contract/inbox";
import { formatResetTime, limitDescription, startLimitInbox } from "../limits/limitStatus";
import {
  buildHandoffSeed,
  canHandOff,
  changedFilesOf,
  childBranchName,
  defaultTask,
  handoffLabel,
  handoffTargets,
  nestUnderParents,
  SEED_FILE_LIMIT,
} from "../limits/handoff";
import { HandoffError, runHandoff, type HandoffDeps } from "../limits/runHandoff";
import { AGENT_CATALOG, listAgents } from "../catalog/agentCatalog";
import type { GitProjectStatus, SessionWorktree } from "../types/git";
import { validateSavedWorkspace, type CreateSessionOpts, type SessionData } from "../types/session";

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0); // 2026-09-28 12:00 UTC

const limited = (at: number): SessionEvent => ({ type: "status", at, status: { kind: "limited", confidence: "exact", detail: "" } });
const working = (at: number): SessionEvent => ({ type: "status", at, status: { kind: "working", confidence: "exact", detail: "" } });
const limit = (at: number, resetsAt: number | null, window: string | null = "five_hour"): SessionEvent => ({
  type: "limit",
  at,
  state: "limited",
  resetsAt,
  window,
});
const cleared = (at: number): SessionEvent => ({ type: "limit", at, state: "cleared", resetsAt: null, window: null });
const exited = (at: number, code: number | null = 0): SessionEvent => ({ type: "exit", at, code, signal: null });

beforeEach(() => {
  _resetSessionEventStoreForTest();
  _resetInboxForTest(() => T0);
});

describe("the limit event (contract addition)", () => {
  it("parses limited and cleared, and refuses a bad state or reset time", () => {
    expect(parseSessionEvent({ type: "limit", at: 1, state: "limited", resetsAt: 5, window: "seven_day" })).toEqual({
      type: "limit",
      at: 1,
      state: "limited",
      resetsAt: 5,
      window: "seven_day",
    });
    expect(parseSessionEvent({ type: "limit", at: 1, state: "cleared" })).toEqual({
      type: "limit",
      at: 1,
      state: "cleared",
      resetsAt: null,
      window: null,
    });
    expect(parseSessionEvent({ type: "limit", at: 1, state: "paused", resetsAt: null, window: null })).toBeNull();
    expect(parseSessionEvent({ type: "limit", at: 1, state: "limited", resetsAt: 1.5, window: null })).toBeNull();
    expect(parseSessionEvent({ type: "limit", at: 1, state: "limited", resetsAt: null, window: 3 })).toBeNull();
  });

  it("the store keeps the limit while limited and forgets it when cleared", () => {
    const empty = getSessionEventSnapshot("s");
    expect(empty.limit).toBeNull();
    const on = reduceSessionEvent(empty, limit(1, T0 + 3_600_000));
    expect(on.limit).toEqual({ resetsAt: T0 + 3_600_000, window: "five_hour" });
    expect(Object.isFrozen(on.limit)).toBe(true);
    const off = reduceSessionEvent(on, cleared(2));
    expect(off.limit).toBeNull();
    expect(off.version).toBe(2);
  });

  it("wakes any-session listeners for every event and for a cleared session", () => {
    const seen: string[] = [];
    const stop = subscribeAllSessionEvents((id) => seen.push(id));
    dispatchSessionEvent("a", limited(1));
    dispatchSessionEvent("b", working(2));
    clearSessionEvents("a");
    stop();
    dispatchSessionEvent("a", working(3));
    expect(seen).toEqual(["a", "b", "a"]);
  });
});

describe("a limited agent that quits", () => {
  it("is exited, not limited: no tag words, no inbox item left behind or raised again", () => {
    const stop = startLimitInbox(() => T0);
    dispatchSessionEvent("s", limit(1, T0 + 3_600_000));
    dispatchSessionEvent("s", limited(1));
    expect(listInboxItems()).toHaveLength(1);
    // What the backend sends when the agent process ends while limited.
    dispatchSessionEvent("s", cleared(2));
    dispatchSessionEvent("s", exited(2, 0));
    const snap = getSessionEventSnapshot("s");
    expect(snap.status.kind).toBe("exited");
    expect(snap.limit).toBeNull();
    expect(limitDescription(snap, T0)).toBeNull();
    expect(listInboxItems()).toEqual([]);
    stop();
  });

  it("an exit alone also drops the limit", () => {
    dispatchSessionEvent("s", limit(1, T0 + 3_600_000));
    dispatchSessionEvent("s", limited(1));
    dispatchSessionEvent("s", exited(2, null));
    expect(getSessionEventSnapshot("s").limit).toBeNull();
    expect(limitDescription(getSessionEventSnapshot("s"), T0)).toBeNull();
  });
});

describe("the words for a limit", () => {
  it("shows the clock time within a day, the weekday within a week, the date beyond", () => {
    expect(formatResetTime(T0 + 2 * 3_600_000, T0, "en-GB", "UTC")).toBe("14:00");
    expect(formatResetTime(T0 + 30 * 3_600_000, T0, "en-GB", "UTC")).toMatch(/^Tue,? 18:00$/);
    expect(formatResetTime(T0 + 9 * 24 * 3_600_000, T0, "en-GB", "UTC")).toMatch(/7 Oct,? 12:00/);
  });

  it("says nothing for a session that is not limited", () => {
    dispatchSessionEvent("s", working(1));
    expect(limitDescription(getSessionEventSnapshot("s"), T0)).toBeNull();
  });

  it("says the reset time when reported, that it passed, or that it was not reported", () => {
    const t = (key: string, v?: Record<string, string | number>) => `${key}${v ? JSON.stringify(v) : ""}`;
    dispatchSessionEvent("s", limit(1, T0 + 3_600_000));
    dispatchSessionEvent("s", limited(1));
    const soon = limitDescription(getSessionEventSnapshot("s"), T0, t)!;
    expect(soon.resetsAt).toBe(T0 + 3_600_000);
    expect(soon.detail).toMatch(/^limits\.resetsAt\{"time":".+"\}$/);
    expect(limitDescription(getSessionEventSnapshot("s"), T0 + 7_200_000, t)!.detail).toMatch(/^limits\.resetPassed/);
    dispatchSessionEvent("u", limited(1));
    expect(limitDescription(getSessionEventSnapshot("u"), T0, t)).toEqual({ detail: "limits.resetUnknown", resetsAt: null });
  });
});

describe("a status that lands after the limit", () => {
  it("does not end it: a terminal's guess or the helper's report is not the agent going on", () => {
    const t = (key: string) => key;
    dispatchSessionEvent("s", limit(1, T0 + 3_600_000));
    dispatchSessionEvent("s", limited(1));
    dispatchSessionEvent("s", { type: "status", at: 2, source: "hi", status: { kind: "idle", confidence: "exact", detail: "" } });
    dispatchSessionEvent("s", { type: "status", at: 3, source: "pty", status: { kind: "working", confidence: "guessed", detail: "" } });
    expect(limitDescription(getSessionEventSnapshot("s"), T0, t)?.resetsAt).toBe(T0 + 3_600_000);
    dispatchSessionEvent("s", cleared(4));
    expect(limitDescription(getSessionEventSnapshot("s"), T0, t)).toBeNull();
  });
});

describe("the limit inbox item", () => {
  it("raises one item when limited, replaces it when the reset moves, resolves it when cleared", () => {
    const stop = startLimitInbox(() => T0, (k, v) => `${k}${v ? `:${v.time}` : ""}`);
    dispatchSessionEvent("s", limit(1, T0 + 3_600_000));
    expect(listInboxItems()).toHaveLength(1); // the limit event says so
    const first = listInboxItems()[0];
    dispatchSessionEvent("s", limited(1)); // with its status: the same item
    expect(listInboxItems()).toEqual([first]);
    expect(first).toMatchObject({ kind: "limit", sessionId: "s", source: "status" });
    expect(first.detail).toMatch(/^limits\.resetsAt:/);

    dispatchSessionEvent("s", limited(2)); // same limit again: same item
    expect(listInboxItems()).toEqual([first]);

    dispatchSessionEvent("s", limit(3, T0 + 7_200_000)); // new reset time: replaced
    expect(listInboxItems()).toHaveLength(1);
    expect(listInboxItems()[0].id).not.toBe(first.id);

    dispatchSessionEvent("other", limited(4)); // a second session, reset unknown
    expect(listInboxItems().map((i) => [i.sessionId, i.detail])).toContainEqual(["other", "limits.resetUnknown"]);

    dispatchSessionEvent("s", cleared(5));
    dispatchSessionEvent("s", working(5));
    expect(listInboxItems().map((i) => i.sessionId)).toEqual(["other"]);
    clearSessionEvents("other"); // the session closed
    expect(listInboxItems()).toEqual([]);
    stop();
    dispatchSessionEvent("x", limited(6));
    expect(listInboxItems()).toEqual([]);
  });
});

const project = (files: Array<[string, string]>, name = "repo", branch = "hermes/fix-login"): GitProjectStatus => ({
  project_id: `p-${name}`,
  project_name: name,
  project_path: `/fixture-home/${name}`,
  is_git_repo: true,
  branch,
  remote_branch: null,
  ahead: 0,
  behind: 0,
  files: files.map(([path, status]) => ({ path, status: status as never, area: "unstaged" as const, old_path: null })),
  has_conflicts: false,
  stash_count: 0,
  error: null,
});

describe("the seed prompt", () => {
  it("lists each changed file once, named per project when there are several", () => {
    expect(changedFilesOf([project([["b.ts", "modified"], ["a.ts", "added"], ["b.ts", "modified"]])])).toEqual([
      { path: "a.ts", status: "added" },
      { path: "b.ts", status: "modified" },
    ]);
    expect(changedFilesOf([project([["x", "modified"]], "api"), project([["y", "untracked"]], "web")]).map((f) => f.path)).toEqual([
      "api/x",
      "web/y",
    ]);
    expect(changedFilesOf([{ ...project([["x", "modified"]]), is_git_repo: false }])).toEqual([]);
  });

  it("continue: the task, who had it, that it hit its limit, the branch and every file", () => {
    const seed = buildHandoffSeed({
      kind: "continue",
      task: "  Fix the login redirect  ",
      limited: true,
      branch: "hermes/fix-login",
      changedFiles: [
        { path: "src/login.ts", status: "untracked" },
        { path: "README.md", status: "modified" },
      ],
    });
    expect(seed).toContain("another coding agent was working on in this same folder");
    // No product name: the new agent echoes its prompt, and the terminal's
    // agent detection would take it for the agent that is running.
    expect(seed).not.toMatch(/claude|codex/i);
    expect(seed).toContain("until it hit its usage limit");
    expect(seed).toContain("Task:\nFix the login redirect\n");
    expect(seed).toContain("Files changed so far on branch hermes/fix-login:\n- new: src/login.ts\n- modified: README.md");
    expect(seed).toMatch(/git status, git diff, git log/);
  });

  it("continue: says so when nothing changed yet, and summarises long lists", () => {
    const none = buildHandoffSeed({ kind: "continue", task: "t", limited: false, branch: null, changedFiles: [] });
    expect(none).toContain("Files changed so far: none yet.");
    expect(none).not.toContain("usage limit");
    const many = Array.from({ length: SEED_FILE_LIMIT + 5 }, (_, i) => ({ path: `f${i}`, status: "modified" }));
    const long = buildHandoffSeed({ kind: "continue", task: "t", limited: false, branch: null, changedFiles: many });
    expect(long.match(/^- modified: /gm)).toHaveLength(SEED_FILE_LIMIT);
    expect(long).toContain("- and 5 more (see git status)");
  });

  it("duplicate: the task and both branches, no file list", () => {
    const seed = buildHandoffSeed({
      kind: "duplicate",
      task: "Fix it",
      limited: false,
      branch: "hermes/fix-login--codex",
      parentBranch: "hermes/fix-login",
      changedFiles: [{ path: "src/login.ts", status: "modified" }],
    });
    expect(seed).toContain("on branch hermes/fix-login;");
    expect(seed).toContain("on branch hermes/fix-login--codex");
    expect(seed).toContain("Task:\nFix it");
    expect(seed).not.toContain("src/login.ts");
  });

  it("an empty task still tells the agent what to do", () => {
    expect(buildHandoffSeed({ kind: "duplicate", task: " ", limited: false, branch: null, changedFiles: [] })).toContain(
      "ask what to do",
    );
  });
});

describe("the child branch", () => {
  it("is <parent>--<agent>, unique, and a valid git branch name", () => {
    expect(childBranchName("hermes/fix-login", "codex", [])).toBe("hermes/fix-login--codex");
    expect(childBranchName("hermes/fix-login", "codex", ["hermes/fix-login--codex"])).toBe("hermes/fix-login--codex-2");
    expect(childBranchName("hermes/x", "Hermes Agent!", [])).toBe("hermes/x--hermes-agent");
    for (const name of [childBranchName("hermes/fix-login", "codex", []), childBranchName("main", "copilot", ["main--copilot"])]) {
      // git itself says whether the name is usable (a `~` would not be).
      expect(execFileSync("git", ["check-ref-format", "--branch", name], { encoding: "utf8" }).trim()).toBe(name);
    }
  });
});

describe("the agents a task can go to", () => {
  it("every other catalog agent, ready ones first; the rest say why not", () => {
    const targets = handoffTargets(listAgents(true), "claude", { codex: true, gemini: false, goose: true, aider: true, kiro: true });
    const byId = Object.fromEntries(targets.map((t) => [t.agent.id, t.state]));
    expect(byId.claude).toBeUndefined();
    expect(byId.codex).toBe("ready");
    expect(byId.gemini).toBe("not_installed");
    expect(byId.goose).toBe("no_prompt"); // it takes no first prompt: the seed could only be typed
    expect(byId.aider).toBe("no_prompt");
    expect(byId.custom).toBeUndefined();
    const firstNotReady = targets.findIndex((t) => t.state !== "ready");
    expect(targets.slice(firstNotReady).every((t) => t.state !== "ready")).toBe(true);
    // Any two catalog agents that take a first prompt can hand to each other.
    const promptable = AGENT_CATALOG.agents.filter((a) => !a.custom && a.terminal.initial_prompt).map((a) => a.id);
    expect(promptable).toEqual(expect.arrayContaining(["claude", "codex", "gemini", "copilot", "kiro"]));
    const all = Object.fromEntries(promptable.map((id) => [id, true]));
    for (const from of promptable) {
      const ready = handoffTargets(listAgents(true), from, all).filter((t) => t.state === "ready").map((t) => t.agent.id);
      expect(ready.sort()).toEqual(promptable.filter((id) => id !== from).sort());
    }
  });

  it("names the new session after its agent and starts from the description, else the name", () => {
    expect(handoffLabel("Login fix", "codex")).toBe("Login fix · Codex");
    expect(defaultTask({ label: "Login fix", description: "  Make the redirect work " })).toBe("Make the redirect work");
    expect(defaultTask({ label: "Login fix", description: "" })).toBe("Login fix");
  });
});

describe("which sessions offer the handoff", () => {
  it("live local agent sessions only: not a plain shell, a closed session or a remote one", () => {
    const base = { phase: "idle", ssh_info: null, ai_provider: "claude" } as const;
    expect(canHandOff(base)).toBe(true);
    expect(canHandOff({ ...base, ai_provider: null })).toBe(false);
    expect(canHandOff({ ...base, phase: "destroyed" })).toBe(false);
    expect(canHandOff({ ...base, ssh_info: { host: "example.test", port: 22, user: "test", tmux_session: null } as never })).toBe(false);
  });
});

describe("the handoff link after a restart", () => {
  const saved = (extra: Record<string, unknown>) => ({
    version: 2,
    sessions: [
      { id: "p", label: "Claude", ai_provider: "claude", project_ids: [] },
      { id: "c", label: "Codex", ai_provider: "codex", project_ids: [], ...extra },
    ],
    layout: null,
    focused_pane_id: null,
    active_session_id: "p",
  });

  it("keeps the parent id of a saved session, and drops one that is not a non-empty string", () => {
    expect(validateSavedWorkspace(saved({ parent_session_id: "p" }))?.sessions[1].parent_session_id).toBe("p");
    for (const bad of ["", 7, null, ["p"]]) {
      const ws = validateSavedWorkspace(saved({ parent_session_id: bad }));
      expect(ws, JSON.stringify(bad)).not.toBeNull();
      expect("parent_session_id" in ws!.sessions[1]).toBe(false);
    }
    expect(validateSavedWorkspace(saved({}))?.sessions[1].parent_session_id).toBeUndefined();
  });
});

describe("nesting in the session list", () => {
  it("puts each handed-off session right under its parent, chains in order", () => {
    const list = [
      { id: "a" },
      { id: "c", parent_session_id: "b" },
      { id: "b", parent_session_id: "a" },
      { id: "d" },
      { id: "e", parent_session_id: "gone" },
      { id: "f", parent_session_id: "a" },
    ];
    expect(nestUnderParents(list).map((s) => s.id)).toEqual(["a", "b", "c", "f", "d", "e"]);
  });

  it("keeps sessions that point at each other", () => {
    const list = [{ id: "x", parent_session_id: "y" }, { id: "y", parent_session_id: "x" }, { id: "z" }];
    expect(nestUnderParents(list).map((s) => s.id).sort()).toEqual(["x", "y", "z"]);
  });
});

// ─── runHandoff: order of operations and undo ─────────────────────────

function parent(over: Partial<SessionData> = {}): SessionData {
  return {
    id: "parent-1",
    label: "Login fix",
    description: "",
    color: "#58a6ff",
    group: "Web",
    phase: "idle",
    working_directory: "/fixture-home/wt/fix-login",
    shell: "/bin/zsh",
    created_at: "",
    last_activity_at: "",
    workspace_paths: [],
    detected_agent: null,
    metrics: {} as SessionData["metrics"],
    ai_provider: "claude",
    auto_approve: false,
    permission_mode: "acceptEdits",
    custom_prefix: "",
    custom_suffix: "",
    channels: [],
    context_injected: false,
    ssh_info: null,
    mode: "terminal",
    ...over,
  };
}

function wt(branch: string | null, isMain = false): SessionWorktree {
  return {
    id: "w",
    sessionId: "parent-1",
    projectId: "p1",
    worktreePath: "/fixture-home/wt/fix-login",
    branchName: branch,
    isMainWorktree: isMain,
    createdAt: "",
  };
}

function fakeDeps(over: Partial<HandoffDeps> = {}) {
  const calls: string[] = [];
  let created: CreateSessionOpts | null = null;
  const deps: HandoffDeps = {
    newSessionId: () => "new-1",
    sessionProjects: vi.fn(async () => [{ id: "p1" }]),
    worktreeInfo: vi.fn(async () => wt("hermes/fix-login")),
    branchNames: vi.fn(async () => ["main", "hermes/fix-login", "hermes/fix-login--codex"]),
    createWorktree: vi.fn(async (...a: unknown[]) => void calls.push(`create ${JSON.stringify(a)}`)),
    attachWorktree: vi.fn(async (...a: unknown[]) => void calls.push(`attach ${JSON.stringify(a)}`)),
    removeWorktree: vi.fn(async (...a: unknown[]) => void calls.push(`remove ${JSON.stringify(a)}`)),
    detachWorktree: vi.fn(async (...a: unknown[]) => void calls.push(`detach ${JSON.stringify(a)}`)),
    createSession: vi.fn(async (opts: CreateSessionOpts) => {
      calls.push("createSession");
      created = opts;
      return { ...parent(), id: opts.sessionId!, label: opts.label!, ai_provider: opts.aiProvider!, parent_session_id: opts.parentSessionId };
    }),
    setGroup: vi.fn(async (...a: unknown[]) => void calls.push(`group ${JSON.stringify(a)}`)),
    ...over,
  };
  return { deps, calls, created: () => created };
}

describe("runHandoff", () => {
  it("continue: links the SAME checkout, then starts the agent with the seed, under the parent, in its group", async () => {
    const { deps, calls, created } = fakeDeps();
    const out = await runHandoff({ kind: "continue", parent: parent(), agentId: "codex", seed: "SEED" }, deps);
    expect(calls).toEqual(['attach ["new-1","p1","hermes/fix-login"]', "createSession", 'group ["new-1","Web"]']);
    expect(created()).toMatchObject({
      sessionId: "new-1",
      aiProvider: "codex",
      seedPrompt: "SEED",
      parentSessionId: "parent-1",
      projectIds: ["p1"],
      label: "Login fix · Codex",
      workingDirectory: "/fixture-home/wt/fix-login",
    });
    // Codex has no acceptEdits mode: the new session starts in default.
    expect(created()!.permissionMode).toBe("default");
    expect(out.branches).toEqual({ p1: "hermes/fix-login" });
  });

  it("duplicate: a child branch cut from the parent's, unique among existing branches", async () => {
    const { deps, calls, created } = fakeDeps();
    const out = await runHandoff({ kind: "duplicate", parent: parent(), agentId: "codex", seed: "SEED" }, deps);
    expect(calls[0]).toBe('create ["new-1","p1","hermes/fix-login--codex-2",true,null,"hermes/fix-login"]');
    expect(out.branches).toEqual({ p1: "hermes/fix-login--codex-2" });
    expect(created()!.parentSessionId).toBe("parent-1");
  });

  it("a permission mode the new agent has is kept", async () => {
    const { deps, created } = fakeDeps();
    await runHandoff({ kind: "continue", parent: parent({ permission_mode: "plan" }), agentId: "claude", seed: "S" }, deps);
    expect(created()!.permissionMode).toBe("plan");
  });

  it("a session in a plain folder continues in that folder; it cannot be duplicated", async () => {
    const { deps, calls, created } = fakeDeps({ sessionProjects: vi.fn(async () => []) });
    await runHandoff({ kind: "continue", parent: parent({ group: null }), agentId: "codex", seed: "S" }, deps);
    expect(calls).toEqual(["createSession"]);
    expect(created()!.projectIds).toBeUndefined();
    const dup = fakeDeps({ worktreeInfo: vi.fn(async () => wt(null)) });
    await expect(runHandoff({ kind: "duplicate", parent: parent(), agentId: "codex", seed: "S" }, dup.deps)).rejects.toMatchObject({
      code: "no_branch",
    });
    expect(dup.calls).toEqual([]);
  });

  it("undoes the checkout when the session cannot be started", async () => {
    const cont = fakeDeps({ createSession: vi.fn(async () => null) });
    await expect(runHandoff({ kind: "continue", parent: parent(), agentId: "codex", seed: "S" }, cont.deps)).rejects.toBeInstanceOf(
      HandoffError,
    );
    expect(cont.calls).toEqual(['attach ["new-1","p1","hermes/fix-login"]', 'detach ["new-1","p1"]']);
    const dup = fakeDeps({
      createSession: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(runHandoff({ kind: "duplicate", parent: parent(), agentId: "codex", seed: "S" }, dup.deps)).rejects.toThrow("boom");
    expect(dup.calls).toEqual(['create ["new-1","p1","hermes/fix-login--codex-2",true,null,"hermes/fix-login"]', 'remove ["new-1","p1"]']);
  });
});
