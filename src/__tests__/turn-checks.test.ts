/**
 * F20 x F27 — Turn.checks: a recorded turn carries the Done-When result of
 * the agent turn that ended when it did (docs/adr/004-2.0-contracts.md).
 * The ledger numbers only the turns it recorded; the Done-When store keeps
 * results under the agent's own turn number; the end time ties them.
 */
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../agent/contract/events";
import type { Turn } from "../agent/contract/turns";
import type { CheckRecord } from "../doneWhen/types";
import { agentTurnEndedAt, turnChecksOf, withTurnChecks } from "../agent/turns/turnChecks";

const turn = (n: number, endedAt: number | null): Turn => ({
  sessionId: "s1",
  n,
  ref: `refs/hermes/s1/turn/${n}`,
  startedAt: (endedAt ?? 0) - 100,
  endedAt,
  diffstat: { files: 1, insertions: 1, deletions: 0 },
});

const record = (agentTurn: number, state: CheckRecord["run"]["state"], commands: [string, number | null, boolean?][] = []): CheckRecord => ({
  session_id: "s1",
  turn: agentTurn,
  run: {
    state,
    trigger: "turn_end",
    source: { kind: "worktree_toml", path: ".hermes/worktree.toml" },
    error: state === "error" ? "bad toml" : null,
    commands: commands.map(([command, exit_code, timed_out = false]) => ({ command, exit_code, timed_out, duration_ms: 5, output_tail: "" })),
    started_at: 1,
    duration_ms: 5,
    attempt: null,
    max_attempts: null,
    blocking: false,
    final: true,
    gave_up: false,
  },
  check_failed: state === "failed",
  failed_turns: state === "failed" ? 1 : 0,
  hook: false,
});

// The agent's turns 1..4 end at 100, 200, 300, 400; turn 2 changed nothing,
// so the ledger recorded T1 (agent 1), T2 (agent 3), T3 (agent 4).
const events: SessionEvent[] = [
  { type: "turn_start", at: 50, source: "hook:x", n: 1 },
  { type: "turn_end", at: 100, source: "hook:x", n: 1 },
  { type: "turn_end", at: 200, source: "hook:x", n: 2 },
  { type: "turn_failed", at: 300, source: "hook:x", n: 3, detail: "tool error" },
  { type: "status", at: 350, source: "pty", status: { kind: "idle", confidence: "guessed", detail: "" } },
  { type: "turn_interrupted", at: 400, source: "hook:x", n: 4 },
];
const ledger = [turn(1, 100), turn(2, 300), turn(3, 400)];

describe("Turn.checks from the Done-When results", () => {
  it("maps each recorded turn to the agent turn that ended at the same moment", () => {
    expect(agentTurnEndedAt(events, 100)).toBe(1);
    expect(agentTurnEndedAt(events, 300)).toBe(3);
    expect(agentTurnEndedAt(events, 400)).toBe(4);
    expect(agentTurnEndedAt(events, 350)).toBeNull(); // a status, not a turn end
    expect(agentTurnEndedAt(events, 999)).toBeNull();
  });

  it("fills checks by the agent's turn number, not the ledger's", () => {
    const results: Record<number, CheckRecord> = {
      1: record(1, "passed", [["npm test", 0]]),
      2: record(2, "failed", [["npm test", 1]]), // the no-change turn: no ledger turn to carry it
      3: record(3, "failed", [["npm test", 0], ["npm run lint", 2], ["slow", null, true]]),
    };
    const shown = withTurnChecks(ledger, events, (n) => results[n] ?? null);
    expect(shown.map((t) => [t.n, t.checks])).toEqual([
      [1, { state: "passed", failed: [] }],
      [2, { state: "failed", failed: ["npm run lint", "slow"] }],
      [3, undefined],
    ]);
  });

  it("leaves a turn untouched (same object) when nothing was checked, the turn runs, or its end is not in the store", () => {
    const running = turn(4, null);
    const out = withTurnChecks([...ledger, running, turn(5, 12345)], events, () => null);
    expect(out[0]).toBe(ledger[0]);
    expect(out[3]).toBe(running);
    expect(out[4].checks).toBeUndefined();
  });

  it("keeps a turn's object when its checks did not change", () => {
    const withChecks = { ...ledger[0], checks: { state: "passed" as const, failed: [] } };
    const out = withTurnChecks([withChecks], events, () => record(1, "passed"));
    expect(out[0]).toBe(withChecks);
  });

  it("turnChecksOf: passed, failed (the failing commands in order), error; 'none' is no result", () => {
    expect(turnChecksOf(null)).toBeUndefined();
    expect(turnChecksOf(record(1, "none"))).toBeUndefined();
    expect(turnChecksOf(record(1, "passed", [["a", 0]]))).toEqual({ state: "passed", failed: [] });
    expect(turnChecksOf(record(1, "error"))).toEqual({ state: "error", failed: [] });
    expect(turnChecksOf(record(1, "failed", [["a", 0], ["b", 1], ["c", 0, true]]))).toEqual({ state: "failed", failed: ["b", "c"] });
  });
});
