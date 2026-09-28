/**
 * F22 — Land sheet: the decisions and wording, table-tested.
 * The git side is covered in src-tauri/src/land/, the whole journey on the
 * real app in e2e/app/scenarios/F22-land-sheet.mjs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import {
  branchStem,
  ciLogRequest,
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

  it("lists every turn with what it changed", () => {
    expect(draftMessage(input())).toBe(
      [
        "Fix login redirect",
        "",
        "2 turns:",
        "- Turn 1: 2 files, +10 -1 (src/a.ts, src/b.ts)",
        "- Turn 2: 1 file, +3 -0 (README.md)",
      ].join("\n"),
    );
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

  it("uses the stand-in turns a test build injects", async () => {
    setFakeLandTurnsForTest("fake", [{ turn: turn(1, 1, 2, 0), patch: "diff --git a/a b/a\n" }]);
    expect(await loadLandTurns("fake")).toEqual([{ turn: turn(1, 1, 2, 0), files: ["a"] }]);
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
