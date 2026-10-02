// ─── Where the Review Desk gets its turns ─────────────────────────────
//
// The turn ledger (F20) fills `list_turns` / `get_turn_diff`; until it
// lands they answer with nothing. A test build can inject turns for a
// session (window.__HERMES_E2E__.injectTurns), which a real-app scenario
// uses to drive the desk with two fake agents. Injected turns win over the
// backend for that session, so the fake never hides a real ledger by
// accident: a session with no injected turns always asks the backend.

import { getTurnDiff, listTurns, type Turn, type TurnDiff } from "../agent/contract/turns";
import { turnLedgerBetween, type BetweenTurns } from "../agent/turns/turnLedgerApi";

export interface InjectedTurn {
  readonly turn: Turn;
  readonly patch: string;
}

const injected = new Map<string, InjectedTurn[]>();

/** Test builds only (see src/e2e/hooks.ts): fake a session's ledger. */
export function injectFakeTurns(sessionId: string, turns: readonly InjectedTurn[]): void {
  injected.set(
    sessionId,
    [...turns].sort((a, b) => a.turn.n - b.turn.n),
  );
}

export function clearFakeTurns(sessionId?: string): void {
  if (sessionId === undefined) injected.clear();
  else injected.delete(sessionId);
}

export async function listTurnsFor(sessionId: string): Promise<Turn[]> {
  const fake = injected.get(sessionId);
  if (fake) return fake.map((t) => t.turn);
  try {
    return await listTurns(sessionId);
  } catch {
    return [];
  }
}

export async function getTurnDiffFor(sessionId: string, n: number): Promise<TurnDiff | null> {
  const fake = injected.get(sessionId);
  if (fake) {
    const hit = fake.find((t) => t.turn.n === n);
    return hit ? { turn: hit.turn, patch: hit.patch } : null;
  }
  try {
    return await getTurnDiff(sessionId, n);
  } catch {
    return null;
  }
}

/** What changed before turn `n` that no turn made (the person's edits), or null. */
export async function getBetweenFor(sessionId: string, n: number): Promise<BetweenTurns | null> {
  if (injected.has(sessionId) || n < 2) return null;
  try {
    return await turnLedgerBetween(sessionId, n);
  } catch {
    return null;
  }
}
