// ─── Done-When (F27): what a check run looks like off the wire ────────
//
// The `hi` helper runs a repository's `done_when` commands and prints a
// report; the backend (src-tauri/src/done_when.rs) wraps it in a record per
// session and emits it on DONE_WHEN_EVENT. Field names are the wire format
// (snake_case, like the rest of the session data).

export const DONE_WHEN_EVENT = "hermes:done-when";

export type CheckState = "passed" | "failed" | "error" | "none";
export type CheckTrigger = "stop_hook" | "turn_end" | "manual" | "land" | "cli";

export interface CheckCommand {
  readonly command: string;
  /** Null: it did not exit on its own (timed out, never started). */
  readonly exit_code: number | null;
  readonly timed_out: boolean;
  readonly duration_ms: number;
  /** The last few KB of its output. */
  readonly output_tail: string;
}

export interface CheckRun {
  readonly state: CheckState;
  readonly trigger: CheckTrigger | string;
  readonly source: { readonly kind: string; readonly path: string } | null;
  /** Why a done_when file could not be read (state "error"). */
  readonly error: string | null;
  readonly commands: readonly CheckCommand[];
  readonly started_at: number;
  readonly duration_ms: number;
  /** Stop hook only: which automatic continuation this was, of how many. */
  readonly attempt: number | null;
  readonly max_attempts: number | null;
  /** Stop hook only: the agent was sent back to work with the failures. */
  readonly blocking: boolean;
  /** False while the Stop hook will still send the agent back. */
  readonly final: boolean;
  /** Stop hook only: attempts or time budget used up, checks still failing. */
  readonly gave_up: boolean;
}

export interface CheckRecord {
  readonly session_id: string;
  /** The turn the result belongs to, when known. */
  readonly turn: number | null;
  readonly run: CheckRun;
  /** The session is `check_failed` after this run. */
  readonly check_failed: boolean;
  /** Turn ends in a row whose checks failed. */
  readonly failed_turns: number;
  /** The agent's stop runs the checks itself (Claude's Stop hook). */
  readonly hook: boolean;
}

export interface RunOutcome {
  /** "hook", "running" or "ssh" when nothing ran. */
  readonly skipped: string | null;
  readonly record: CheckRecord | null;
}

const STATES: readonly string[] = ["passed", "failed", "error", "none"];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function parseCommand(value: unknown): CheckCommand | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.command !== "string") return null;
  return {
    command: v.command,
    exit_code: num(v.exit_code),
    timed_out: v.timed_out === true,
    duration_ms: num(v.duration_ms) ?? 0,
    output_tail: str(v.output_tail) ?? "",
  };
}

/** Validating parser for a run; null when it is not one. */
export function parseCheckRun(value: unknown): CheckRun | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.state !== "string" || !STATES.includes(v.state)) return null;
  if (typeof v.trigger !== "string") return null;
  const src = v.source as Record<string, unknown> | null | undefined;
  const source =
    src && typeof src === "object" && typeof src.kind === "string" && typeof src.path === "string"
      ? { kind: src.kind, path: src.path }
      : null;
  const commands = Array.isArray(v.commands) ? v.commands.map(parseCommand) : [];
  if (commands.some((c) => c === null)) return null;
  return {
    state: v.state as CheckState,
    trigger: v.trigger,
    source,
    error: str(v.error),
    commands: commands as CheckCommand[],
    started_at: num(v.started_at) ?? 0,
    duration_ms: num(v.duration_ms) ?? 0,
    attempt: num(v.attempt),
    max_attempts: num(v.max_attempts),
    blocking: v.blocking === true,
    final: v.final !== false,
    gave_up: v.gave_up === true,
  };
}

/** Validating parser for a record off DONE_WHEN_EVENT; null when malformed. */
export function parseCheckRecord(value: unknown): CheckRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.session_id !== "string" || v.session_id === "") return null;
  const run = parseCheckRun(v.run);
  if (!run) return null;
  const turn = num(v.turn);
  return {
    session_id: v.session_id,
    turn: turn !== null && Number.isInteger(turn) && turn >= 1 ? turn : null,
    run,
    check_failed: v.check_failed === true,
    failed_turns: num(v.failed_turns) ?? 0,
    hook: v.hook === true,
  };
}

export function isPassed(c: CheckCommand): boolean {
  return c.exit_code === 0 && !c.timed_out;
}

export function failedCommands(run: CheckRun): CheckCommand[] {
  return run.commands.filter((c) => !isPassed(c));
}
