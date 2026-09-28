// ─── Review checks seam ──────────────────────────────────────────────
//
// Contract addition by F36 (docs/adr/004-2.0-contracts.md, section 7).
// A review check looks at what a turn (or a whole session) changed and says
// pass, warn or fail, with findings pinned to files and lines: a license
// scan, a secret scan, a size budget. Plugins register them through
// `review.registerCheck()` (plugin API v2); F21's Review Desk lists them
// and runs them over the diff it shows, which for a turn is the `patch` of
// `get_turn_diff` (turns.ts). No UI here.
//
// The runner never trusts a check: every check gets its own frozen copy of
// the input, a time limit, and its answer is validated and bounded. A check
// that throws, times out or answers nonsense is reported as `error` or
// `timeout` and never stops the others.

import { useSyncExternalStore } from "react";

export const REVIEW_CHECK_OUTCOMES = ["pass", "warn", "fail"] as const;
export type ReviewCheckOutcome = (typeof REVIEW_CHECK_OUTCOMES)[number];

export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ReviewLine {
  /** 1-based line number in the new version of the file. */
  readonly line: number;
  readonly text: string;
}

export interface ReviewFile {
  /** Path in the new version (the old path for a deleted file). */
  readonly path: string;
  /** The path before a rename, else null. */
  readonly oldPath: string | null;
  readonly status: ReviewFileStatus;
  readonly binary: boolean;
  /** Lines the change adds, in order. */
  readonly added: readonly ReviewLine[];
  /** How many lines the change removes. */
  readonly removed: number;
}

/** What a check is asked to look at. */
export interface ReviewCheckInput {
  readonly sessionId: string;
  /** The turn under review, or null for the whole session. */
  readonly turn: number | null;
  /** The unified diff, as git prints it. */
  readonly patch: string;
  /** The same diff, parsed. */
  readonly files: readonly ReviewFile[];
}

export interface ReviewFinding {
  readonly file: string;
  /** 1-based line in the new version, or null for the whole file. */
  readonly line: number | null;
  readonly message: string;
}

/** What a check answers. */
export interface ReviewCheckResult {
  readonly outcome: ReviewCheckOutcome;
  /** One line for people. */
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

/** What a registrant passes. */
export interface ReviewCheckDefinition {
  /** Lowercase letters, digits, ".", "_" and "-"; unique per owner. */
  readonly id: string;
  /** Short name shown in the Review Desk. */
  readonly title: string;
  readonly description?: string;
  run(input: ReviewCheckInput): ReviewCheckResult | Promise<ReviewCheckResult>;
}

/** A registered check, as listed. */
export interface ReviewCheck {
  /** `<owner id>/<check id>`, unique. */
  readonly key: string;
  /** Who registered it: "plugin:<id>", or a built-in name. */
  readonly owner: string;
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

/** One check's answer for one input. */
export interface ReviewCheckRun {
  readonly key: string;
  readonly owner: string;
  readonly title: string;
  readonly outcome: ReviewCheckOutcome | "error" | "timeout";
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly durationMs: number;
}

export const REVIEW_CHECK_TIMEOUT_MS = 10_000;
export const MAX_REVIEW_FINDINGS = 200;
const MAX_SUMMARY = 300;
const MAX_MESSAGE = 500;
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 300;
const CHECK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// ─── Registry ────────────────────────────────────────────────────────

interface Entry {
  readonly check: ReviewCheck;
  readonly run: ReviewCheckDefinition["run"];
}

let entries: readonly Entry[] = Object.freeze([]);
let listed: readonly ReviewCheck[] = Object.freeze([]);
const listeners = new Set<() => void>();

function publish(next: readonly Entry[]): void {
  entries = Object.freeze(next);
  listed = Object.freeze(next.map((e) => e.check));
  for (const l of [...listeners]) l();
}

function ownerId(owner: string): string {
  return owner.startsWith("plugin:") ? owner.slice("plugin:".length) : owner;
}

/**
 * Register a check. Returns the function that removes it. Throws on an
 * invalid definition or when the owner already has a check with this id.
 */
export function registerReviewCheck(owner: string, def: ReviewCheckDefinition): () => void {
  if (!def || typeof def !== "object") throw new Error("a review check needs { id, title, run }");
  if (typeof def.id !== "string" || !CHECK_ID.test(def.id)) {
    throw new Error(`review check id must be lowercase letters, digits, ".", "_" or "-": ${JSON.stringify(def.id)}`);
  }
  if (typeof def.title !== "string" || def.title.trim() === "") throw new Error(`review check "${def.id}" needs a title`);
  if (typeof def.run !== "function") throw new Error(`review check "${def.id}" needs a run() function`);
  if (def.description !== undefined && typeof def.description !== "string") {
    throw new Error(`review check "${def.id}": description must be text`);
  }
  const key = `${ownerId(owner)}/${def.id}`;
  if (entries.some((e) => e.check.key === key)) throw new Error(`review check "${key}" is already registered`);
  const check: ReviewCheck = Object.freeze({
    key,
    owner,
    id: def.id,
    title: def.title.trim().slice(0, MAX_TITLE),
    description: (def.description ?? "").trim().slice(0, MAX_DESCRIPTION),
  });
  const entry: Entry = { check, run: def.run };
  publish([...entries, entry]);
  return () => {
    if (entries.includes(entry)) publish(entries.filter((e) => e !== entry));
  };
}

/** Registered checks, in registration order. Frozen, stable between changes. */
export function listReviewChecks(): readonly ReviewCheck[] {
  return listed;
}

export function subscribeReviewChecks(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useReviewChecks(): readonly ReviewCheck[] {
  return useSyncExternalStore(subscribeReviewChecks, listReviewChecks, listReviewChecks);
}

// ─── Unified diff ────────────────────────────────────────────────────

function unquotePath(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\])/g, "$1").replace(/\\t/g, "\t").replace(/\\n/g, "\n");
  }
  // `diff -u` puts a timestamp after a tab.
  const tab = t.indexOf("\t");
  return tab === -1 ? t : t.slice(0, tab);
}

function stripPrefix(path: string): string {
  return /^[ab]\//.test(path) ? path.slice(2) : path;
}

interface Draft {
  path: string;
  oldPath: string | null;
  status: ReviewFileStatus;
  binary: boolean;
  added: ReviewLine[];
  removed: number;
}

/**
 * Parse a unified diff (git's format, or plain ---/+++ hunks) into files.
 * Never throws; lines it does not understand are skipped.
 */
export function parseUnifiedDiff(patch: string): ReviewFile[] {
  const files: Draft[] = [];
  let file: Draft | null = null;
  let newLine = 0;
  // Lines of the current hunk still to come, per side. The hunk ends when
  // both reach 0, so a "--- " line after it is a header again.
  let oldLeft = 0;
  let newLeft = 0;
  const start = (path: string): Draft => {
    const d: Draft = { path, oldPath: null, status: "modified", binary: false, added: [], removed: 0 };
    files.push(d);
    oldLeft = 0;
    newLeft = 0;
    return d;
  };
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (file && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("+") && newLeft > 0) {
        file.added.push({ line: newLine, text: line.slice(1) });
        newLine++;
        newLeft--;
        continue;
      }
      if (line.startsWith("-") && oldLeft > 0) {
        file.removed++;
        oldLeft--;
        continue;
      }
      if ((line.startsWith(" ") || line === "") && oldLeft > 0 && newLeft > 0) {
        newLine++;
        oldLeft--;
        newLeft--;
        continue;
      }
      // Anything else ends the hunk early (a truncated patch).
      if (!line.startsWith("\\")) {
        oldLeft = 0;
        newLeft = 0;
      }
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const header = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(line);
    if (header) {
      file = start(unquotePath(header[2]));
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (!file) file = start("");
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLine = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      continue;
    }
    if (line.startsWith("--- ")) {
      const from = unquotePath(line.slice(4));
      if (!file || file.added.length > 0 || file.removed > 0) file = start(stripPrefix(from));
      if (from === "/dev/null") file.status = "added";
      continue;
    }
    if (line.startsWith("+++ ") && file) {
      const to = unquotePath(line.slice(4));
      if (to === "/dev/null") file.status = "deleted";
      else file.path = stripPrefix(to);
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.oldPath = unquotePath(line.slice("rename from ".length));
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) file.path = unquotePath(line.slice("rename to ".length));
    else if (/^Binary files .* differ$/.test(line) || line === "GIT binary patch") file.binary = true;
  }
  return files
    .filter((f) => f.path !== "")
    .map((f) =>
      Object.freeze({
        path: f.path,
        oldPath: f.oldPath,
        status: f.status,
        binary: f.binary,
        added: Object.freeze(f.added.map((l) => Object.freeze(l))),
        removed: f.removed,
      }),
    );
}

/** The input for a diff, frozen so no check can change what another sees. */
export function reviewInputFromPatch(sessionId: string, turn: number | null, patch: string): ReviewCheckInput {
  return Object.freeze({ sessionId, turn, patch, files: Object.freeze(parseUnifiedDiff(patch)) });
}

// ─── Running ─────────────────────────────────────────────────────────

function isOutcome(v: unknown): v is ReviewCheckOutcome {
  return typeof v === "string" && (REVIEW_CHECK_OUTCOMES as readonly string[]).includes(v);
}

/** Validate and bound what a check answered. Null when it is not a result. */
export function normalizeReviewCheckResult(value: unknown): ReviewCheckResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isOutcome(v.outcome)) return null;
  const summary = v.summary === undefined ? "" : v.summary;
  if (typeof summary !== "string") return null;
  const rawFindings = v.findings === undefined ? [] : v.findings;
  if (!Array.isArray(rawFindings)) return null;
  const findings: ReviewFinding[] = [];
  for (const f of rawFindings.slice(0, MAX_REVIEW_FINDINGS)) {
    if (!f || typeof f !== "object") return null;
    const r = f as Record<string, unknown>;
    if (typeof r.file !== "string" || typeof r.message !== "string") return null;
    const line = r.line === undefined || r.line === null ? null : r.line;
    if (line !== null && !(typeof line === "number" && Number.isInteger(line) && line >= 1)) return null;
    findings.push(Object.freeze({ file: r.file, line, message: r.message.slice(0, MAX_MESSAGE) }));
  }
  return Object.freeze({ outcome: v.outcome, summary: summary.slice(0, MAX_SUMMARY), findings: Object.freeze(findings) });
}

async function runOne(entry: Entry, input: ReviewCheckInput, timeoutMs: number, now: () => number): Promise<ReviewCheckRun> {
  const { key, owner, title } = entry.check;
  const started = now();
  const done = (outcome: ReviewCheckRun["outcome"], summary: string, findings: readonly ReviewFinding[] = []): ReviewCheckRun =>
    Object.freeze({ key, owner, title, outcome, summary, findings, durationMs: Math.max(0, now() - started) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const answer = await Promise.race([Promise.resolve().then(() => entry.run(input)), timedOut]);
    if (answer === "timeout") return done("timeout", `No answer within ${Math.round(timeoutMs / 1000)} s`);
    const result = normalizeReviewCheckResult(answer);
    if (!result) return done("error", "The check gave an answer Hermes cannot read");
    return done(result.outcome, result.summary, result.findings);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return done("error", message.slice(0, MAX_SUMMARY));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every registered check (or those whose key is in `only`) over the
 * input, all at once. Answers come back in registration order.
 */
export function runReviewChecks(
  input: ReviewCheckInput,
  options: { timeoutMs?: number; only?: readonly string[]; now?: () => number } = {},
): Promise<ReviewCheckRun[]> {
  const timeoutMs = options.timeoutMs ?? REVIEW_CHECK_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const chosen = options.only ? entries.filter((e) => options.only!.includes(e.check.key)) : entries;
  return Promise.all(chosen.map((e) => runOne(e, input, timeoutMs, now)));
}

export function _resetReviewChecksForTest(): void {
  publish([]);
  listeners.clear();
}
