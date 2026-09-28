// ─── Turn ledger seam ────────────────────────────────────────────────
//
// Contract C0 (docs/adr/004-2.0-contracts.md). F20 fills it: at the end of
// every agent turn Hermes snapshots the worktree into a hidden git ref,
// `refs/hermes/<session>/turn/<n>`, and records the turn in the
// `agent_turns` table (schema step 3). A session without turns still
// answers with nothing (`listTurns` -> [], `getTurnDiff` -> null). The
// ledger's own commands (restore, preview) live in src/agent/turns/.
//
// The Rust mirror is src-tauri/src/contract/turns.rs.

import { invoke } from "@tauri-apps/api/core";

export interface Diffstat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface Turn {
  readonly sessionId: string;
  /** 1-based turn number within the session. */
  readonly n: number;
  /** The hidden git reference holding the snapshot, see turnRef(). */
  readonly ref: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /** Epoch milliseconds, null while the turn is running. */
  readonly endedAt: number | null;
  readonly diffstat: Diffstat;
  /**
   * F20 (additive): the snapshot ran past its budget, so this turn has a
   * diffstat summary but no snapshot (`ref` is empty) and cannot be diffed
   * or restored. Absent on a full snapshot.
   */
  readonly degraded?: boolean;
}

export interface TurnDiff {
  readonly turn: Turn;
  /** Unified diff of what the turn changed; empty for a no-change turn. */
  readonly patch: string;
}

export const TURN_REF_PREFIX = "refs/hermes/";

/** A session id must be safe inside a git ref name. */
export function isTurnRefSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId);
}

/** `refs/hermes/<session>/turn/<n>`; throws on an id git would refuse. */
export function turnRef(sessionId: string, n: number): string {
  if (!isTurnRefSessionId(sessionId)) throw new Error(`session id is not a valid ref component: ${JSON.stringify(sessionId)}`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`turn number must be a whole number from 1: ${String(n)}`);
  return `${TURN_REF_PREFIX}${sessionId}/turn/${n}`;
}

/** The inverse of turnRef(); null for any other ref. */
export function parseTurnRef(ref: string): { sessionId: string; n: number } | null {
  const m = /^refs\/hermes\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/turn\/([1-9][0-9]*)$/.exec(ref);
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isSafeInteger(n) ? { sessionId: m[1], n } : null;
}

export function listTurns(sessionId: string): Promise<Turn[]> {
  return invoke<Turn[]>("list_turns", { sessionId });
}

export function getTurnDiff(sessionId: string, n: number): Promise<TurnDiff | null> {
  return invoke<TurnDiff | null>("get_turn_diff", { sessionId, n });
}
