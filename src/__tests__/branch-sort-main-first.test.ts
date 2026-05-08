/**
 * The unified branch picker must surface `main` (or `master`, in legacy
 * repos) at the top of the list — that is the single most common
 * destination from any feature branch, and the user wants the create-
 * session flow to land there with the fewest clicks.
 *
 * Display priority:
 *   0 — main
 *   1 — master
 *   2 — current branch (only when it isn't main/master)
 *   3 — everything else (alphabetical by display name)
 */
import { describe, it, expect } from "vitest";
import {
  branchDisplayPriority,
  sortBranchesMainFirst,
} from "../components/SessionBranchSelector";

type B = { name: string; is_remote: boolean; is_current: boolean };

const mk = (name: string, opts?: Partial<B>): B => ({
  name,
  is_remote: false,
  is_current: false,
  ...opts,
});

describe("branchDisplayPriority", () => {
  it("main → 0", () => {
    expect(branchDisplayPriority({ displayName: "main", isCurrent: false })).toBe(0);
  });
  it("master → 1", () => {
    expect(branchDisplayPriority({ displayName: "master", isCurrent: false })).toBe(1);
  });
  it("current (non-main/master) → 2", () => {
    expect(branchDisplayPriority({ displayName: "feature/x", isCurrent: true })).toBe(2);
  });
  it("everything else → 3", () => {
    expect(branchDisplayPriority({ displayName: "feature/x", isCurrent: false })).toBe(3);
  });
  it("main beats current — main is still 0 even when it is_current", () => {
    expect(branchDisplayPriority({ displayName: "main", isCurrent: true })).toBe(0);
  });
});

describe("sortBranchesMainFirst", () => {
  it("main appears at the top when present", () => {
    const out = sortBranchesMainFirst([
      mk("alpha"),
      mk("zeta"),
      mk("main"),
      mk("feature/x"),
    ]);
    expect(out.map((b) => b.name)).toEqual(["main", "alpha", "feature/x", "zeta"]);
  });

  it("master appears at the top when no main exists", () => {
    const out = sortBranchesMainFirst([
      mk("alpha"),
      mk("master"),
      mk("zeta"),
    ]);
    expect(out.map((b) => b.name)).toEqual(["master", "alpha", "zeta"]);
  });

  it("main beats master when both exist", () => {
    const out = sortBranchesMainFirst([
      mk("alpha"),
      mk("master"),
      mk("main"),
    ]);
    expect(out.map((b) => b.name)).toEqual(["main", "master", "alpha"]);
  });

  it("current branch is surfaced before alphabetical when neither main nor master exist", () => {
    const out = sortBranchesMainFirst([
      mk("alpha"),
      mk("zeta"),
      mk("feature/x", { is_current: true }),
    ]);
    expect(out.map((b) => b.name)).toEqual(["feature/x", "alpha", "zeta"]);
  });

  it("current branch lands BELOW main even when current ≠ main", () => {
    const out = sortBranchesMainFirst([
      mk("feature/x", { is_current: true }),
      mk("alpha"),
      mk("main"),
    ]);
    expect(out.map((b) => b.name)).toEqual(["main", "feature/x", "alpha"]);
  });

  it("remote branches use stripped prefix for priority + alphabetical", () => {
    const out = sortBranchesMainFirst([
      mk("origin/feature-x", { is_remote: true }),
      mk("origin/main", { is_remote: true }),
      mk("origin/alpha", { is_remote: true }),
    ]);
    expect(out.map((b) => b.name)).toEqual([
      "origin/main",
      "origin/alpha",
      "origin/feature-x",
    ]);
  });

  it("does not mutate the input list", () => {
    const input = [mk("alpha"), mk("main"), mk("zeta")];
    const before = input.map((b) => b.name).join(",");
    sortBranchesMainFirst(input);
    expect(input.map((b) => b.name).join(",")).toBe(before);
  });

  it("empty list — empty list out", () => {
    expect(sortBranchesMainFirst([])).toEqual([]);
  });

  it("only main — only main", () => {
    const out = sortBranchesMainFirst([mk("main")]);
    expect(out.map((b) => b.name)).toEqual(["main"]);
  });

  it("alphabetical fallback uses localeCompare on display name", () => {
    const out = sortBranchesMainFirst([
      mk("Zeta"),
      mk("alpha"),
      mk("Beta"),
    ]);
    // localeCompare: A/a/B/b/Z/z order — case-aware, locale-aware.
    expect(out.map((b) => b.name)).toEqual(["alpha", "Beta", "Zeta"]);
  });
});
