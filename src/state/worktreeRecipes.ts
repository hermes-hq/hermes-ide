// ─── Worktree recipes (F26, issue #108) ──────────────────────────────
//
// A repository's `.hermes/worktree.toml` prepares every new worktree before
// any agent starts in it: copy the git-ignored files it names (`.env*`),
// give it free ports, run its setup commands. The backend does the work
// (src-tauri/src/git/recipe.rs); this module decides when, keeps the
// visible log, asks the user before a file's commands run for the first
// time (and whenever the file changes), and raises an inbox error when
// setup fails.
//
// Nothing here is written to disk: the log lives in memory for this run of
// the app only, and values from copied files are masked by the backend
// before a line ever reaches it.
//
// No worktree.toml: nothing happens, no panel, no prompt.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parseWorktreeToml } from "../agent/contract/worktreeToml";
import { raiseInboxItem, type InboxRaise } from "../agent/contract/inbox";
import { translate } from "../i18n/registry";

// ─── The store behind the panel ──────────────────────────────────────

export type RecipeRunState = "awaiting" | "running" | "succeeded" | "failed" | "stopped" | "skipped" | "invalid";

export interface RecipeLogLine {
  /** "command" (the line being run), "stdout", "stderr" or "hermes". */
  readonly stream: string;
  readonly text: string;
}

export interface RecipeRun {
  readonly runId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly branch: string;
  readonly state: RecipeRunState;
  readonly setup: readonly string[];
  readonly copy: readonly string[];
  readonly doneWhen: readonly string[];
  /** Ports the backend handed out, by name. */
  readonly ports: Readonly<Record<string, number>>;
  readonly lines: readonly RecipeLogLine[];
  /** Lines dropped from the front once the log passed MAX_LOG_LINES. */
  readonly dropped: number;
  /** Why it failed or could not start, one line. */
  readonly failure: string | null;
}

/** Lines a run keeps in memory (oldest dropped first). */
export const MAX_LOG_LINES = 2000;

type Listener = () => void;
type Decision = "run" | "skip";

let runs: readonly RecipeRun[] = Object.freeze([]);
const listeners = new Set<Listener>();
const decisions = new Map<string, (d: Decision) => void>();
/** Default checks (`done_when`) per session, for Done-When (F27). */
const doneWhenBySession = new Map<string, readonly string[]>();

function publish(next: readonly RecipeRun[]): void {
  runs = Object.freeze(next);
  for (const l of [...listeners]) l();
}

function update(runId: string, patch: (run: RecipeRun) => Partial<RecipeRun>): void {
  const i = runs.findIndex((r) => r.runId === runId);
  if (i < 0) return;
  const next = [...runs];
  next[i] = Object.freeze({ ...runs[i], ...patch(runs[i]) });
  publish(next);
}

function addRun(run: Omit<RecipeRun, "lines" | "dropped" | "failure" | "ports">): void {
  publish([...runs, Object.freeze({ ...run, lines: Object.freeze([]), dropped: 0, failure: null, ports: {} })]);
}

export function appendRecipeLine(runId: string, line: RecipeLogLine): void {
  update(runId, (run) => {
    const lines = [...run.lines, Object.freeze({ stream: line.stream, text: line.text })];
    const over = Math.max(0, lines.length - MAX_LOG_LINES);
    return { lines: Object.freeze(lines.slice(over)), dropped: run.dropped + over };
  });
}

/** The user's answer to "run this file's setup?". */
export function decideRecipe(runId: string, decision: Decision): void {
  const resolve = decisions.get(runId);
  decisions.delete(runId);
  resolve?.(decision);
}

/** Take a finished run off the panel. Running ones stay. */
export function dismissRecipeRun(runId: string): void {
  const run = runs.find((r) => r.runId === runId);
  if (!run || run.state === "running" || run.state === "awaiting") return;
  publish(runs.filter((r) => r.runId !== runId));
}

export function listRecipeRuns(): readonly RecipeRun[] {
  return runs;
}

function subscribeRecipeRuns(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRecipeRuns(): readonly RecipeRun[] {
  return useSyncExternalStore(subscribeRecipeRuns, listRecipeRuns, listRecipeRuns);
}

/** The `done_when` checks a session's worktree recipe declares, if any. */
export function defaultDoneWhen(sessionId: string): readonly string[] {
  return doneWhenBySession.get(sessionId) ?? [];
}

export function _resetWorktreeRecipesForTest(): void {
  runs = Object.freeze([]);
  listeners.clear();
  decisions.clear();
  doneWhenBySession.clear();
  logListener = null;
}

// ─── Talking to the backend ──────────────────────────────────────────

export interface RecipeFileInfo {
  origin: "worktree" | "project";
  text: string;
  /** Git blob id of the file; the user's "Run setup" is tied to it. */
  hash: string;
  trusted: boolean;
  projectName: string;
}

export interface RecipeOutcome {
  ok: boolean;
  stopped: boolean;
  failure: string | null;
  copied: string[];
  ports: Record<string, number>;
}

export interface RecipeRunRequest {
  runId: string;
  sessionId: string;
  projectId: string;
  hash: string;
  approve: boolean;
  copy: readonly string[];
  setup: readonly string[];
  ports: Readonly<Record<string, number>>;
}

export interface RecipeDeps {
  read(sessionId: string, projectId: string): Promise<RecipeFileInfo | null>;
  run(req: RecipeRunRequest): Promise<RecipeOutcome>;
  raise(item: InboxRaise): void;
  /** Start receiving log lines (idempotent). */
  listenForLog(): Promise<void>;
}

let logListener: Promise<void> | null = null;

const tauriDeps: RecipeDeps = {
  read: (sessionId, projectId) => invoke<RecipeFileInfo | null>("worktree_recipe_read", { sessionId, projectId }),
  run: (req) => invoke<RecipeOutcome>("worktree_recipe_run", { ...req }),
  raise: (item) => {
    raiseInboxItem(item);
  },
  listenForLog: () => {
    logListener ??= listen<{ runId: string; stream: string; text: string }>("hermes:worktree-recipe", (e) => {
      appendRecipeLine(e.payload.runId, { stream: e.payload.stream, text: e.payload.text });
    }).then(() => undefined);
    return logListener;
  },
};

export function stopRecipeRun(runId: string): Promise<boolean> {
  return invoke<boolean>("worktree_recipe_stop", { runId });
}

// ─── Running the recipes of a new session's worktrees ────────────────

export interface CreatedWorktree {
  projectId: string;
  branch: string;
  worktreePath: string;
}

let runCounter = 0;
const newRunId = () => `recipe-${Date.now().toString(36)}-${(++runCounter).toString(36)}`;

/**
 * Prepare each worktree a new session just created, one after the other,
 * and resolve once all are done (or skipped). Never throws: a recipe that
 * cannot run is shown in the panel and, when it failed, raised as an inbox
 * error; the session is created either way.
 */
export async function runWorktreeRecipes(
  sessionId: string,
  created: readonly CreatedWorktree[],
  deps: RecipeDeps = tauriDeps,
): Promise<void> {
  for (const wt of created) {
    try {
      await runOne(sessionId, wt, deps);
    } catch (e) {
      console.warn(`[worktree-recipe] ${wt.projectId}:`, e);
    }
  }
}

async function runOne(sessionId: string, wt: CreatedWorktree, deps: RecipeDeps): Promise<void> {
  const file = await deps.read(sessionId, wt.projectId);
  if (!file) return;
  const runId = newRunId();
  const base = {
    runId,
    sessionId,
    projectId: wt.projectId,
    projectName: file.projectName,
    branch: wt.branch,
  };

  const parsed = parseWorktreeToml(file.text);
  if (!parsed.ok) {
    const failure =
      parsed.line > 0
        ? translate("worktreeRecipe.invalidLine", { line: parsed.line, error: parsed.error })
        : translate("worktreeRecipe.invalid", { error: parsed.error });
    addRun({ ...base, state: "invalid", setup: [], copy: [], doneWhen: [] });
    update(runId, () => ({ failure }));
    deps.raise({ kind: "error", sessionId, detail: `${file.projectName}: ${failure}`, source: "worktree" });
    return;
  }
  const { setup, copy, doneWhen, ports } = parsed.config;
  if (doneWhen.length > 0) doneWhenBySession.set(sessionId, [...(doneWhenBySession.get(sessionId) ?? []), ...doneWhen]);
  // Only checks (or only ports, which nothing would use): nothing to run.
  if (setup.length === 0 && copy.length === 0) return;

  addRun({ ...base, state: file.trusted ? "running" : "awaiting", setup, copy, doneWhen });
  if (!file.trusted) {
    const decision = await new Promise<Decision>((resolve) => decisions.set(runId, resolve));
    if (decision === "skip") {
      update(runId, () => ({ state: "skipped" }));
      return;
    }
    update(runId, () => ({ state: "running" }));
  }

  await deps.listenForLog();
  let outcome: RecipeOutcome;
  try {
    outcome = await deps.run({
      runId,
      sessionId,
      projectId: wt.projectId,
      hash: file.hash,
      approve: !file.trusted,
      copy,
      setup,
      ports,
    });
  } catch (e) {
    outcome = { ok: false, stopped: false, failure: e instanceof Error ? e.message : String(e), copied: [], ports: {} };
  }
  const state: RecipeRunState = outcome.ok ? "succeeded" : outcome.stopped ? "stopped" : "failed";
  update(runId, () => ({ state, failure: outcome.failure, ports: outcome.ports ?? {} }));
  if (state === "failed") {
    deps.raise({
      kind: "error",
      sessionId,
      detail: translate("worktreeRecipe.inboxFailed", {
        project: file.projectName,
        reason: outcome.failure ?? translate("worktreeRecipe.state.failed"),
      }),
      source: "worktree",
    });
  }
}
