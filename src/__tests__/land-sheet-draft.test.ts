/**
 * F22 — Land sheet: the decisions and wording, table-tested.
 * The git side is covered in src-tauri/src/land/, the whole journey on the
 * real app in e2e/app/scenarios/F22-land-sheet.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import {
  baseBranchNote,
  baseMismatchNote,
  branchStem,
  ciLogRequest,
  defaultLandMode,
  doneWhenCommands,
  doneWhenLabel,
  doneWhenState,
  draftMessage,
  draftPrBody,
  draftSubject,
  landAvailability,
  mergeNote,
  pickFeature,
  rebaseRequest,
  type DraftInput,
} from "../land/draft";
import { filesInPatch, loadLandTurns, setFakeLandTurnsForTest, type LandTurn } from "../land/turnSource";
import type { LandPreview } from "../land/api";
import type { Turn } from "../agent/contract/turns";

const FEATURE = `---
slug: search-index
track: Full
phase: implement
gate: approved
done_when:
  - npm test
---
# Search index for notes

Build an index so search is instant.
`;

function turn(n: number, files: number, ins: number, del: number): Turn {
  return {
    sessionId: "s1",
    n,
    ref: `refs/hermes/s1/turn/${n}`,
    startedAt: n * 1000,
    endedAt: n * 1000 + 500,
    diffstat: { files, insertions: ins, deletions: del },
  };
}

const TURNS: LandTurn[] = [
  { turn: turn(1, 2, 10, 1), files: ["src/a.ts", "src/b.ts"] },
  { turn: turn(2, 1, 3, 0), files: ["README.md"] },
];

function input(over: Partial<DraftInput> = {}): DraftInput {
  return {
    branch: "hermes/fix-login-redirect",
    label: "Fix login",
    turns: TURNS,
    feature: null,
    diffstat: { files: 3, insertions: 13, deletions: 1 },
    ...over,
  };
}

function preview(over: Partial<LandPreview> = {}): LandPreview {
  return {
    branch: "hermes/x",
    head: "abc",
    uncommittedFiles: 1,
    commitsAhead: 0,
    diffstat: { files: 1, insertions: 1, deletions: 0 },
    changedFiles: ["a.txt"],
    base: { name: "main", head: "def", checkedOutAt: "/repo" },
    merge: { kind: "fast_forward" },
    worktreePath: "/data/hermes-worktrees/h/x",
    repoPath: "/repo",
    shared: false,
    remote: "origin",
    worktreeToml: null,
    features: [],
    landings: [],
    ...over,
  };
}

const IDLE = { kind: "idle", confidence: "exact", detail: "" } as const;

describe("which feature belongs to the task", () => {
  it("matches the feature slug to the hermes/<slug> branch", () => {
    const files = [
      { folder: "other", text: FEATURE.replace("search-index", "other-thing") },
      { folder: "search-index", text: FEATURE },
    ];
    expect(pickFeature(files, "hermes/search-index")?.meta.slug).toBe("search-index");
    expect(pickFeature(files, "hermes/unrelated")).toBeNull();
    expect(pickFeature([{ folder: "bad", text: "no front matter" }], "hermes/bad")).toBeNull();
  });

  it("strips hermes/ or any folder from the branch", () => {
    expect(branchStem("hermes/a-b")).toBe("a-b");
    expect(branchStem("feat/x/y")).toBe("y");
    expect(branchStem("plain")).toBe("plain");
  });
});

describe("Done-When", () => {
  const feature = pickFeature([{ folder: "f", text: FEATURE }], "hermes/search-index");

  it("uses the feature's commands, else the worktree recipe's", () => {
    expect(doneWhenCommands(feature, 'done_when = ["cargo test"]')).toEqual(["npm test"]);
    expect(doneWhenCommands(null, 'done_when = ["cargo test", "npm run lint"]')).toEqual(["cargo test", "npm run lint"]);
    expect(doneWhenCommands(null, "not = [toml")).toEqual([]);
    expect(doneWhenCommands(null, null)).toEqual([]);
  });

  it("is failing when the session reports check_failed, and never claims passing", () => {
    expect(doneWhenState([], IDLE)).toEqual({ kind: "none" });
    expect(doneWhenLabel(doneWhenState([], IDLE))).toBe("No Done-When checks");
    const notRun = doneWhenState(["npm test"], IDLE);
    expect(notRun.kind).toBe("not_run");
    expect(doneWhenLabel(notRun)).toBe("1 check, no result yet");
    const failing = doneWhenState(["npm test"], { kind: "check_failed", confidence: "exact", detail: "npm test exited 1" });
    expect(failing.kind).toBe("failing");
    expect(doneWhenLabel(failing)).toBe("Failing: npm test exited 1");
  });
});

describe("the drafted message", () => {
  it("takes the subject from the plan's title, else the branch, else the session", () => {
    const feature = pickFeature([{ folder: "f", text: FEATURE }], "hermes/search-index");
    expect(draftSubject(input({ feature }))).toBe("Search index for notes");
    expect(draftSubject(input())).toBe("Fix login redirect");
    expect(draftSubject(input({ branch: "hermes/0123abcd" }))).toBe("Fix login");
    expect(draftSubject(input({ branch: "hermes/", label: "" }))).toBe("Land task");
  });

  it("keeps the turn list out of the commit (it belongs to the pull request body)", () => {
    const message = draftMessage(input());
    expect(message).not.toContain("Turn 1");
    expect(message.split("\n")[0]).toBe("Fix login redirect");
  });

  it("drafts the subject from the task typed in the launcher, and the body from the task and Done-When", () => {
    const task = "Fix the flaky login test (CI only, see #42)";
    expect(draftSubject(input({ task }))).toBe(task);
    expect(draftMessage(input({ task, doneWhen: ["npm test", "npm run lint"] }))).toBe(
      `${task}\n\nDone-When: npm test; npm run lint`,
    );
    // A task longer than one line: its first line, the whole task below.
    const long = "Make Ölçüm export work\n\nThe CSV export drops umlauts in names.";
    expect(draftMessage(input({ task: long }))).toBe(`Make Ölçüm export work\n\n${long}`);
    // The plan's title still wins.
    const feature = pickFeature([{ folder: "f", text: FEATURE }], "hermes/search-index");
    expect(draftSubject(input({ task, feature }))).toBe("Search index for notes");
    // At most 72 characters, cut at a word.
    const subject = draftSubject(input({ task: "word ".repeat(30) }));
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith("…")).toBe(true);
  });

  it("falls back to the totals when no turn was recorded", () => {
    expect(draftMessage(input({ turns: [] }))).toBe("Fix login redirect\n\nChanges: 3 files, +13 -1");
  });

  it("builds a PR body with the turns, the plan and the checks", () => {
    const feature = pickFeature([{ folder: "f", text: FEATURE }], "hermes/search-index");
    const body = draftPrBody(input({ feature }), ["npm test"]);
    expect(body).toContain("## Turns\n\n- Turn 1: 2 files, +10 -1 (src/a.ts, src/b.ts)\n- Turn 2");
    expect(body).toContain("## Plan\n\n# Search index for notes\n\nBuild an index so search is instant.");
    expect(body).toContain("## Done-When\n\n- `npm test`");
    expect(body).toContain("**Changes:** 3 files, +13 -1");
    const bare = draftPrBody(input({ turns: [] }), []);
    expect(bare).toContain("No turns were recorded for this session.");
    expect(bare).not.toContain("## Plan");
  });
});

describe("which options can be used", () => {
  it("disables the pull request while gh is missing or signed out, or with no remote", () => {
    expect(landAvailability(preview(), { state: "ready", detail: "" }).pr).toBeNull();
    expect(landAvailability(preview(), { state: "missing", detail: "" }).pr).toBe("GitHub CLI (gh) is not installed.");
    expect(landAvailability(preview(), { state: "signed_out", detail: "" }).pr).toBe("GitHub CLI (gh) is not signed in.");
    expect(landAvailability(preview(), null).pr).toBe("Checking GitHub CLI…");
    expect(landAvailability(preview({ remote: null }), { state: "ready", detail: "" }).pr).toMatch(/no remote/);
  });

  it("never offers a merge that would conflict", () => {
    const p = preview({ merge: { kind: "conflict", files: ["a.txt"] } });
    expect(landAvailability(p, null).merge).toBe("Merging into main would conflict in a.txt.");
    expect(landAvailability(preview({ merge: { kind: "clean" } }), null).merge).toBeNull();
    expect(mergeNote({ kind: "clean" }, "main")).toBe("main moved on; merging is clean.");
    expect(mergeNote({ kind: "fast_forward" }, "main")).toMatch(/fast-forward/);
  });

  it("only commits or archives what is safe", () => {
    expect(landAvailability(preview({ uncommittedFiles: 0 }), null).commit).toMatch(/No uncommitted/);
    expect(landAvailability(preview(), null).archive).toMatch(/land them first/);
    expect(landAvailability(preview({ uncommittedFiles: 0 }), null).archive).toBeNull();
    expect(landAvailability(preview({ uncommittedFiles: 0, shared: true }), null).archive).toMatch(/Another session/);
  });

  it("words the one-line requests for the agent without a newline", () => {
    expect(rebaseRequest("main", ["a.txt", "b.txt"])).toBe(
      "Please rebase this branch onto main and resolve the conflicts in a.txt, b.txt.",
    );
    expect(ciLogRequest("test", ".hermes/ci/test.log")).not.toContain("\n");
  });
});

describe("turns for the sheet", () => {
  beforeEach(() => {
    h.invoke.mockReset();
  });

  it("reads the files a patch touches", () => {
    const patch = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\ndiff --git a/old.ts b/new.ts\ndiff --git a/x.ts b/x.ts\n";
    expect(filesInPatch(patch)).toEqual(["x.ts", "new.ts"]);
  });

  it("asks the ledger for the turns and their diffs, oldest first", async () => {
    h.invoke.mockImplementation(async (cmd: string, args: { n?: number }) => {
      if (cmd === "list_turns") return [turn(2, 1, 1, 0), turn(1, 1, 1, 0)];
      if (cmd === "get_turn_diff") return { turn: turn(args.n ?? 0, 1, 1, 0), patch: `diff --git a/f${args.n} b/f${args.n}\n` };
      throw new Error(cmd);
    });
    const turns = await loadLandTurns("ledger-session");
    expect(turns.map((t) => [t.turn.n, t.files])).toEqual([
      [1, ["f1"]],
      [2, ["f2"]],
    ]);
  });

  it("answers with no turns when the ledger fails", async () => {
    h.invoke.mockRejectedValue(new Error("no ledger"));
    expect(await loadLandTurns("broken")).toEqual([]);
  });

  describe("stand-in turns", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("uses the stand-in turns a test build injects", async () => {
      vi.stubEnv("VITE_HERMES_E2E", "1");
      setFakeLandTurnsForTest("fake", [{ turn: turn(1, 1, 2, 0), patch: "diff --git a/a b/a\n" }]);
      expect(await loadLandTurns("fake")).toEqual([{ turn: turn(1, 1, 2, 0), files: ["a"] }]);
      expect(h.invoke).not.toHaveBeenCalled();
    });

    it("ignores stand-in turns outside a test build and asks the ledger", async () => {
      vi.stubEnv("VITE_HERMES_E2E", "");
      setFakeLandTurnsForTest("fake-normal", [{ turn: turn(1, 1, 2, 0), patch: "diff --git a/a b/a\n" }]);
      h.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "list_turns") return [];
        throw new Error(cmd);
      });
      expect(await loadLandTurns("fake-normal")).toEqual([]);
      expect(h.invoke).toHaveBeenCalledWith("list_turns", { sessionId: "fake-normal" });
    });
  });
});

describe("which branch landing goes to", () => {
  it("says nothing when the project folder is on a main line", () => {
    expect(baseBranchNote("main")).toBeNull();
    expect(baseBranchNote("master")).toBeNull();
    expect(baseBranchNote("trunk")).toBeNull();
    expect(baseBranchNote(null)).toBeNull();
  });

  it("warns when the project folder is on another branch", () => {
    expect(baseBranchNote("release-1")).toBe(
      "The project folder has release-1 checked out, so this lands on release-1. To land on your main branch, pick it in Land into.",
    );
  });

  it("says nothing when the base is the branch the task was started from", () => {
    expect(baseBranchNote("develop", "develop")).toBeNull();
  });

  it("warns when landing elsewhere than where the task started would bring that branch's commits", () => {
    expect(baseMismatchNote({ recorded: "develop", commits: 1 }, "main")).toBe(
      "This task was started from develop. Landing into main would also bring develop's 1 commit.",
    );
    expect(baseMismatchNote({ recorded: "develop", commits: 3 }, "main")).toContain("develop's 3 commits");
    expect(baseMismatchNote(null, "main")).toBeNull();
    expect(baseMismatchNote({ recorded: "develop", commits: 1 }, "develop")).toBeNull();
  });
});

describe("pull requests and remotes", () => {
  const base = { name: "main", head: "a", checkedOutAt: null };
  const preview = (over: Partial<LandPreview> = {}): LandPreview =>
    ({
      branch: "hermes/x", head: "b", uncommittedFiles: 1, commitsAhead: 1,
      diffstat: { files: 1, insertions: 1, deletions: 0 }, changedFiles: ["a"], base,
      merge: { kind: "fast_forward" }, worktreePath: "/w", repoPath: "/r", shared: false,
      remote: "origin", worktreeToml: null, features: [], landings: [], ...over,
    }) as LandPreview;

  it("with no remote, says only that (never also to sign in to gh)", () => {
    const a = landAvailability(preview({ remote: null }), { state: "signed_out", detail: "" });
    expect(a.pr).toBe("This repository has no remote. Add one (git remote add origin <url>) to open a pull request.");
  });

  it("a remote that is not on GitHub: no pull request, and the sheet picks a local merge", () => {
    const gh = { state: "not_github" as const, detail: "origin (/srv/x.git) is not a GitHub repository" };
    const a = landAvailability(preview(), gh);
    expect(a.pr).toBe("origin isn't a GitHub repository.");
    expect(defaultLandMode(a, gh)).toBe("merge");
  });

  it("a dirty file in the project folder that landing writes blocks the merge, without ever saying stash", () => {
    const a = landAvailability(preview({ merge: { kind: "dirty_base", files: ["README.md"] } }), { state: "ready", detail: "" });
    expect(a.merge).toBe("README.md has uncommitted changes in the project folder (main).");
    expect(a.merge).not.toMatch(/stash/i);
  });
});

describe("defaultLandMode: the option the sheet picks by itself", () => {
  const all = { commit: null, pr: null, merge: null, archive: null };
  const ready = { state: "ready" as const, detail: "" };
  it.each([
    ["a pull request when one can be opened", all, ready, "pr"],
    ["nothing while the GitHub CLI is still being checked (merge could be the wrong guess)", { ...all, pr: "Checking GitHub CLI…" }, null, null],
    ["a merge once the CLI is known to be unusable", { ...all, pr: "GitHub CLI (gh) is not signed in." }, { state: "signed_out" as const, detail: "" }, "merge"],
    ["a commit when neither a PR nor a merge can be done", { ...all, pr: "no remote", merge: "nothing to merge" }, ready, "commit"],
    ["nothing when no option can be used", { commit: "x", pr: "x", merge: "x", archive: null }, ready, null],
  ])("%s", (_name, available, gh, expected) => {
    expect(defaultLandMode(available, gh)).toBe(expected);
  });
});
