/**
 * Phase 4 (v1.0.0 redesign) — unified-diff utility.
 *
 * Pin the algorithmic behavior of `computeDiff`:
 *   - identity / pure-add / pure-remove / pure-replace / mixed scripts
 *   - skip-folding for long unchanged runs
 *   - trailing-newline edge cases
 *   - the 5000-line truncation guard
 *   - 1000 × 1000 perf budget
 *
 * The tests intentionally don't pin LCS-equivalent grouping order beyond what
 * the spec promises (`d/c/-/+` rows, with insertions/deletions counts and
 * line numbers correct).
 */
import { describe, expect, it } from "vitest";

import {
  computeDiff,
  type DiffLine,
} from "../utils/unifiedDiff";

function counts(lines: DiffLine[]) {
  let context = 0;
  let add = 0;
  let remove = 0;
  let skip = 0;
  for (const l of lines) {
    if (l.type === "context") context++;
    else if (l.type === "add") add++;
    else if (l.type === "remove") remove++;
    else skip++;
  }
  return { context, add, remove, skip };
}

describe("computeDiff — empty / identity", () => {
  it("returns no rows when both sides are empty", () => {
    const r = computeDiff("", "");
    expect(r.lines).toEqual([]);
    expect(r.insertions).toBe(0);
    expect(r.deletions).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("returns only context (or skip+context) rows when nothing changed", () => {
    const r = computeDiff("a\nb\nc", "a\nb\nc");
    const c = counts(r.lines);
    expect(c.add).toBe(0);
    expect(c.remove).toBe(0);
    expect(r.insertions).toBe(0);
    expect(r.deletions).toBe(0);
  });
});

describe("computeDiff — pure operations", () => {
  it("pure additions: empty before, content after", () => {
    const r = computeDiff("", "a\nb\nc");
    const c = counts(r.lines);
    expect(c.add).toBe(3);
    expect(c.remove).toBe(0);
    expect(c.context).toBe(0);
    expect(r.insertions).toBe(3);
    expect(r.deletions).toBe(0);
    // Line numbers run 1..3 on the new side.
    const adds = r.lines.filter((l): l is Extract<DiffLine, { type: "add" }> =>
      l.type === "add",
    );
    expect(adds.map((l) => l.newLine)).toEqual([1, 2, 3]);
  });

  it("pure removals: content before, empty after", () => {
    const r = computeDiff("a\nb\nc", "");
    const c = counts(r.lines);
    expect(c.add).toBe(0);
    expect(c.remove).toBe(3);
    expect(c.context).toBe(0);
    expect(r.deletions).toBe(3);
    expect(r.insertions).toBe(0);
    const removes = r.lines.filter(
      (l): l is Extract<DiffLine, { type: "remove" }> => l.type === "remove",
    );
    expect(removes.map((l) => l.oldLine)).toEqual([1, 2, 3]);
  });

  it("pure replacement of a single line", () => {
    const r = computeDiff("a", "b");
    expect(r.insertions).toBe(1);
    expect(r.deletions).toBe(1);
    const c = counts(r.lines);
    expect(c.add).toBe(1);
    expect(c.remove).toBe(1);
  });
});

describe("computeDiff — mixed", () => {
  it("inserts a line in the middle", () => {
    const r = computeDiff("a\nc", "a\nb\nc");
    expect(r.insertions).toBe(1);
    expect(r.deletions).toBe(0);
    const adds = r.lines.filter(
      (l): l is Extract<DiffLine, { type: "add" }> => l.type === "add",
    );
    expect(adds.length).toBe(1);
    expect(adds[0].text).toBe("b");
    expect(adds[0].newLine).toBe(2);
  });

  it("replaces a run of lines (b,c → x,y)", () => {
    const r = computeDiff("a\nb\nc\nd", "a\nx\ny\nd");
    expect(r.insertions).toBe(2);
    expect(r.deletions).toBe(2);
    const c = counts(r.lines);
    expect(c.add).toBe(2);
    expect(c.remove).toBe(2);
    // Both `a` and `d` survive as context.
    const ctxTexts = r.lines
      .filter((l): l is Extract<DiffLine, { type: "context" }> =>
        l.type === "context",
      )
      .map((l) => l.text);
    expect(ctxTexts).toContain("a");
    expect(ctxTexts).toContain("d");
  });
});

describe("computeDiff — trailing-newline edge cases", () => {
  it("adding a trailing newline produces an additional empty-line add", () => {
    const r = computeDiff("a", "a\n");
    expect(r.insertions).toBe(1);
    expect(r.deletions).toBe(0);
    const adds = r.lines.filter(
      (l): l is Extract<DiffLine, { type: "add" }> => l.type === "add",
    );
    expect(adds.length).toBe(1);
    expect(adds[0].text).toBe("");
  });

  it("removing a trailing newline produces a remove of the empty line", () => {
    const r = computeDiff("a\n", "a");
    expect(r.deletions).toBe(1);
    expect(r.insertions).toBe(0);
  });

  it("identical inputs both with trailing newline", () => {
    const r = computeDiff("a\nb\n", "a\nb\n");
    expect(r.insertions).toBe(0);
    expect(r.deletions).toBe(0);
  });
});

describe("computeDiff — skip folding", () => {
  it("collapses long unchanged runs around a single change", () => {
    const before =
      Array.from({ length: 100 }, (_, i) => `pre${i}`).join("\n") +
      "\nMID\n" +
      Array.from({ length: 100 }, (_, i) => `post${i}`).join("\n");
    const after =
      Array.from({ length: 100 }, (_, i) => `pre${i}`).join("\n") +
      "\nMODIFIED\n" +
      Array.from({ length: 100 }, (_, i) => `post${i}`).join("\n");

    const r = computeDiff(before, after, { context: 3 });
    const c = counts(r.lines);
    // 3 context above + 1 remove + 1 add + 3 context below + 1 skip head + 1 skip tail
    // Skip rows: one before the change, one after. Total skips = 2.
    expect(c.skip).toBe(2);
    // Removed `MID`, added `MODIFIED`.
    expect(c.add).toBe(1);
    expect(c.remove).toBe(1);
    // Exactly 6 context rows (3 above the change + 3 below).
    expect(c.context).toBe(6);
  });
});

describe("computeDiff — truncation guard", () => {
  it("returns truncated=true for inputs exceeding maxLines", () => {
    const huge = Array.from({ length: 6000 }, (_, i) => `l${i}`).join("\n");
    const r = computeDiff("", huge);
    expect(r.truncated).toBe(true);
    // All lines emitted as `add`.
    const c = counts(r.lines);
    expect(c.add).toBe(6000);
    expect(c.context).toBe(0);
    expect(c.remove).toBe(0);
  });

  it("respects an explicit smaller cap", () => {
    const before = "a\nb\nc";
    const after = "x\ny\nz";
    const r = computeDiff(before, after, { maxLines: 2 });
    expect(r.truncated).toBe(true);
  });
});

describe("computeDiff — counters match the script", () => {
  it("insertion + deletion counts equal the row totals (excluding skip)", () => {
    const r = computeDiff("a\nb\nc\nd\ne", "a\nb2\nc\nx\ne");
    const c = counts(r.lines);
    expect(r.insertions).toBe(c.add);
    expect(r.deletions).toBe(c.remove);
  });
});

describe("computeDiff — performance", () => {
  it("1000-line × 1000-line diff completes under 200ms", () => {
    const before = Array.from({ length: 1000 }, (_, i) => `x${i}`).join("\n");
    // Mutate every 50th line so there's actual work for the LCS to do.
    const afterArr = Array.from({ length: 1000 }, (_, i) =>
      i % 50 === 0 ? `MUT${i}` : `x${i}`,
    );
    const after = afterArr.join("\n");

    const t0 = performance.now();
    const r = computeDiff(before, after);
    const elapsed = performance.now() - t0;

    expect(r.truncated).toBe(false);
    expect(r.insertions).toBeGreaterThan(0);
    expect(r.deletions).toBeGreaterThan(0);
    // Generous threshold; CI machines vary widely. Flag only egregious blowups.
    expect(elapsed).toBeLessThan(200);
  });
});
