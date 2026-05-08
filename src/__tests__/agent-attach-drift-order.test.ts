/**
 * Drift comparison must treat `--add-dir` lists as sets, not ordered
 * sequences.  The SDK's `additionalDirectories` option is a set; an
 * upstream reorder of `workspace_paths` (DB sort tweak, future dedup
 * pass, re-attach in different order) would otherwise spuriously fire
 * `close + spawn` on every submit.  That respawn churn was visible to
 * users as 3-5 second pauses for unrelated changes and a UUID rotation
 * that orphaned `--resume`.
 */
import { describe, it, expect } from "vitest";
import { hasAddDirDrift, addDirsEqual } from "../utils/agentDrift";

describe("hasAddDirDrift", () => {
  it("returns false for identical lists", () => {
    expect(hasAddDirDrift([], [])).toBe(false);
    expect(hasAddDirDrift(["/a"], ["/a"])).toBe(false);
    expect(hasAddDirDrift(["/a", "/b"], ["/a", "/b"])).toBe(false);
  });

  it("returns false when only the order differs", () => {
    expect(hasAddDirDrift(["/a", "/b"], ["/b", "/a"])).toBe(false);
    expect(hasAddDirDrift(
      ["/a", "/b", "/c"],
      ["/c", "/a", "/b"],
    )).toBe(false);
  });

  it("returns true when an entry is added", () => {
    expect(hasAddDirDrift(["/a"], ["/a", "/b"])).toBe(true);
    expect(hasAddDirDrift([], ["/a"])).toBe(true);
  });

  it("returns true when an entry is removed", () => {
    expect(hasAddDirDrift(["/a", "/b"], ["/a"])).toBe(true);
    expect(hasAddDirDrift(["/a"], [])).toBe(true);
  });

  it("returns true when an entry is replaced (same length)", () => {
    expect(hasAddDirDrift(["/a", "/b"], ["/a", "/c"])).toBe(true);
  });

  it("does not mutate input arrays", () => {
    const prior = ["/b", "/a"];
    const live = ["/a", "/b"];
    hasAddDirDrift(prior, live);
    expect(prior).toEqual(["/b", "/a"]);
    expect(live).toEqual(["/a", "/b"]);
  });

  it("addDirsEqual is the inverse", () => {
    expect(addDirsEqual(["/a", "/b"], ["/b", "/a"])).toBe(true);
    expect(addDirsEqual(["/a"], ["/a", "/b"])).toBe(false);
  });
});
