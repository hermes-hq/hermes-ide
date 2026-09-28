// ─── Feature Tracks: the pure rules ───────────────────────────────────
//
// F28. Everything here is a function of its arguments, table-tested in
// src/__tests__/track-rules.test.ts: which session writes a worktree, whether
// a file change fell inside an agent's turn (the turn history, contract C0),
// what questions.md says, and the editor command for a shell.

import type { SessionEvent } from "../agent/contract/events";
import type { SessionTurnState } from "../agent/contract/sessionEventStore";
import { FEATURE_PHASES, type FeaturePhase, type FeatureTrack } from "../agent/contract/featureFrontMatter";

/** The phases each track runs (mirrors hermes-track's `track_phases`). */
export const TRACK_PHASES: Readonly<Record<FeatureTrack, readonly FeaturePhase[]>> = Object.freeze({
  Quick: Object.freeze([]),
  Light: Object.freeze(["questions", "plan", "implement"] as FeaturePhase[]),
  Full: Object.freeze(["questions", "research", "design", "structure", "plan", "implement"] as FeaturePhase[]),
});

export const PHASE_FILE: Readonly<Partial<Record<FeaturePhase, string>>> = Object.freeze({
  questions: "questions.md",
  research: "research.md",
  design: "design.md",
  structure: "structure.md",
  plan: "plan.md",
});

export const PHASE_LINE_CAP: Readonly<Partial<Record<FeaturePhase, number>>> = Object.freeze({
  questions: 40,
  research: 80,
  design: 80,
  structure: 60,
  plan: 120,
});

/** The phase before `phase` on the track (what an approval advanced from). */
export function previousPhase(track: FeatureTrack, phase: FeaturePhase): FeaturePhase | null {
  const order = TRACK_PHASES[track];
  const idx = FEATURE_PHASES.indexOf(phase);
  for (let i = order.length - 1; i >= 0; i--) {
    if (FEATURE_PHASES.indexOf(order[i]) < idx) return order[i];
  }
  return null;
}

// ─── questions.md ─────────────────────────────────────────────────────

export interface Question {
  readonly line: number;
  readonly text: string;
  readonly open: boolean;
  /** Starts with `!`: nothing goes on until a person answers it. */
  readonly blocking: boolean;
}

/** Mirrors hermes-track's questions.rs. */
export function parseQuestions(text: string): Question[] {
  const out: Question[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-\s\[( |x|X)\]\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let body = m[2].trim();
    let blocking = false;
    if (body.startsWith("!")) {
      blocking = true;
      body = body.slice(1).trim();
    }
    if (body === "" || body.startsWith("(")) continue;
    out.push({ line: i + 1, text: body, open: m[1] === " ", blocking });
  }
  return out;
}

// ─── Who writes a worktree ────────────────────────────────────────────

export interface AttachedSession {
  readonly id: string;
  readonly working_directory: string;
  readonly created_at: string;
  readonly ssh_info?: unknown;
}

/** Same folder whatever the trailing slash or the letter case on Windows. */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, "/");
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return /^[A-Za-z]:\//.test(out) ? out.toLowerCase() : out;
}

/** Whether a session has run at least one agent turn (the turn history). */
export type HasTurnHistory = (sessionId: string) => boolean;

const NO_HISTORY: HasTurnHistory = () => false;

/**
 * The sessions attached to a worktree: the first one is the writer (the
 * agent that drives the feature; `r` types into its terminal), the rest are
 * readers. A session with a turn history is an agent for sure, so it comes
 * before one without, whatever their ages: a plain shell opened in the
 * worktree before the agent never becomes the writer by seniority. Among
 * equals the oldest wins.
 */
export function attachedSessions<S extends AttachedSession>(sessions: readonly S[], worktreePath: string, hasTurnHistory: HasTurnHistory = NO_HISTORY): S[] {
  const target = normalizePath(worktreePath);
  const rank = (s: S) => (hasTurnHistory(s.id) ? 0 : 1);
  return sessions
    .filter((s) => !s.ssh_info && normalizePath(s.working_directory) === target)
    .sort((a, b) => rank(a) - rank(b) || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
}

export function writerSessionId(sessions: readonly AttachedSession[], worktreePath: string, hasTurnHistory: HasTurnHistory = NO_HISTORY): string | null {
  return attachedSessions(sessions, worktreePath, hasTurnHistory)[0]?.id ?? null;
}

// ─── The turn history ─────────────────────────────────────────────────

/** File times are coarser than event times on some file systems. */
export const TURN_SLACK_MS = 2000;

/**
 * Whether a file modified at `modifiedAt` (epoch ms) was written during a
 * turn of the session whose events these are: a turn is running now, or the
 * time falls between the last turn_start and the turn end that followed it.
 */
export function changeMadeDuringTurn(events: readonly SessionEvent[], turn: SessionTurnState, modifiedAt: number): boolean {
  if (turn.current !== null) return true;
  let lastStart: number | null = null;
  let lastEnd: number | null = null;
  for (const e of events) {
    if (e.type === "turn_start") lastStart = e.at;
    else if (e.type === "turn_end" || e.type === "turn_failed" || e.type === "turn_interrupted") lastEnd = e.at;
  }
  if (lastStart === null) return false;
  if (modifiedAt < lastStart - TURN_SLACK_MS) return false;
  if (lastEnd === null || lastEnd < lastStart) return true;
  return modifiedAt <= lastEnd + TURN_SLACK_MS;
}

// ─── Editors ──────────────────────────────────────────────────────────

/** The command a shell runs to open `path` in the person's editor. */
export function editorCommandFor(shell: string, path: string): string {
  const name = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (/^(pwsh|powershell)(\.exe)?$/.test(name)) {
    const quoted = `'${path.replace(/'/g, "''")}'`;
    // $EDITOR is a program path ("C:\Program Files\...\code.cmd", spaces
    // and all) or a command line ("code --wait", '"C:\...\code.cmd" --wait'):
    // a path that exists runs through the call operator as one word; anything
    // else is re-parsed as a command line. Inside the re-parsed string the
    // path is escaped for PowerShell's own expansion.
    const inner = quoted.replace(/[`$]/g, (c) => `\`${c}`);
    return `$e = $env:EDITOR; if (-not $e) { notepad ${quoted} } elseif (Test-Path -LiteralPath $e) { & $e ${quoted} } else { Invoke-Expression "& $e ${inner}" }`;
  }
  if (/^cmd(\.exe)?$/.test(name)) {
    const quoted = `"${path.replace(/"/g, "")}"`;
    return `if defined EDITOR (%EDITOR% ${quoted}) else (notepad ${quoted})`;
  }
  const quoted = `'${path.replace(/'/g, "'\\''")}'`;
  if (name === "fish") {
    return `set -q EDITOR; and eval $EDITOR ${quoted}; or vi ${quoted}`;
  }
  // zsh does not word-split $EDITOR ("code --wait" would be one word), so
  // the line is re-parsed with eval; the path is escaped for the outer
  // double quotes as well.
  const inner = quoted.replace(/[\\"$`]/g, (c) => `\\${c}`);
  return `eval "\${EDITOR:-vi} ${inner}"`;
}
