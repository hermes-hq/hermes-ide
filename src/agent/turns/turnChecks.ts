// ─── Turn.checks: the Done-When result of a recorded turn (F20 x F27) ──
//
// docs/adr/004-2.0-contracts.md: F20 fills `Turn.checks` from F27's
// Done-When store. The two count turns differently: the ledger numbers only
// the turns it recorded (a turn that changed nothing gets no number), the
// Done-When store keeps each result under the agent's own turn number (the
// `n` of its turn events). What ties them is the moment the turn ended: the
// ledger records a turn with the `at` of the turn_end / turn_failed /
// turn_interrupted event that ended it (turnLedgerBridge.ts), so that event,
// still in the session's event store, names the agent's turn number.

import type { SessionEvent } from "../contract/events";
import type { Turn, TurnChecks } from "../contract/turns";
import type { CheckRecord } from "../../doneWhen/types";

/** The Done-When record as the turn's `checks`; undefined when nothing was checked. */
export function turnChecksOf(record: CheckRecord | null): TurnChecks | undefined {
  if (!record) return undefined;
  const { state, commands } = record.run;
  if (state !== "passed" && state !== "failed" && state !== "error") return undefined;
  const failed = state === "failed" ? commands.filter((c) => c.timed_out || c.exit_code !== 0).map((c) => c.command) : [];
  return Object.freeze({ state, failed: Object.freeze(failed) });
}

/** The agent's number of the turn that ended at `at`, or null when no turn-ending event has that time. */
export function agentTurnEndedAt(events: readonly SessionEvent[], at: number): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if ((e.type === "turn_end" || e.type === "turn_failed" || e.type === "turn_interrupted") && e.at === at) return e.n;
  }
  return null;
}

/**
 * The turns with `checks` filled from the Done-When results (`checksFor`
 * gives the final result of an agent turn number). A turn keeps the same
 * object when its checks did not change.
 */
export function withTurnChecks(
  turns: readonly Turn[],
  events: readonly SessionEvent[],
  checksFor: (agentTurn: number) => CheckRecord | null,
): Turn[] {
  return turns.map((turn) => {
    if (turn.endedAt === null) return turn;
    const n = agentTurnEndedAt(events, turn.endedAt);
    const checks = n === null ? undefined : turnChecksOf(checksFor(n));
    if (!checks) return turn;
    const same = turn.checks && turn.checks.state === checks.state && turn.checks.failed.join("\n") === checks.failed.join("\n");
    return same ? turn : { ...turn, checks };
  });
}
