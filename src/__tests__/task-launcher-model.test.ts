/**
 * F15 — the task launcher's decisions (src/launcher/taskLauncher.ts):
 * branch and label from the task, the blocking rows, the Full-track
 * feature.md (read back through the C0 contract parser), the launch records
 * and the preselected agent.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_TASK_LAUNCHES,
  appendTaskLaunches,
  blockingRows,
  canLaunch,
  launchRoot,
  doneWhenFromToml,
  featureMarkdown,
  formatBytes,
  isUsableBranchName,
  nextFreeBranch,
  freeBranchFor,
  parseTaskLaunches,
  pickDefaultAgent,
  secondAgentBranch,
  taskBranch,
  taskLabel,
  taskSlug,
  type LaunchCheckInput,
  type TaskLaunchRecord,
} from "../launcher/taskLauncher";
import { findBranchClash } from "../utils/branchClash";
import { parseFeatureFrontMatter } from "../agent/contract/featureFrontMatter";
import type { DoctorRow } from "../api/doctor";

function row(id: string, over: Partial<DoctorRow> = {}): DoctorRow {
  return {
    id,
    name: id,
    installed: true,
    version: "1.0.0",
    min_version: null,
    version_ok: null,
    signed_in: "yes",
    signals: "exact",
    resume: true,
    retired: false,
    retired_note: null,
    beta: false,
    ...over,
  };
}

const GB = 1024 ** 3;

function check(over: Partial<LaunchCheckInput> = {}): LaunchCheckInput {
  return {
    agents: [{ id: "claude", branch: "hermes/fix-login" }],
    doctor: { claude: row("claude") },
    repoPath: "/fixture-home/repo",
    gitRoot: "/fixture-home/repo",
    branches: [],
    disk: { freeBytes: 50 * GB, requiredBytes: 10 * GB, belowThreshold: false },
    ...over,
  };
}

describe("branch and label from the task", () => {
  it("takes the first words as a branch-safe slug", () => {
    expect(taskSlug("Fix the flaky login test on CI please")).toBe("fix-the-flaky-login-test-on");
    expect(taskBranch("Add dark mode")).toBe("hermes/add-dark-mode");
    expect(taskBranch("Ïnïcode café — naïve")).toBe("hermes/inicode-cafe-naive");
    // German umlauts and ß are spelled out, not dropped (QAGIT-21b).
    expect(taskBranch("Größe prüfen für Überschrift")).toBe("hermes/groesse-pruefen-fuer-ueberschrift");
    // Nothing to name it after: hermes/task-<id> with the sheet's id.
    expect(taskBranch("🚀🚀", "a1b2c3")).toBe("hermes/task-a1b2c3");
    expect(taskBranch("修复登录", "a1b2c3")).toBe("hermes/task-a1b2c3");
    expect(taskBranch("   ")).toBe("hermes/task");
    expect(taskBranch("!!! ???")).toBe("hermes/task");
  });

  it("keeps the slug short enough for a branch", () => {
    const slug = taskSlug("a".repeat(30) + " " + "b".repeat(30));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("names the second agent's branch after the agent", () => {
    expect(secondAgentBranch("hermes/fix-login", "codex")).toBe("hermes/fix-login-codex");
  });

  it("suggests the first free -n branch", () => {
    const taken = new Set(["hermes/x", "hermes/x-2"]);
    expect(nextFreeBranch("hermes/x", (b) => taken.has(b))).toBe("hermes/x-3");
  });

  it("refuses names git would refuse", () => {
    for (const ok of ["hermes/a", "feature/x-1", "a.b"]) expect(isUsableBranchName(ok)).toBe(true);
    for (const bad of ["", " ", "-x", "a b", "a..b", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "x.lock", "x/", "/x", "a//b", "a@{1}", "x."]) {
      expect(isUsableBranchName(bad), bad).toBe(false);
    }
  });

  it("labels the session with the task's first line", () => {
    expect(taskLabel("Fix login\nmore detail")).toBe("Fix login");
    const long = taskLabel("x".repeat(100));
    expect(long.length).toBe(48);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("done when, from .hermes/worktree.toml", () => {
  it("reads done_when through the contract parser", () => {
    expect(doneWhenFromToml('done_when = ["npm test", "npm run lint"]\n')).toEqual({ commands: ["npm test", "npm run lint"], error: null });
    expect(doneWhenFromToml("setup = [\"npm ci\"]\n")).toEqual({ commands: [], error: null });
    expect(doneWhenFromToml(null)).toEqual({ commands: [], error: null });
  });

  it("says which line it could not read", () => {
    const r = doneWhenFromToml("done_when = [\n");
    expect(r.commands).toEqual([]);
    expect(r.error).toMatch(/^line \d+: /);
  });
});

describe("blocking rows", () => {
  it("none when everything is ready", () => {
    expect(blockingRows(check())).toEqual([]);
    expect(canLaunch("do it", "/fixture-home/repo", [])).toBe(true);
  });

  it("a signed-out agent blocks Launch", () => {
    const rows = blockingRows(check({ doctor: { claude: row("claude", { signed_in: "no" }) } }));
    expect(rows).toEqual([{ kind: "signed-out", agentId: "claude" }]);
    expect(canLaunch("do it", "/fixture-home/repo", rows)).toBe(false);
  });

  it("an unknown sign-in state does not block (the CLI asks itself)", () => {
    expect(blockingRows(check({ doctor: { claude: row("claude", { signed_in: "unknown" }) } }))).toEqual([]);
  });

  it("a missing agent blocks; an agent the doctor has not answered for yet does not", () => {
    expect(blockingRows(check({ doctor: { claude: row("claude", { installed: false }) } }))).toEqual([
      { kind: "not-installed", agentId: "claude" },
    ]);
    expect(blockingRows(check({ doctor: {} }))).toEqual([]);
  });

  it("an existing branch blocks and suggests a free one", () => {
    const taken = ["hermes/fix-login", "hermes/fix-login-2"];
    expect(blockingRows(check({ branches: taken }))).toEqual([
      { kind: "branch-exists", branch: "hermes/fix-login", suggestion: "hermes/fix-login-3", existing: "hermes/fix-login", clash: "same" },
    ]);
  });

  it("a branch that differs from an existing one only in letter case blocks and names the existing one", () => {
    // On macOS and Windows hermes/Fix-Login IS hermes/fix-login: creating it would hand back the existing branch.
    expect(blockingRows(check({ agents: [{ id: "claude", branch: "hermes/Fix-Login" }], branches: ["main", "hermes/fix-login", "hermes/FIX-LOGIN-2"] }))).toEqual([
      { kind: "branch-exists", branch: "hermes/Fix-Login", suggestion: "hermes/Fix-Login-3", existing: "hermes/fix-login", clash: "case" },
    ]);
    // A folder that differs only in case is the same folder there.
    // Its suggestion spells the folder as the existing branch does: a -2
    // suffix would still be in the Feature/ folder.
    expect(blockingRows(check({ agents: [{ id: "claude", branch: "Feature/new" }], branches: ["feature/inbox"] }))).toEqual([
      { kind: "branch-exists", branch: "Feature/new", suggestion: "feature/new", existing: "feature/inbox", clash: "folder" },
    ]);
    expect(blockingRows(check({ agents: [{ id: "claude", branch: "feature/new" }], branches: ["feature/inbox", "Develop"] }))).toEqual([]);
  });

  it("the branch offered instead is always free, folders included", () => {
    const branches = ["feature/inbox", "feature/new", "team/a/x"];
    expect(freeBranchFor("Feature/new", branches)).toBe("feature/new-2");
    expect(freeBranchFor("Feature/Other", branches)).toBe("feature/Other");
    expect(freeBranchFor("TEAM/A/z", branches)).toBe("team/a/z");
    for (const typed of ["Feature/new", "Feature/Other", "TEAM/A/z", "team/b/q", "feature/INBOX"]) {
      const offered = freeBranchFor(typed, branches);
      expect(offered).not.toBeNull();
      expect(findBranchClash(offered!, branches)).toBeNull();
    }
  });

  it("a folder that is not a repository never blocks, and no branch is judged there", () => {
    expect(blockingRows(check({ gitRoot: null, branches: ["hermes/fix-login"] }))).toEqual([]);
    expect(blockingRows(check({ gitRoot: null, branches: ["hermes/fix-login"], folder: { exists: true, isDir: true, hasCommits: false } }))).toEqual([]);
    // It is where the launch runs; nothing at the path is nowhere.
    expect(launchRoot(null, { exists: true, isDir: true }, " /fixture-home/notes ")).toBe("/fixture-home/notes");
    expect(launchRoot(null, { exists: false, isDir: false }, "/fixture-home/gone")).toBeNull();
    expect(launchRoot(null, { exists: true, isDir: false }, "/fixture-home/file.txt")).toBeNull();
    expect(launchRoot("/fixture-home/repo", { exists: true, isDir: true }, "/fixture-home/repo/src")).toBe("/fixture-home/repo");
    expect(launchRoot(undefined, null, "/fixture-home/repo")).toBeUndefined();
    expect(canLaunch("do it", "/fixture-home/notes", [])).toBe(true);
    expect(blockingRows(check({ repoPath: "  ", gitRoot: undefined }))).toEqual([{ kind: "no-repo" }]);
    // Still checking: nothing to say yet, and Launch waits.
    expect(blockingRows(check({ gitRoot: undefined }))).toEqual([]);
    expect(canLaunch("do it", undefined, [])).toBe(false);
  });

  it("low disk blocks", () => {
    const rows = blockingRows(check({ disk: { freeBytes: 3 * GB, requiredBytes: 10 * GB, belowThreshold: true } }));
    expect(rows).toEqual([{ kind: "low-disk", freeBytes: 3 * GB, requiredBytes: 10 * GB }]);
  });

  it("checks the second agent and its branch too", () => {
    const rows = blockingRows(
      check({
        agents: [
          { id: "claude", branch: "hermes/x" },
          { id: "codex", branch: "hermes/x-codex" },
        ],
        doctor: { claude: row("claude"), codex: row("codex", { signed_in: "no" }) },
        branches: ["hermes/x-codex"],
      }),
    );
    expect(rows.map((r) => r.kind)).toEqual(["signed-out", "branch-exists"]);
  });

  it("an empty task never launches", () => {
    expect(canLaunch("   ", "/fixture-home/repo", [])).toBe(false);
  });

  it("formats sizes for people", () => {
    expect(formatBytes(12.34e9)).toBe("12.3 GB");
    expect(formatBytes(10e9)).toBe("10.0 GB");
    expect(formatBytes(512e6)).toBe("512 MB");
  });
});

describe("Full track: the first feature.md", () => {
  it("is what the contract parser reads back", () => {
    const text = featureMarkdown({ slug: "fix-login", task: "Fix the login bug\n\nIt breaks on Safari.", doneWhen: ["npm test", 'grep -q "ok" out # not a comment'] });
    const parsed = parseFeatureFrontMatter(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta).toMatchObject({ slug: "fix-login", track: "Full", phase: "questions", gate: "none" });
    expect(parsed.meta.doneWhen).toEqual(["npm test", 'grep -q "ok" out # not a comment']);
    expect(parsed.body.trim()).toBe("Fix the login bug\n\nIt breaks on Safari.");
  });

  it("with no check, done_when is an empty list", () => {
    const parsed = parseFeatureFrontMatter(featureMarkdown({ slug: "x", task: "t", doneWhen: [] }));
    expect(parsed.ok && parsed.meta.doneWhen).toEqual([]);
  });
});

describe("launch records", () => {
  const rec = (id: string): TaskLaunchRecord => ({
    sessionId: id,
    task: "t",
    agentId: "claude",
    mode: "terminal",
    repo: "/fixture-home/repo",
    branch: "hermes/t",
    track: "Quick",
    doneWhen: [],
    pairedWith: null,
    createdAt: 1,
  });

  it("drops malformed entries and keeps the newest", () => {
    expect(parseTaskLaunches("not json")).toEqual([]);
    expect(parseTaskLaunches(JSON.stringify([rec("a"), { sessionId: 3 }, { ...rec("b"), track: "Huge" }]))).toEqual([rec("a")]);
    const many = Array.from({ length: MAX_TASK_LAUNCHES + 5 }, (_, i) => rec(`s${i}`));
    const kept = appendTaskLaunches(many.slice(0, MAX_TASK_LAUNCHES), many.slice(MAX_TASK_LAUNCHES));
    expect(kept.length).toBe(MAX_TASK_LAUNCHES);
    expect(kept[kept.length - 1].sessionId).toBe(`s${MAX_TASK_LAUNCHES + 4}`);
    expect(appendTaskLaunches([rec("a")], [{ ...rec("a"), task: "new" }])).toEqual([{ ...rec("a"), task: "new" }]);
  });
});

describe("the preselected agent", () => {
  const ids = ["claude", "codex", "gemini"];
  it("is the last used one while it is installed", () => {
    expect(pickDefaultAgent("codex", ids, { claude: row("claude"), codex: row("codex") })).toBe("codex");
  });
  it("else the first installed one", () => {
    expect(pickDefaultAgent("codex", ids, { claude: row("claude", { installed: false }), codex: row("codex", { installed: false }), gemini: row("gemini") })).toBe("gemini");
  });
  it("else the last used, else the first in the catalog", () => {
    expect(pickDefaultAgent("codex", ids, {})).toBe("codex");
    expect(pickDefaultAgent(null, ids, {})).toBe("claude");
    expect(pickDefaultAgent("gone", ids, {})).toBe("claude");
  });
});
