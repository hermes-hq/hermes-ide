/**
 * The task launcher's decisions behind the QA fixes (src/launcher/*):
 * branch names made up for a task and the names git refuses, an added
 * account judged by its own sign-in, what is at a typed path, the pairing
 * of a launch whose second agent waited in the queue, the history that never
 * carries "current checkout" over, preset names, the queue kept across a
 * quit, and the one-overlay-at-a-time rule with the menu keys behind it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BRANCH_LENGTH,
  appendTaskLaunches,
  autoTaskBranch,
  blockingRows,
  branchNameProblem,
  isAddedAccount,
  shortTaskId,
  taskBranch,
  type LaunchCheckInput,
  type TaskLaunchRecord,
} from "../launcher/taskLauncher";
import { historyForm, presetNamed } from "../launcher/choice";
import {
  _resetTaskQueueForTest,
  enqueueTask,
  listQueuedTasks,
  parseStoredTaskQueue,
  restoreTaskQueue,
  serializeTaskQueue,
} from "../fleet/taskQueue";
import { closeTopOverlay, openOverlays, overlayOpened, topOverlay } from "../state/overlays";
import { allowedBehindWelcome, cleanupListener, isMenuGated, registerMenuBarHandler, setMenuGate, triggerMenuBarActionFromKeyboard } from "../hooks/nativeMenuBridge";
import type { DoctorRow } from "../api/doctor";
import type { LaunchChoice } from "../agent/capabilities/types";
import type { QueuedLaunch } from "../launcher/launchTask";

function row(id: string, over: Partial<DoctorRow> = {}): DoctorRow {
  return { id, name: id, installed: true, version: "1.0.0", min_version: null, version_ok: null, signed_in: "yes", signals: "exact", resume: true, retired: false, retired_note: null, beta: false, ...over };
}

function check(over: Partial<LaunchCheckInput> = {}): LaunchCheckInput {
  return {
    agents: [{ id: "claude", branch: "hermes/fix-login" }],
    doctor: { claude: row("claude") },
    repoPath: "/fixture-home/repo",
    gitRoot: "/fixture-home/repo",
    branches: [],
    disk: null,
    ...over,
  };
}

const BASE: LaunchChoice = {
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

describe("branch names", () => {
  it("names the same task past the branches that exist, letter case included (SOLO-09)", () => {
    expect(autoTaskBranch("Fix it", [])).toBe("hermes/fix-it");
    expect(autoTaskBranch("Fix it", ["hermes/fix-it"])).toBe("hermes/fix-it-2");
    expect(autoTaskBranch("Fix it", ["hermes/fix-it", "hermes/fix-it-2"])).toBe("hermes/fix-it-3");
    // A folder in another letter case is that folder (macOS, Windows): its spelling is kept.
    expect(autoTaskBranch("Fix it", ["Hermes/Fix-It"])).toBe("Hermes/fix-it-2");
    // A branch inside the name's folder: git cannot make the name.
    expect(autoTaskBranch("Fix it", ["hermes/fix-it/old"])).toBe("hermes/fix-it-2");
    expect(autoTaskBranch("🙂", [], "abc123")).toBe("hermes/task-abc123");
    expect(shortTaskId(() => 0.999)).toBe("ffffff");
    expect(shortTaskId()).toMatch(/^[0-9a-f]{6}$/);
  });

  it("spells out German letters and names a task without any after the sheet (SOLO-09, QAGIT-21b)", () => {
    expect(taskBranch("Größe prüfen für Überschrift")).toBe("hermes/groesse-pruefen-fuer-ueberschrift");
    expect(taskBranch("🚀🚀", "a1b2c3")).toBe("hermes/task-a1b2c3");
    expect(taskBranch("修复登录", "a1b2c3")).toBe("hermes/task-a1b2c3");
    expect(taskBranch("   ")).toBe("hermes/task");
  });

  it("says why git would refuse a name that looks fine (QAGIT-14)", () => {
    const branches = ["main", "release/2.3", "feature/inbox"];
    expect(branchNameProblem("release", branches)).toEqual({ kind: "folder", existing: "release/2.3" });
    expect(branchNameProblem("Release", branches)).toEqual({ kind: "folder", existing: "release/2.3" });
    expect(branchNameProblem("feature/inbox/sub", branches)).toEqual({ kind: "under-branch", existing: "feature/inbox" });
    expect(branchNameProblem("hermes/.wip", branches)).toEqual({ kind: "dot-part" });
    expect(branchNameProblem("hermes/x.lock/y", branches)).toEqual({ kind: "lock-part" });
    expect(branchNameProblem(`hermes/${"x".repeat(240)}`, branches)).toEqual({ kind: "too-long", max: MAX_BRANCH_LENGTH });
    expect(branchNameProblem("hermes/fine", branches)).toBeNull();
    expect(blockingRows(check({ agents: [{ id: "claude", branch: "release" }], branches }))).toEqual([
      { kind: "bad-branch", branch: "release", problem: { kind: "folder", existing: "release/2.3" } },
    ]);
  });
});

describe("blocking rows", () => {
  it("judges an added account by its own sign-in, the default profile by the doctor (ACC-04)", () => {
    const doctor = { claude: row("claude", { signed_in: "no" }) };
    expect(blockingRows(check({ doctor, agents: [{ id: "claude", branch: "hermes/a", accountId: "work", accountSignedIn: true }] }))).toEqual([]);
    expect(blockingRows(check({ doctor, agents: [{ id: "claude", branch: "hermes/a", accountId: "default" }] }))).toEqual([{ kind: "signed-out", agentId: "claude" }]);
    expect(blockingRows(check({ agents: [{ id: "claude", branch: "hermes/a", accountId: "work", accountSignedIn: false }] }))).toEqual([
      { kind: "signed-out", agentId: "claude", accountId: "work" },
    ]);
    // Not known yet: nothing is said.
    expect(blockingRows(check({ agents: [{ id: "claude", branch: "hermes/a", accountId: "work" }] }))).toEqual([]);
    expect(isAddedAccount("work")).toBe(true);
    expect(isAddedAccount("default")).toBe(false);
    expect(isAddedAccount(null)).toBe(false);
  });

  it("tells a missing folder, a file and an empty repository apart; a plain folder never blocks (NEWCOMER-07, QAGIT-15)", () => {
    const path = "/fixture-home/repo";
    expect(blockingRows(check({ gitRoot: null, folder: { exists: false, isDir: false, hasCommits: false } }))[0]).toEqual({ kind: "not-git", path, missing: "missing" });
    expect(blockingRows(check({ gitRoot: null, folder: { exists: true, isDir: false, hasCommits: false } }))[0]).toEqual({ kind: "not-git", path, missing: "file" });
    // A folder that is not a git repository is fine: the agent works in it directly.
    expect(blockingRows(check({ gitRoot: null, folder: { exists: true, isDir: true, hasCommits: false } }))).toEqual([]);
    expect(blockingRows(check({ folder: { exists: true, isDir: true, hasCommits: false } }))).toEqual([{ kind: "no-commits" }]);
    // The current checkout of an empty repository makes no branch: nothing to say.
    expect(blockingRows(check({ agents: [], folder: { exists: true, isDir: true, hasCommits: false } }))).toEqual([]);
  });
});

describe("launch records", () => {
  const rec = (sessionId: string, launchId?: string): TaskLaunchRecord => ({
    sessionId,
    task: "t",
    agentId: "claude",
    mode: "terminal",
    repo: "/r",
    branch: "b",
    track: "Quick",
    doneWhen: [],
    pairedWith: null,
    createdAt: 1,
    ...(launchId ? { launchId } : {}),
  });

  it("pairs the records of one launch, also when the second agent started later from the queue (LEAD-03)", () => {
    const first = appendTaskLaunches([], [rec("s1", "L1"), rec("x", "L2")]);
    expect(first.map((r) => r.pairedWith)).toEqual([null, null]);
    const later = appendTaskLaunches(first, [rec("s2", "L1")]);
    expect(later.map((r) => [r.sessionId, r.pairedWith])).toEqual([
      ["s1", "s2"],
      ["x", null],
      ["s2", "s1"],
    ]);
    expect(appendTaskLaunches([rec("a")], [rec("b")]).map((r) => r.pairedWith)).toEqual([null, null]);
  });
});

describe("remembered choices and preset names", () => {
  it("never carries the current checkout over to the next task from the history (QAGIT-16)", () => {
    const current: LaunchChoice = { ...BASE, where: { kind: "current-checkout" } };
    expect(historyForm(current).where).toEqual({ kind: "new-worktree", baseBranch: "", branch: "" });
    const also: LaunchChoice = { ...BASE, where: { kind: "new-worktree", baseBranch: "develop", branch: "hermes/x" }, alsoOn: { ...current, agentId: "codex" } };
    expect(historyForm(also).where).toEqual({ kind: "new-worktree", baseBranch: "develop", branch: "" });
    expect(historyForm(also).alsoOn?.where).toEqual({ kind: "new-worktree", baseBranch: "", branch: "" });
  });

  it("finds a preset by name whatever its letter case (SOLO-17)", () => {
    const presets = [
      { id: "p1", name: "Plan first" },
      { id: "p2", name: "Quick fix" },
    ];
    expect(presetNamed("  PLAN FIRST ", presets)?.id).toBe("p1");
    expect(presetNamed("plan first", presets, "p1")).toBeNull();
    expect(presetNamed("", presets)).toBeNull();
    expect(presetNamed("Other", presets)).toBeNull();
  });
});

describe("the task queue across a quit (LEAD-02)", () => {
  afterEach(() => _resetTaskQueueForTest());

  it("is stored in order with each launcher task's launch, and comes back as it was", () => {
    _resetTaskQueueForTest(() => 100);
    const launch: QueuedLaunch = {
      req: { task: "Second queued feature", repoRoot: "/r", agents: [], track: "Full", doneWhen: ["npm test"], choice: BASE },
      agentIndex: 0,
      projectId: "p1",
      launchId: "L1",
      firstPrompt: "Second queued feature",
    };
    enqueueTask({ aiProvider: "claude", label: "One" }, "One");
    enqueueTask({ aiProvider: "codex", label: "Two" }, "Two", launch);
    const raw = serializeTaskQueue(listQueuedTasks());
    _resetTaskQueueForTest(() => 200);
    expect(restoreTaskQueue(raw)).toBe(2);
    const back = listQueuedTasks();
    expect(back.map((t) => [t.label, t.opts.aiProvider, t.enqueuedAt])).toEqual([
      ["One", "claude", 100],
      ["Two", "codex", 100],
    ]);
    expect(back[1].launch).toEqual(launch);
    expect(back[0].launch).toBeUndefined();
  });

  it("ignores a stored queue it cannot read", () => {
    _resetTaskQueueForTest();
    expect(restoreTaskQueue("not json")).toBe(0);
    expect(restoreTaskQueue(JSON.stringify([{ nope: 1 }, { opts: { aiProvider: "x" }, label: "ok", enqueuedAt: 5 }]))).toBe(1);
    expect(parseStoredTaskQueue(null)).toEqual([]);
    expect(listQueuedTasks().map((t) => t.label)).toEqual(["ok"]);
  });
});

describe("one overlay at a time, and the window keys behind one (CHAOS-12, SOLO-04)", () => {
  it("opening one closes the others; the top one is the last opened and closes through its own close", () => {
    const closed: string[] = [];
    const offSettings = overlayOpened("settings", () => closed.push("settings"));
    expect(topOverlay()).toBe("settings");
    overlayOpened("shortcuts", () => closed.push("shortcuts"));
    expect(closed).toEqual(["settings"]);
    expect(openOverlays()).toEqual(["shortcuts"]);
    offSettings(); // a late cleanup of a closed one changes nothing
    expect(openOverlays()).toEqual(["shortcuts"]);
    expect(closeTopOverlay()).toBe(true);
    expect(closed).toEqual(["settings", "shortcuts"]);
    expect(topOverlay()).toBeNull();
    expect(closeTopOverlay()).toBe(false);
  });
});

describe("the welcome owns the menu bar (NEWCOMER-02)", () => {
  afterEach(() => cleanupListener());

  it("drops every menu action but Help while it is up, and says why", () => {
    const ran: string[] = [];
    registerMenuBarHandler((a) => ran.push(a));
    const blocked: string[] = [];
    const off = setMenuGate((a) => {
      if (allowedBehindWelcome(a)) return true;
      blocked.push(a);
      return false;
    });
    expect(isMenuGated()).toBe(true);
    triggerMenuBarActionFromKeyboard("file.new-session");
    triggerMenuBarActionFromKeyboard("help.shortcuts");
    expect(ran).toEqual(["help.shortcuts"]);
    expect(blocked).toEqual(["file.new-session"]);
    off();
    expect(isMenuGated()).toBe(false);
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000); // past the echo window
    vi.useRealTimers();
    triggerMenuBarActionFromKeyboard("file.new-session-tab");
    expect(ran).toEqual(["help.shortcuts", "file.new-session-tab"]);
  });
});
