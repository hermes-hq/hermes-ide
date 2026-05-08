/**
 * Hand-rolled, dependency-free unified-diff for the v1.0.0 redesign
 * (playbook §5 "UnifiedDiffBlock").
 *
 * Design notes:
 *
 * 1. Line-based diff. We split both inputs on `\n` and compute the longest
 *    common subsequence (LCS) of those line arrays. The dynamic-programming
 *    table is reconstructed back into an edit script of `add` / `remove` /
 *    `context` rows.
 *
 * 2. Hunk folding. Long unchanged regions between hunks are folded into a
 *    single `skip` entry that the renderer shows as `…`. We keep up to
 *    `context` (default 3) lines of context on either side of each change.
 *
 * 3. Hard cap. Both inputs are capped at `maxLines` (default 5000). If either
 *    side exceeds the cap we bail out of LCS and return `truncated: true` with
 *    the result content as all-add lines so the user still sees what changed.
 *
 * 4. No deps. The existing redesign rule (anti-pattern §9) forbids new npm
 *    dependencies for the redesign — so this is hand-rolled.
 */

export type DiffLine =
  | { type: "context"; oldLine: number; newLine: number; text: string }
  | { type: "remove"; oldLine: number; text: string }
  | { type: "add"; newLine: number; text: string }
  | { type: "skip"; before: number; after: number };

export interface DiffResult {
  lines: DiffLine[];
  insertions: number;
  deletions: number;
  /**
   * True if input exceeded the hard cap and we returned the new content as
   * all-additions instead of computing a real diff. Renderers should show a
   * "diff too large" banner instead of the row list in that case.
   */
  truncated: boolean;
}

export interface ComputeDiffOptions {
  /** Max lines per side. Default 5000. Larger inputs return a degraded result. */
  maxLines?: number;
  /** Lines of context to keep around each hunk. Default 3. */
  context?: number;
}

const DEFAULT_MAX_LINES = 5000;
const DEFAULT_CONTEXT = 3;

/**
 * Split a string into lines. Treats `""` as zero lines (not one empty line),
 * which matters for the empty-input edge case. A trailing `\n` produces a
 * final empty-string line, the same way `git diff` reports a "newline at end
 * of file" line — we just keep that empty line in the output and let the
 * renderer print it.
 */
function splitLines(s: string): string[] {
  if (s === "") return [];
  return s.split("\n");
}

/**
 * Edit script step. Produced by the LCS reconstruction, consumed by the
 * hunk-folding pass that emits the public `DiffLine[]`.
 */
type Step =
  | { kind: "eq"; oldIdx: number; newIdx: number; text: string }
  | { kind: "del"; oldIdx: number; text: string }
  | { kind: "ins"; newIdx: number; text: string };

/**
 * Classic LCS edit-script reconstruction. Builds the (m+1)×(n+1) DP table of
 * common-subsequence lengths, then walks it from (m, n) back to (0, 0) emitting
 * an `eq` whenever the lines match, otherwise stepping into the larger of
 * `dp[i-1][j]` (a `del`) or `dp[i][j-1]` (an `ins`). The walk produces the
 * script in reverse, so we reverse at the end.
 *
 * Memory note: m × n int16 cells. Capped at 5000 × 5000 = 50MB worst case if
 * we used Int32; we use Uint32Array for speed and accept the memory cost
 * because callers cap input length.
 */
function lcsScript(a: string[], b: string[]): Step[] {
  const m = a.length;
  const n = b.length;
  // dp is a flat (m+1)*(n+1) Uint32Array; index via i*(n+1) + j.
  const stride = n + 1;
  const dp = new Uint32Array((m + 1) * stride);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const here = i * stride + j;
      if (a[i] === b[j]) {
        dp[here] = dp[(i + 1) * stride + (j + 1)] + 1;
      } else {
        const down = dp[(i + 1) * stride + j];
        const right = dp[i * stride + (j + 1)];
        dp[here] = down >= right ? down : right;
      }
    }
  }
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      steps.push({ kind: "eq", oldIdx: i, newIdx: j, text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
      steps.push({ kind: "del", oldIdx: i, text: a[i] });
      i++;
    } else {
      steps.push({ kind: "ins", newIdx: j, text: b[j] });
      j++;
    }
  }
  while (i < m) {
    steps.push({ kind: "del", oldIdx: i, text: a[i] });
    i++;
  }
  while (j < n) {
    steps.push({ kind: "ins", newIdx: j, text: b[j] });
    j++;
  }
  return steps;
}

/**
 * Walk the edit script and emit `DiffLine[]`, folding long runs of unchanged
 * lines into a single `skip` entry. Keeps `context` lines of context on either
 * side of each hunk; runs of unchanged lines longer than `2 * context` are
 * collapsed (otherwise we'd just emit them all as context).
 */
function foldHunks(steps: Step[], context: number): DiffLine[] {
  const lines: DiffLine[] = [];

  // First pass: emit raw rows, keeping all `eq` rows for now. Track 1-based
  // line numbers as we go; the script already has 0-based indices but the
  // renderer wants human-readable numbers.
  type Row = DiffLine;
  const raw: Row[] = [];
  for (const step of steps) {
    if (step.kind === "eq") {
      raw.push({
        type: "context",
        oldLine: step.oldIdx + 1,
        newLine: step.newIdx + 1,
        text: step.text,
      });
    } else if (step.kind === "del") {
      raw.push({
        type: "remove",
        oldLine: step.oldIdx + 1,
        text: step.text,
      });
    } else {
      raw.push({
        type: "add",
        newLine: step.newIdx + 1,
        text: step.text,
      });
    }
  }

  // Second pass: fold runs of `context` rows. Walk `raw`, find each maximal
  // consecutive run of `context` rows. If the run is the prefix or suffix of
  // the whole script, keep at most `context` rows on the change-adjacent end.
  // If it's between two changes, keep `context` on each side; otherwise
  // collapse the middle into a single `skip`.
  const isContext = (r: Row): r is Extract<Row, { type: "context" }> =>
    r.type === "context";

  let idx = 0;
  while (idx < raw.length) {
    if (!isContext(raw[idx])) {
      lines.push(raw[idx]);
      idx++;
      continue;
    }
    // Collect the contiguous context run.
    const start = idx;
    while (idx < raw.length && isContext(raw[idx])) idx++;
    const end = idx; // exclusive
    const runLen = end - start;
    const atHead = start === 0;
    const atTail = end === raw.length;

    if (atHead && atTail) {
      // Identity / no-changes case. Keep first and last `context` lines, fold
      // the middle. If runLen <= 2*context just keep them all.
      if (runLen <= context * 2) {
        for (let k = start; k < end; k++) lines.push(raw[k]);
      } else {
        for (let k = start; k < start + context; k++) lines.push(raw[k]);
        const skipped = runLen - context * 2;
        const firstKept = raw[start + context - 1];
        const lastKept = raw[end - context];
        if (
          firstKept.type === "context" &&
          lastKept.type === "context" &&
          skipped > 0
        ) {
          lines.push({
            type: "skip",
            before: firstKept.oldLine,
            after: lastKept.oldLine,
          });
        }
        for (let k = end - context; k < end; k++) lines.push(raw[k]);
      }
    } else if (atHead) {
      // Prefix: keep last `context` lines before the upcoming change.
      if (runLen <= context) {
        for (let k = start; k < end; k++) lines.push(raw[k]);
      } else {
        const firstKeptIdx = end - context;
        const lastSkippedIdx = firstKeptIdx - 1;
        const firstSkipped = raw[start];
        const lastSkipped = raw[lastSkippedIdx];
        if (
          firstSkipped.type === "context" &&
          lastSkipped.type === "context"
        ) {
          lines.push({
            type: "skip",
            before: firstSkipped.oldLine,
            after: lastSkipped.oldLine,
          });
        }
        for (let k = firstKeptIdx; k < end; k++) lines.push(raw[k]);
      }
    } else if (atTail) {
      // Suffix: keep first `context` lines after the previous change.
      if (runLen <= context) {
        for (let k = start; k < end; k++) lines.push(raw[k]);
      } else {
        const firstSkippedIdx = start + context;
        const firstSkipped = raw[firstSkippedIdx];
        const lastSkipped = raw[end - 1];
        for (let k = start; k < firstSkippedIdx; k++) lines.push(raw[k]);
        if (
          firstSkipped.type === "context" &&
          lastSkipped.type === "context"
        ) {
          lines.push({
            type: "skip",
            before: firstSkipped.oldLine,
            after: lastSkipped.oldLine,
          });
        }
      }
    } else {
      // Sandwiched: keep `context` on each side, fold the middle if longer
      // than `2 * context`.
      if (runLen <= context * 2) {
        for (let k = start; k < end; k++) lines.push(raw[k]);
      } else {
        for (let k = start; k < start + context; k++) lines.push(raw[k]);
        const firstSkippedIdx = start + context;
        const lastSkippedIdx = end - context - 1;
        const firstSkipped = raw[firstSkippedIdx];
        const lastSkipped = raw[lastSkippedIdx];
        if (
          firstSkipped.type === "context" &&
          lastSkipped.type === "context"
        ) {
          lines.push({
            type: "skip",
            before: firstSkipped.oldLine,
            after: lastSkipped.oldLine,
          });
        }
        for (let k = end - context; k < end; k++) lines.push(raw[k]);
      }
    }
  }

  return lines;
}

export function computeDiff(
  before: string,
  after: string,
  options: ComputeDiffOptions = {},
): DiffResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const context = options.context ?? DEFAULT_CONTEXT;

  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length === 0 && b.length === 0) {
    return { lines: [], insertions: 0, deletions: 0, truncated: false };
  }

  if (a.length > maxLines || b.length > maxLines) {
    // Degraded path: skip LCS, return the new content as all-adds so the user
    // sees what's there. Renderer is expected to show a banner.
    const lines: DiffLine[] = b.map((text, i) => ({
      type: "add",
      newLine: i + 1,
      text,
    }));
    return {
      lines,
      insertions: b.length,
      deletions: a.length,
      truncated: true,
    };
  }

  const steps = lcsScript(a, b);

  let insertions = 0;
  let deletions = 0;
  for (const s of steps) {
    if (s.kind === "ins") insertions++;
    else if (s.kind === "del") deletions++;
  }

  const lines = foldHunks(steps, context);

  return { lines, insertions, deletions, truncated: false };
}
