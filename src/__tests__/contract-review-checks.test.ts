/**
 * F36 contract addition: the review-check registry, the unified-diff reader
 * that feeds it and the runner that never trusts a check.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  _resetReviewChecksForTest,
  listReviewChecks,
  MAX_REVIEW_FINDINGS,
  normalizeReviewCheckResult,
  parseUnifiedDiff,
  registerReviewCheck,
  reviewInputFromPatch,
  runReviewChecks,
  subscribeReviewChecks,
  type ReviewCheckInput,
} from "../agent/contract/reviewChecks";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " import x from 'x';",
  "-const a = 1;",
  "+const a = 2;",
  "+const b = 3;",
  " export { a };",
  "@@ -10,2 +11,2 @@ function f() {",
  " keep();",
  "-old();",
  "+fresh();",
  "diff --git a/vendor/lib.js b/vendor/lib.js",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/vendor/lib.js",
  "@@ -0,0 +1,2 @@",
  "+// SPDX-License-Identifier: GPL-3.0-only",
  "+-- a line that starts with two dashes",
  "\\ No newline at end of file",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/old name.md b/new name.md",
  "similarity index 90%",
  "rename from old name.md",
  "rename to new name.md",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
  "",
].join("\n");

beforeEach(() => _resetReviewChecksForTest());
afterEach(() => vi.useRealTimers());

describe("parseUnifiedDiff", () => {
  it("reads files, statuses and added lines with their new line numbers", () => {
    const files = parseUnifiedDiff(PATCH);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/app.ts", "modified"],
      ["vendor/lib.js", "added"],
      ["gone.txt", "deleted"],
      ["new name.md", "renamed"],
      ["logo.png", "modified"],
    ]);
    const app = files[0];
    expect(app.added).toEqual([
      { line: 2, text: "const a = 2;" },
      { line: 3, text: "const b = 3;" },
      { line: 12, text: "fresh();" },
    ]);
    expect(app.removed).toBe(2);
    expect(files[1].added.map((l) => l.line)).toEqual([1, 2]);
    expect(files[1].added[1].text).toBe("-- a line that starts with two dashes");
    expect(files[2]).toMatchObject({ path: "gone.txt", removed: 1, added: [] });
    expect(files[3]).toMatchObject({ oldPath: "old name.md", path: "new name.md" });
    expect(files[4].binary).toBe(true);
  });

  it("reads a plain diff -u with several files and no git headers", () => {
    const plain = [
      "--- a/one.txt\t2026-01-01 00:00:00",
      "+++ b/one.txt\t2026-01-02 00:00:00",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -5,0 +6 @@",
      "+added",
    ].join("\n");
    const files = parseUnifiedDiff(plain);
    expect(files.map((f) => f.path)).toEqual(["one.txt", "two.txt"]);
    expect(files[0].added).toEqual([{ line: 1, text: "y" }]);
    expect(files[1].added).toEqual([{ line: 6, text: "added" }]);
  });

  it("handles CRLF, an empty patch and garbage without throwing", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("not a diff\nat all")).toEqual([]);
    const crlf = PATCH.split("\n").join("\r\n");
    expect(parseUnifiedDiff(crlf)[0].added[0]).toEqual({ line: 2, text: "const a = 2;" });
  });

  it("freezes what it hands out", () => {
    const input = reviewInputFromPatch("s1", 3, PATCH);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.files)).toBe(true);
    expect(Object.isFrozen(input.files[0].added[0])).toBe(true);
    expect(input).toMatchObject({ sessionId: "s1", turn: 3, patch: PATCH });
  });
});

describe("registry", () => {
  const ok = { id: "scan", title: "Scan", run: () => ({ outcome: "pass" as const, summary: "", findings: [] }) };

  it("registers, lists in order, notifies and unregisters", () => {
    const seen: number[] = [];
    subscribeReviewChecks(() => seen.push(listReviewChecks().length));
    const offA = registerReviewCheck("plugin:acme", { ...ok, description: "  finds things " });
    registerReviewCheck("plugin:other", { ...ok, title: "  Other  " });
    expect(listReviewChecks().map((c) => [c.key, c.owner, c.title, c.description])).toEqual([
      ["acme/scan", "plugin:acme", "Scan", "finds things"],
      ["other/scan", "plugin:other", "Other", ""],
    ]);
    offA();
    offA(); // twice is harmless
    expect(listReviewChecks().map((c) => c.key)).toEqual(["other/scan"]);
    expect(seen).toEqual([1, 2, 1]);
  });

  it("refuses a duplicate key and invalid definitions", () => {
    registerReviewCheck("plugin:acme", ok);
    expect(() => registerReviewCheck("plugin:acme", ok)).toThrow(/already registered/);
    expect(() => registerReviewCheck("plugin:acme", { ...ok, id: "Bad Id" })).toThrow(/lowercase/);
    expect(() => registerReviewCheck("plugin:acme", { ...ok, id: "t2", title: " " })).toThrow(/title/);
    expect(() => registerReviewCheck("plugin:acme", { ...ok, id: "t3", run: "nope" as never })).toThrow(/run/);
    expect(listReviewChecks()).toHaveLength(1);
  });

  it("the listed array is stable between changes (safe for useSyncExternalStore)", () => {
    registerReviewCheck("plugin:acme", ok);
    expect(listReviewChecks()).toBe(listReviewChecks());
  });
});

describe("normalizeReviewCheckResult", () => {
  it("accepts a result and bounds it", () => {
    const many = Array.from({ length: MAX_REVIEW_FINDINGS + 10 }, (_, i) => ({ file: "f", line: i + 1, message: "m" }));
    const r = normalizeReviewCheckResult({ outcome: "fail", summary: "x".repeat(1000), findings: many, extra: 1 });
    expect(r?.outcome).toBe("fail");
    expect(r?.summary).toHaveLength(300);
    expect(r?.findings).toHaveLength(MAX_REVIEW_FINDINGS);
    expect(normalizeReviewCheckResult({ outcome: "pass" })).toEqual({ outcome: "pass", summary: "", findings: [] });
    expect(normalizeReviewCheckResult({ outcome: "warn", findings: [{ file: "a", message: "b" }] })?.findings[0]).toEqual({
      file: "a",
      line: null,
      message: "b",
    });
  });

  it("refuses anything that is not a result", () => {
    for (const bad of [
      null,
      "pass",
      {},
      { outcome: "ok" },
      { outcome: "pass", summary: 3 },
      { outcome: "pass", findings: "x" },
      { outcome: "pass", findings: [{ file: "a" }] },
      { outcome: "pass", findings: [{ file: "a", message: "m", line: 0 }] },
      { outcome: "pass", findings: [{ file: "a", message: "m", line: 1.5 }] },
    ]) {
      expect(normalizeReviewCheckResult(bad)).toBeNull();
    }
  });
});

describe("runReviewChecks", () => {
  const input = reviewInputFromPatch("s1", 1, PATCH);

  it("runs every check over the same frozen input and keeps registration order", async () => {
    const seen: ReviewCheckInput[] = [];
    registerReviewCheck("plugin:a", {
      id: "one",
      title: "One",
      run: async (i) => {
        seen.push(i);
        await new Promise((r) => setTimeout(r, 5));
        return { outcome: "warn", summary: "slow", findings: [{ file: "src/app.ts", line: 2, message: "hm" }] };
      },
    });
    registerReviewCheck("plugin:b", {
      id: "two",
      title: "Two",
      run: (i) => {
        seen.push(i);
        (i as { turn: number }).turn = 99; // a frozen input ignores this (strict mode throws)
        return { outcome: "pass", summary: "fast", findings: [] };
      },
    });
    const runs = await runReviewChecks(input);
    expect(runs.map((r) => [r.key, r.outcome])).toEqual([
      ["a/one", "warn"],
      ["b/two", "error"],
    ]);
    expect(runs[0].findings).toEqual([{ file: "src/app.ts", line: 2, message: "hm" }]);
    expect(runs[1].summary).toMatch(/read only|read-only|Cannot assign/i);
    expect(seen[0]).toBe(input);
    expect(input.turn).toBe(1);
  });

  it("reports a throwing check, a nonsense answer and a hung check without stopping the others", async () => {
    vi.useFakeTimers();
    registerReviewCheck("plugin:a", { id: "throws", title: "Throws", run: () => { throw new Error("boom"); } });
    registerReviewCheck("plugin:a", { id: "nonsense", title: "Nonsense", run: () => ({ outcome: "great" }) as never });
    registerReviewCheck("plugin:a", { id: "hangs", title: "Hangs", run: () => new Promise(() => {}) });
    registerReviewCheck("plugin:a", { id: "fine", title: "Fine", run: () => ({ outcome: "pass", summary: "ok", findings: [] }) });
    const pending = runReviewChecks(input, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const runs = await pending;
    expect(runs.map((r) => [r.key, r.outcome, r.summary])).toEqual([
      ["a/throws", "error", "boom"],
      ["a/nonsense", "error", "The check gave an answer Hermes cannot read"],
      ["a/hangs", "timeout", "No answer within 1 s"],
      ["a/fine", "pass", "ok"],
    ]);
  });

  it("runs only the checks asked for", async () => {
    const run = vi.fn(() => ({ outcome: "pass" as const, summary: "", findings: [] }));
    registerReviewCheck("plugin:a", { id: "x", title: "X", run });
    registerReviewCheck("plugin:a", { id: "y", title: "Y", run });
    const runs = await runReviewChecks(input, { only: ["a/y"] });
    expect(runs.map((r) => r.key)).toEqual(["a/y"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("with nothing registered answers with nothing", async () => {
    expect(await runReviewChecks(input)).toEqual([]);
  });
});
