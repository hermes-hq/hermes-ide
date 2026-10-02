// ─── Turn ledger commands (F20) ───────────────────────────────────────
//
// The backend commands behind the turn bar, on top of the C0 seam in
// ../contract/turns.ts (listTurns, getTurnDiff). Everything here is behind
// the `turnLedger` feature flag: the bar is not rendered without it and the
// backend snapshots nothing until setTurnLedgerEnabled(true) is called.

import { invoke } from "@tauri-apps/api/core";
import type { Diffstat, Turn } from "../contract/turns";

/** The Tauri event the backend emits when a turn lands or a restore is done. */
export const TURN_LEDGER_EVENT = "hermes:turn-ledger";

export interface TurnLedgerEvent {
  readonly sessionId: string;
  /** The turn just recorded, when one was. */
  readonly turn?: Turn;
  /** The turn the worktree was just restored to, when one was. */
  readonly restoredTo?: number;
}

export interface RestorePreview {
  readonly turn: Turn;
  /** What restoring would change: the worktree now against the turn's tree. */
  readonly patch: string;
  readonly diffstat: Diffstat;
  /** Files with edits no turn made: a restore sets them aside (Undo brings them back). */
  readonly setAside?: readonly string[];
}

export interface RestoreResult {
  readonly n: number;
  /** Paths written or removed. */
  readonly files: number;
  /** The number of the set-aside state Undo goes back to. */
  readonly setAside?: number;
}

/** What changed before turn `before` that no turn made (the person's edits). */
export interface BetweenTurns {
  readonly before: number;
  readonly patch: string;
  readonly diffstat: Diffstat;
  /** When the previous turn ended (epoch ms). */
  readonly at: number;
}

/** Tell the backend whether the flag is on (read once at startup). */
export function setTurnLedgerEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_turn_ledger_enabled", { enabled });
}

/** An agent's turn began; `exact` when the agent itself said so. */
export function reportTurnStarted(sessionId: string, at: number, exact: boolean): Promise<void> {
  return invoke<void>("turn_ledger_turn_started", { sessionId, at, exact });
}

/** An agent's turn ended: the backend snapshots the worktree. */
export function reportTurnEnded(sessionId: string, at: number, exact: boolean): Promise<void> {
  return invoke<void>("turn_ledger_turn_ended", { sessionId, at, exact });
}

/** What restoring to turn `n` would change; null when there is no such turn. */
export function previewRestoreTurn(sessionId: string, n: number): Promise<RestorePreview | null> {
  return invoke<RestorePreview | null>("preview_restore_turn", { sessionId, n });
}

/** Undo restore `k`: the worktree goes back to what it set aside. */
export function undoRestoreTurn(sessionId: string, k: number): Promise<RestoreResult> {
  return invoke<RestoreResult>("undo_restore_turn", { sessionId, k });
}

/** The changes no turn made before turn `n`, or null. */
export function turnLedgerBetween(sessionId: string, n: number): Promise<BetweenTurns | null> {
  return invoke<BetweenTurns | null>("turn_ledger_between", { sessionId, n });
}

/** Make the worktree exactly the tree of turn `n`. */
export function restoreTurn(sessionId: string, n: number): Promise<RestoreResult | null> {
  return invoke<RestoreResult | null>("restore_turn", { sessionId, n });
}
