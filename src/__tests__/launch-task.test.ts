/**
 * F15 — what Enter in the task launcher does (src/launcher/launchTask.ts),
 * with every effect recorded: the session each agent gets (its own new
 * branch, the task as its first prompt), where it is shown, the Full-track
 * feature.md, the clipboard for an agent that cannot take a first prompt,
 * and the launch record.
 */
import { describe, expect, it, vi } from "vitest";
import { finishQueuedLaunch, handleUndeliveredTask, launchTask, normalizeRepoPath, queuedLaunchOpts, type LaunchTaskDeps, type QueuedLaunch } from "../launcher/launchTask";
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
    newLaunchId: () => "launch-1",
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
        launchId: "launch-1",
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

  it("a Full track starts the agent with the track's first prompt (questions, then the gate), not the bare task", async () => {
    const trackPrompt = vi.fn(async (root: string, slug: string, task: string) => `TRACK(${root}|${slug}|${task})`);
    const f = fakeDeps({ trackPrompt });
    await launchTask(req({ track: "Full", agents: [agent("claude", "terminal", "hermes/fix-the-login-bug"), agent("codex", "terminal", "hermes/fix-the-login-bug-codex")] }), f.deps);
    expect(trackPrompt).toHaveBeenCalledWith("/fixture-home/repo", "fix-the-login-bug", "Fix the login bug");
    expect(f.created.map((o) => o.initialPrompt)).toEqual([
      "TRACK(/fixture-home/repo|fix-the-login-bug|Fix the login bug)",
      "TRACK(/fixture-home/repo|fix-the-login-bug|Fix the login bug)",
    ]);
    // The launch record keeps the task as the person wrote it.
    expect(f.records().map((r) => r.task)).toEqual(["Fix the login bug", "Fix the login bug"]);
    // Quick: the bare task, no track prompt asked for.
    const q = fakeDeps({ trackPrompt });
    trackPrompt.mockClear();
    await launchTask(req(), q.deps);
    expect(trackPrompt).not.toHaveBeenCalled();
    expect(q.created[0].initialPrompt).toBe("Fix the login bug");
  });

  it("a Full track whose prompt cannot be built still launches, with the bare task", async () => {
    const f = fakeDeps({ trackPrompt: vi.fn(async () => Promise.reject(new Error("no repo"))) });
    const r = await launchTask(req({ track: "Full" }), f.deps);
    expect(r.ok).toBe(true);
    expect(f.created[0].initialPrompt).toBe("Fix the login bug");
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

  it("a queued agent finishes its launch when it starts: feature.md, checks, record, pairing (LEAD-03)", async () => {
    const launches: QueuedLaunch[] = [];
    const checks: [string, string[]][] = [];
    const f = fakeDeps({
      // The first agent starts at once, the second waits for a slot.
      queue: (_opts, _label, launch) => (launch.agentIndex === 1 ? (launches.push(launch), true) : false),
      writeDoneWhen: vi.fn(async (checkout: string, commands: string[]) => {
        checks.push([checkout, commands]);
        return `${checkout}.git/hermes/done-when.json`;
      }),
    });
    const r = await launchTask(req({ track: "Full", agents: [agent("claude", "terminal", "hermes/x"), agent("codex", "terminal", "hermes/x-codex")] }), f.deps);
    expect(r).toMatchObject({ ok: true, sessionIds: ["s1"], queued: 1, launchId: "launch-1" });
    expect(launches).toHaveLength(1);
    // Plain data, kept across a quit.
    const stored: QueuedLaunch = JSON.parse(JSON.stringify(launches[0]));
    expect(queuedLaunchOpts(stored)).toMatchObject({ aiProvider: "codex", branchSelections: { "proj-1": { branch: "hermes/x-codex", createNew: true } }, initialPrompt: "Fix the login bug" });
    // The slot frees: the app creates the session, then the launch finishes.
    const later = await finishQueuedLaunch(stored, "s9", f.deps);
    expect(later.featureFiles).toEqual(["/fixture-home/wt/s9/.hermes/features/fix-the-login-bug/feature.md"]);
    expect(checks).toEqual([
      ["/fixture-home/wt/s1", ["npm test"]],
      ["/fixture-home/wt/s9", ["npm test"]],
    ]);
    expect(f.records().map((x) => [x.sessionId, x.track, x.pairedWith])).toEqual([
      ["s1", "Full", "s9"],
      ["s9", "Full", "s1"],
    ]);
  });

  it("a Full track on the current checkout writes the feature in the repository's own folder (PLN-04)", async () => {
    const f = fakeDeps({ worktreePath: vi.fn(async () => null) });
    const r = await launchTask(req({ track: "Full", agents: [agent("claude", "terminal", "", { createBranch: false, worktree: false })] }), f.deps);
    expect(f.files.map(([checkout, slug]) => [checkout, slug])).toEqual([["/fixture-home/repo", "fix-the-login-bug"]]);
    expect(r.featureFiles).toEqual(["/fixture-home/repo/.hermes/features/fix-the-login-bug/feature.md"]);
  });

  it("a feature track that cannot be written is said, and the launch stands (PLN-04)", async () => {
    const notify = vi.fn();
    const f = fakeDeps({ notify, writeFeatureFile: vi.fn(async () => Promise.reject(new Error("disk full"))) });
    const r = await launchTask(req({ track: "Full" }), f.deps);
    expect(r.ok).toBe(true);
    expect(notify).toHaveBeenCalledWith("Couldn't create the feature track: disk full");
    // A worktree session whose worktree cannot be found: said too, never written into the main checkout.
    const g = fakeDeps({ notify, worktreePath: vi.fn(async () => null) });
    await launchTask(req({ track: "Full" }), g.deps);
    expect(g.files).toEqual([]);
    expect(notify).toHaveBeenLastCalledWith("Couldn't create the feature track: the task's worktree could not be found");
  });

  it("keeps the task's checks next to its worktree only (PLN-10), none for the current checkout or without checks", async () => {
    const writeDoneWhen = vi.fn(async () => "x");
    const f = fakeDeps({ writeDoneWhen });
    await launchTask(req({ doneWhen: [" npm test ", "", "cargo test"] }), f.deps);
    expect(writeDoneWhen).toHaveBeenCalledWith("/fixture-home/wt/s1", ["npm test", "cargo test"]);
    writeDoneWhen.mockClear();
    const g = fakeDeps({ writeDoneWhen, worktreePath: vi.fn(async () => null) });
    await launchTask(req({ agents: [agent("claude", "terminal", "", { createBranch: false, worktree: false })] }), g.deps);
    await launchTask(req({ doneWhen: [] }), f.deps);
    expect(writeDoneWhen).not.toHaveBeenCalled();
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

describe("launchTask in a folder that is not a git repository", () => {
  // What the launcher plans there: no worktree, no branch (TaskLauncher's plainFolder).
  const inFolder = (id: string, mode: "terminal" | "agent" = "terminal") => agent(id, mode, "", { createBranch: false, worktree: false });

  it("a plain folder: the session starts in it with no branch selection, so no worktree is made", async () => {
    const f = fakeDeps({ worktreePath: vi.fn(async () => null) });
    const r = await launchTask(req({ repoRoot: "/fixture-home/notes", agents: [inFolder("claude")], doneWhen: [] }), f.deps);
    expect(r.ok).toBe(true);
    expect(f.deps.projectFor).toHaveBeenCalledWith("/fixture-home/notes");
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({ workingDirectory: "/fixture-home/notes", projectIds: ["proj-1"], initialPrompt: "Fix the login bug" });
    expect(f.created[0].branchSelections).toBeUndefined();
    expect(f.records()[0]).toMatchObject({ repo: "/fixture-home/notes", branch: "" });
  });

  it("a parent folder holding several repositories: one session in the parent, none in the repositories inside it", async () => {
    const f = fakeDeps({ worktreePath: vi.fn(async () => null) });
    await launchTask(req({ repoRoot: "/fixture-home/code", agents: [inFolder("codex"), inFolder("opencode")] }), f.deps);
    expect(f.deps.projectFor).toHaveBeenCalledTimes(1);
    expect(f.created.map((o) => [o.aiProvider, o.workingDirectory, o.branchSelections])).toEqual([
      ["codex", "/fixture-home/code", undefined],
      ["opencode", "/fixture-home/code", undefined],
    ]);
  });

  it("a Full-track task keeps its feature.md in the folder itself, and no checks file is kept (there is no worktree)", async () => {
    const writeDoneWhen = vi.fn(async () => "x");
    const f = fakeDeps({ worktreePath: vi.fn(async () => null), writeDoneWhen });
    await launchTask(req({ repoRoot: "/fixture-home/notes", agents: [inFolder("claude")], track: "Full" }), f.deps);
    expect(f.files.map(([checkout, slug]) => [checkout, slug])).toEqual([["/fixture-home/notes", "fix-the-login-bug"]]);
    expect(writeDoneWhen).not.toHaveBeenCalled();
  });
});
