/**
 * F15 — what Enter in the task launcher does (src/launcher/launchTask.ts),
 * with every effect recorded: the session each agent gets (its own new
 * branch, the task as its first prompt), where it is shown, the Full-track
 * feature.md, the clipboard for an agent that cannot take a first prompt,
 * and the launch record.
 */
import { describe, expect, it, vi } from "vitest";
import { handleUndeliveredTask, launchTask, normalizeRepoPath, type LaunchTaskDeps } from "../launcher/launchTask";
import { parseTaskLaunches } from "../launcher/taskLauncher";
import type { CreateSessionOpts, SessionData } from "../types/session";
import type { PlannedAgent, TaskLaunchRequest } from "../components/TaskLauncher";
import type { LaunchChoice } from "../agent/capabilities/types";

const CHOICE: LaunchChoice = {
  agentId: "claude",
  accountId: "default",
  approvalModeId: "acceptEdits",
  modelId: "default",
  effort: null,
  extraArgs: "",
  prefix: "",
  channels: [],
  where: { kind: "new-worktree", baseBranch: "", branch: "" },
  trackAsFeature: false,
};

/** One planned agent session: a new worktree on a new branch unless told otherwise. */
function agent(id: string, mode: "terminal" | "agent", branch: string, over: Partial<PlannedAgent> = {}): PlannedAgent {
  return {
    id,
    mode,
    branch,
    createBranch: true,
    baseBranch: "",
    worktree: true,
    launch: { permissionMode: "acceptEdits", customPrefix: "", customSuffix: "", channels: [] },
    choice: { ...CHOICE, agentId: id },
    ...over,
  };
}

function fakeDeps(over: Partial<LaunchTaskDeps> = {}) {
  const created: CreateSessionOpts[] = [];
  const placed: [string, number, string | null][] = [];
  const files: [string, string, string][] = [];
  const copied: string[] = [];
  let records = "";
  let n = 0;
  const deps: LaunchTaskDeps = {
    projectFor: vi.fn(async () => "proj-1"),
    createSession: vi.fn(async (opts: CreateSessionOpts) => {
      created.push(opts);
      n += 1;
      return { id: `s${n}` } as SessionData;
    }),
    place: (id, i, first) => placed.push([id, i, first]),
    worktreePath: vi.fn(async (id: string) => `/fixture-home/wt/${id}`),
    writeFeatureFile: vi.fn(async (checkout: string, slug: string, contents: string) => {
      files.push([checkout, slug, contents]);
      return `${checkout}/.hermes/features/${slug}/feature.md`;
    }),
    copyText: vi.fn(async (t: string) => {
      copied.push(t);
    }),
    readRecords: async () => records,
    writeRecords: async (raw) => {
      records = raw;
    },
    now: () => 1000,
    ...over,
  };
  return { deps, created, placed, files, copied, records: () => parseTaskLaunches(records) };
}

const req = (over: Partial<TaskLaunchRequest> = {}): TaskLaunchRequest => ({
  task: "  Fix the login bug  ",
  repoRoot: "/fixture-home/repo",
  agents: [agent("claude", "terminal", "hermes/fix-the-login-bug")],
  track: "Quick",
  doneWhen: ["npm test"],
  choice: CHOICE,
  ...over,
});

describe("launchTask", () => {
  it("starts the agent on its own new branch with the task as its first prompt", async () => {
    const f = fakeDeps();
    const r = await launchTask(req(), f.deps);
    expect(r.ok).toBe(true);
    expect(f.created).toEqual([
      {
        label: "Fix the login bug",
        aiProvider: "claude",
        mode: "terminal",
        projectIds: ["proj-1"],
        workingDirectory: "/fixture-home/repo",
        branchSelections: { "proj-1": { branch: "hermes/fix-the-login-bug", createNew: true } },
        initialPrompt: "Fix the login bug",
        permissionMode: "acceptEdits",
        customPrefix: undefined,
        customSuffix: undefined,
        channels: undefined,
        agentName: undefined,
        agentCommand: undefined,
        agentLaunch: undefined,
      },
    ]);
    expect(f.placed).toEqual([["s1", 0, null]]);
    expect(f.copied).toEqual([]);
    expect(f.files).toEqual([]);
    expect(f.records()).toEqual([
      {
        sessionId: "s1",
        task: "Fix the login bug",
        agentId: "claude",
        mode: "terminal",
        repo: "/fixture-home/repo",
        branch: "hermes/fix-the-login-bug",
        track: "Quick",
        doneWhen: ["npm test"],
        pairedWith: null,
        createdAt: 1000,
      },
    ]);
  });

  it("runs the same task on a second agent beside the first, and pairs the records", async () => {
    const f = fakeDeps();
    const r = await launchTask(
      req({
        agents: [
          agent("claude", "agent", "hermes/x"),
          agent("codex", "terminal", "hermes/x-codex"),
        ],
      }),
      f.deps,
    );
    expect(r.sessionIds).toEqual(["s1", "s2"]);
    expect(f.created.map((c) => [c.aiProvider, c.mode, c.branchSelections?.["proj-1"].branch])).toEqual([
      ["claude", "agent", "hermes/x"],
      ["codex", "terminal", "hermes/x-codex"],
    ]);
    expect(f.placed).toEqual([
      ["s1", 0, null],
      ["s2", 1, "s1"],
    ]);
    expect(f.records().map((x) => [x.sessionId, x.pairedWith])).toEqual([
      ["s1", "s2"],
      ["s2", "s1"],
    ]);
  });

  it("a first agent that fails to start is a failed launch; a second one is not", async () => {
    const failFirst = fakeDeps({ createSession: vi.fn(async () => null) });
    expect((await launchTask(req(), failFirst.deps)).ok).toBe(false);
    expect(failFirst.records()).toEqual([]);

    let calls = 0;
    const failSecond = fakeDeps({
      createSession: vi.fn(async () => (++calls === 1 ? ({ id: "s1" } as SessionData) : null)),
    });
    const r = await launchTask(
      req({ agents: [agent("claude", "terminal", "a"), agent("codex", "terminal", "b")] }),
      failSecond.deps,
    );
    expect(r).toMatchObject({ ok: true, sessionIds: ["s1"] });
    expect(failSecond.records().map((x) => x.pairedWith)).toEqual([null]);
  });

  it("a Full track writes the first feature.md into each worktree", async () => {
    const f = fakeDeps();
    const r = await launchTask(req({ track: "Full" }), f.deps);
    expect(f.files.map(([checkout, slug]) => [checkout, slug])).toEqual([["/fixture-home/wt/s1", "fix-the-login-bug"]]);
    expect(f.files[0][2]).toContain("track: Full");
    expect(f.files[0][2]).toContain('  - "npm test"');
    expect(r.featureFiles).toEqual(["/fixture-home/wt/s1/.hermes/features/fix-the-login-bug/feature.md"]);
  });

  it("an agent that cannot take a first prompt gets the task on the clipboard", async () => {
    const f = fakeDeps();
    const r = await launchTask(req({ agents: [agent("goose", "terminal", "hermes/g")] }), f.deps);
    expect(r.copiedFor).toEqual(["goose"]);
    expect(f.copied).toEqual(["Fix the login bug"]);
  });

  it("does nothing without a task or an agent", async () => {
    const f = fakeDeps();
    expect((await launchTask(req({ task: "  " }), f.deps)).ok).toBe(false);
    expect((await launchTask(req({ agents: [] }), f.deps)).ok).toBe(false);
    expect(f.created).toEqual([]);
  });

  it("carries the approval mode, prefix, model/effort flags, extra args, channels and account of the choice", async () => {
    const f = fakeDeps();
    await launchTask(
      req({
        agents: [
          agent("claude", "terminal", "hermes/x", {
            launch: {
              permissionMode: "plan",
              customPrefix: "caffeinate -i",
              customSuffix: "--model opus --effort high --verbose",
              channels: ["plugin:telegram"],
              agentLaunch: { modelId: "opus", effort: "high", accountId: "work", purpose: "agent" },
            },
          }),
        ],
      }),
      f.deps,
    );
    expect(f.created[0]).toMatchObject({
      permissionMode: "plan",
      customPrefix: "caffeinate -i",
      customSuffix: "--model opus --effort high --verbose",
      channels: ["plugin:telegram"],
      agentLaunch: { modelId: "opus", effort: "high", accountId: "work", purpose: "agent" },
    });
  });

  it("an existing branch gets a worktree without a new branch; the current checkout gets none; a base branch is passed on", async () => {
    const f = fakeDeps();
    await launchTask(req({ agents: [agent("claude", "terminal", "feature/inbox", { createBranch: false })] }), f.deps);
    await launchTask(req({ agents: [agent("claude", "terminal", "", { createBranch: false, worktree: false })] }), f.deps);
    await launchTask(req({ agents: [agent("claude", "terminal", "hermes/y", { baseBranch: "develop" })] }), f.deps);
    expect(f.created.map((c) => c.branchSelections)).toEqual([
      { "proj-1": { branch: "feature/inbox", createNew: false } },
      undefined,
      { "proj-1": { branch: "hermes/y", createNew: true, baseBranch: "develop" } },
    ]);
    expect(f.created[1].workingDirectory).toBe("/fixture-home/repo");
  });

  it("a Custom agent starts the command that was typed", async () => {
    const f = fakeDeps();
    await launchTask(req({ agents: [agent("custom", "terminal", "hermes/c", { launch: { permissionMode: "default", customPrefix: "", customSuffix: "", channels: [], agentCommand: "my-agent --fast" } })] }), f.deps);
    expect(f.created[0]).toMatchObject({ aiProvider: "custom", agentCommand: "my-agent --fast", agentName: "my-agent --fast" });
  });

  it("with no free slot the sessions wait in the queue instead of starting", async () => {
    const queued: [CreateSessionOpts, string][] = [];
    const f = fakeDeps({ queue: (opts, label) => (queued.push([opts, label]), true) });
    const r = await launchTask(req({ agents: [agent("claude", "terminal", "a"), agent("codex", "terminal", "b")] }), f.deps);
    expect(r).toMatchObject({ ok: true, sessionIds: [], queued: 2 });
    expect(f.created).toEqual([]);
    expect(queued.map(([o, l]) => [o.aiProvider, o.initialPrompt, l])).toEqual([
      ["claude", "Fix the login bug", "Fix the login bug"],
      ["codex", "Fix the login bug", "Fix the login bug"],
    ]);
  });

  it("a record that cannot be saved does not undo the launch", async () => {
    const f = fakeDeps({ writeRecords: vi.fn(async () => Promise.reject(new Error("disk"))) });
    expect((await launchTask(req(), f.deps)).ok).toBe(true);
  });
});

describe("normalizeRepoPath", () => {
  it("ignores trailing separators, and case and slashes on Windows", () => {
    expect(normalizeRepoPath("/fixture-home/repo/")).toBe("/fixture-home/repo");
    expect(normalizeRepoPath("C:/Fixture/Repo\\", true)).toBe("c:\\fixture\\repo");
    expect(normalizeRepoPath("/")).toBe("/");
  });
});

describe("a task the agent's launch could not carry", () => {
  it("goes on the clipboard and the person is told which agent started without it", async () => {
    const copied: string[] = [];
    const notes: string[] = [];
    await handleUndeliveredTask(
      { sessionId: "s1", agentId: "claude", task: "  fix the login bug \n" },
      { copyText: async (t) => { copied.push(t); }, notify: (m) => notes.push(m) },
    );
    expect(copied).toEqual(["fix the login bug"]);
    expect(notes).toEqual(["Claude Code started without your task. The task is on the clipboard: paste it into the terminal."]);
  });

  it("shows the task itself when the clipboard refuses it", async () => {
    const notes: string[] = [];
    await handleUndeliveredTask(
      { sessionId: "s1", agentId: "codex", task: "fix the login bug" },
      { copyText: async () => { throw new Error("denied"); }, notify: (m) => notes.push(m) },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("fix the login bug");
    expect(notes[0]).not.toContain("clipboard");
  });

  it("does nothing for an empty task", async () => {
    const copyText = vi.fn(async () => {});
    const notify = vi.fn();
    await handleUndeliveredTask({ sessionId: "s1", agentId: "claude", task: "   " }, { copyText, notify });
    expect(copyText).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
