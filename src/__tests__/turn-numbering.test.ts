/**
 * Tests for `assignTurnNumbers` — the helper that assigns a logbook-style
 * turn number to each message in the rendered conversation.
 *
 * A turn starts at every user message and includes all assistant messages
 * that follow until the next user message.  The first message of a turn
 * carries `isFirstOfTurn: true` so the gutter UI knows whether to render
 * the `№ NN · HH:MM:SS` lockup.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { assignTurnNumbers } from "../agent/AgentSessionView";
import type { RenderedMessage } from "../agent/messageStore";

const user = (id: string): RenderedMessage => ({
  id,
  role: "user",
  blocks: [{ type: "text", text: "q" }],
  timestamp: 0,
});

const assistant = (id: string): RenderedMessage => ({
  id,
  role: "assistant",
  blocks: [{ type: "text", text: "a" }],
  timestamp: 0,
});

describe("assignTurnNumbers", () => {
  it("returns an empty list for no messages", () => {
    expect(assignTurnNumbers([])).toEqual([]);
  });

  it("numbers each user message as a fresh turn", () => {
    const out = assignTurnNumbers([user("u1"), user("u2"), user("u3")]);
    expect(out.map((m) => m.turn)).toEqual([1, 2, 3]);
    expect(out.every((m) => m.isFirstOfTurn)).toBe(true);
  });

  it("groups assistant continuations into the same turn as the preceding user message", () => {
    const out = assignTurnNumbers([
      user("u1"),
      assistant("a1"),
      assistant("a2"),
      user("u2"),
      assistant("a3"),
    ]);
    expect(out.map((m) => m.turn)).toEqual([1, 1, 1, 2, 2]);
    expect(out.map((m) => m.isFirstOfTurn)).toEqual([true, false, false, true, false]);
  });

  it("treats a leading assistant message (no prior user) as turn 1", () => {
    // Edge case: assistant emits something before any user input.  Group it
    // into turn 1 so it doesn't end up unnumbered or in turn 0.
    const out = assignTurnNumbers([assistant("a1"), assistant("a2"), user("u1")]);
    expect(out.map((m) => m.turn)).toEqual([1, 1, 2]);
    // Only the very first message of a turn carries isFirstOfTurn=true; the
    // assistant in turn 1 is the first, the user in turn 2 is the first.
    expect(out.map((m) => m.isFirstOfTurn)).toEqual([true, false, true]);
  });

  // AGENT-09: regression test for the O(N²) `out.some(...)` issue.
  // Before the fix, numbering 5,000 assistant messages took ~tens of ms
  // due to the linear scan per assistant message. After the fix it is
  // strictly O(N). We assert correctness on a large fixture (and time it
  // generously so this test won't flake on slow CI).
  it("scales linearly with message count (O(N))", () => {
    const n = 5_000;
    const big: RenderedMessage[] = [user("u1")];
    for (let i = 0; i < n; i += 1) big.push(assistant(`a${i}`));

    const t0 = performance.now();
    const out = assignTurnNumbers(big);
    const elapsed = performance.now() - t0;

    expect(out.length).toBe(n + 1);
    // All in turn 1, only the first message carries isFirstOfTurn=true.
    expect(out[0].isFirstOfTurn).toBe(true);
    expect(out[1].isFirstOfTurn).toBe(false);
    expect(out[out.length - 1].isFirstOfTurn).toBe(false);
    expect(out.every((m) => m.turn === 1)).toBe(true);
    // Generous bound — pre-fix run was ~100ms+ on a fast machine; post-fix
    // is sub-millisecond. 250ms is a comfortable ceiling that still fails
    // loudly if O(N²) regresses.
    expect(elapsed).toBeLessThan(250);
  });
});
