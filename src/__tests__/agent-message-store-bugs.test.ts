/**
 * Bug-hunting tests for the agent message-store reducer.
 *
 * Each `it()` here is intended to FAIL on the current code, demonstrating a
 * concrete bug in `src/agent/messageStore.ts`.  No fixes are applied in this
 * file — these are reproducers only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyState,
  reduceEvent,
} from "../agent/messageStore";
import type {
  AgentEvent,
  AssistantEvent,
  ResultEvent,
  ToolUseBlockData,
  UserEvent,
} from "../agent/types";

// ─── Helpers ──────────────────────────────────────────────────────────

function assistantEvt(opts: {
  id: string;
  content: AssistantEvent["message"]["content"];
  stopReason?: string | null;
  uuid?: string;
}): AssistantEvent {
  return {
    type: "assistant",
    message: {
      id: opts.id,
      role: "assistant",
      model: "claude-haiku-4-5",
      content: opts.content,
      ...(opts.stopReason !== undefined ? { stop_reason: opts.stopReason } : {}),
    },
    session_id: "s",
    uuid: opts.uuid ?? `u-${opts.id}-${Math.random()}`,
  } as AssistantEvent;
}

// ─── Bug reproducers ──────────────────────────────────────────────────

describe("messageStore — known bugs (reproducers)", () => {
  /**
   * B1 — `upsertAssistant` duplicates blocks when the same assistant
   * event is replayed (or when the SDK ships a cumulative-content
   * payload alongside its incremental updates).
   *
   * The reducer concatenates `incomingBlocks` unconditionally, so the
   * same content can be appended N times for the same `message.id`.
   * On a bridge resume / reconnect that re-streams the prior turn,
   * the rendered transcript shows duplicate text / thinking / tool_use
   * blocks.
   */
  it("B1: identical assistant event replayed twice duplicates blocks (should dedupe)", () => {
    const base = assistantEvt({
      id: "msg_dup",
      content: [
        { type: "text", text: "hello world" },
      ],
      stopReason: null,
    });
    let state = reduceEvent(emptyState(), base);
    // Replay the SAME event again — bridge resume scenario.
    state = reduceEvent(state, base);

    const msg = state.messages.find((m) => m.id === "msg_dup")!;
    // Two copies of the same text block exist in the rendered transcript.
    expect(msg.blocks).toHaveLength(1);
  });

  /**
   * B2 — `upsertAssistant` duplicates a tool_use block on replay,
   * which then leaks through `addRunningToolUses` (the Set dedupes the
   * id, but the rendered block list contains it twice).
   *
   * Visible to the user: the same Bash invocation appears twice in the
   * conversation timeline.
   */
  it("B2: identical tool_use replayed across same message.id duplicates the rendered block", () => {
    const tu: ToolUseBlockData = {
      type: "tool_use",
      id: "tu_dup_1",
      name: "Bash",
      input: { command: "ls" },
    };
    const evt = assistantEvt({
      id: "msg_tu",
      content: [tu],
      stopReason: null,
    });
    let state = reduceEvent(emptyState(), evt);
    state = reduceEvent(state, evt);

    const msg = state.messages.find((m) => m.id === "msg_tu")!;
    const toolUses = msg.blocks.filter((b) => b.type === "tool_use");
    // Currently produces 2 — the Set dedupes runningToolUseIds but the
    // block list shows the same tool_use twice.
    expect(toolUses).toHaveLength(1);
  });

  /**
   * B3 — `reconcileThinkingForMessage` sets elapsed=0 when a thinking
   * block is observed for the first time AFTER a non-thinking block
   * already exists in the merged content array.
   *
   * Why this matters: an assistant event that arrives with a single
   * thinking block but the merged layout already has trailing text
   * (because earlier events filled in tail content first) will mark
   * the thinking block as "ended at the same instant it started".
   * The UI then renders the thinking block with a static `0ms` elapsed
   * counter, which is wrong — the model genuinely spent time on it.
   */
  it("B3: thinking block first-seen with trailing non-thinking gets elapsed=0", () => {
    vi.useFakeTimers();
    try {
      const T0 = 1_700_000_000_000;
      vi.setSystemTime(T0);

      // Build a pre-merged message that already has a text block at index 0
      // and a thinking block at index 1.  Real-world trigger: an
      // out-of-order assistant event chain, or SDK quirk delivering text
      // first then a thinking block referencing the same message.
      const evt = assistantEvt({
        id: "msg_oo",
        content: [
          { type: "text", text: "answer first" },
          { type: "thinking", thinking: "deferred reasoning" },
        ],
        stopReason: null,
      });
      const state = reduceEvent(emptyState(), evt);

      // Position 1 is a thinking block; position 0 is text → reconciler
      // sees `lastNonThinkingIdx (0) > i (1)` is FALSE (0 < 1), so the
      // thinking block is correctly NOT marked ended.  Started entry
      // should exist; elapsed should NOT yet exist.  This baseline
      // sanity-check passes — we'll exercise the failing case below.
      expect(state.thinkingStartedAt.get("msg_oo:1")).toBe(T0);
      expect(state.thinkingElapsed.has("msg_oo:1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * B3b — actual buggy case: thinking arrives at index 0 but the merged
   * layout already has a text block at a higher index due to an earlier
   * assistant event filling in content tail-first.
   *
   * When `lastNonThinkingIdx > i`, reconciler marks the thinking block
   * as ended IMMEDIATELY using `now - now = 0`.  This is observable on
   * the `started` map being empty and `elapsed` containing 0 for the
   * thinking block, even though it was just first-seen.
   */
  it("B3b: late-arriving thinking block gets elapsed=0 when text already follows", () => {
    vi.useFakeTimers();
    try {
      const T0 = 1_700_000_000_000;
      vi.setSystemTime(T0);

      // Step 1: assistant event arrives carrying a text block (index 0).
      let state = reduceEvent(
        emptyState(),
        assistantEvt({
          id: "msg_late",
          content: [{ type: "text", text: "tail first" }],
          stopReason: null,
        }),
      );

      // Advance the clock — make sure we'd notice if the elapsed was real.
      vi.setSystemTime(T0 + 5_000);

      // Step 2: a second assistant event with the SAME id appends a
      // thinking block.  Because `upsertAssistant` concatenates, the
      // merged blocks become [text, thinking].  Reconciler sees
      // `lastNonThinkingIdx (0) > i (1)`? 0 > 1 is false — so this
      // *particular* layout doesn't trigger the bug.  But if the
      // second event appends [thinking, text-followup] the merged
      // layout is [text, thinking, text-followup] and the bug bites.
      state = reduceEvent(
        state,
        assistantEvt({
          id: "msg_late",
          content: [
            { type: "thinking", thinking: "deferred reasoning" },
            { type: "text", text: "followup" },
          ],
          stopReason: null,
        }),
      );

      // Merged layout: [text(0), thinking(1), text(2)].
      // Reconciler: lastNonThinkingIdx=2, thinking at i=1, ended=true.
      // PRE-FIX behavior: elapsed = now - startedAt = 5000 - 5000 = 0.
      // POST-FIX behavior (proving assertion): the entry must NOT exist —
      // a thinking block that we never observed alive must not report a
      // frozen elapsed of exactly 0 (which would silently render as "0ms"
      // in the UI).  The two assertions below demonstrate the contrast.
      // (Note: the historical `expect(...).toBe(0)` line is omitted here
      // because under the fix the Map has no entry for this key, so a
      // strict assertion would fail with `undefined !== 0` — see B3b in
      // the messageStore fix changelog.)
      expect(state.thinkingElapsed.has("msg_late:1")).toBe(false);
      expect(state.thinkingStartedAt.has("msg_late:1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * B4 — `seenResultEventIds` grows without bound.
   *
   * The comment claims it stays under ~10 KB for a marathon session
   * because Claude assigns one uuid per turn, but no actual cap exists
   * in code.  A misbehaving bridge (or a long-running session) will
   * accumulate forever.  This test injects 10 000 distinct result
   * events to demonstrate that the set grows linearly with no upper
   * bound.
   */
  it("B4: seenResultEventIds is unbounded — accumulates 10k entries", () => {
    let state = emptyState();
    for (let i = 0; i < 10_000; i++) {
      const evt: ResultEvent = {
        type: "result",
        subtype: "success",
        is_error: false,
        uuid: `result-uuid-${i}`,
        total_cost_usd: 0,
      } as ResultEvent;
      state = reduceEvent(state, evt);
    }
    // Currently this passes 10 000 entries.  We assert a sane cap (say
    // 1 000) so the failing test documents the missing bound.
    expect(state.seenResultEventIds.size).toBeLessThanOrEqual(1_000);
  });

  /**
   * B5 — `reduceStreamPartial` does NOT clear `streamingThinkingText`
   * on `init` (bridge respawn).  The reducer clears
   * `currentStreamMessageId` and freezes thinking timers, but the
   * accumulator map is left intact.  A long-lived browser session
   * across multiple bridge restarts therefore leaks every prior
   * subprocess's streamed thinking text into memory indefinitely.
   *
   * Reproducer: stream a partial thinking block, then receive an
   * `init` event, and verify the accumulator contains stale data.
   */
  it("B5: init event does not clear streamingThinkingText (memory leak across respawn)", () => {
    let state = emptyState();
    // Pretend the bridge sent a message_start then a thinking_delta.
    state = reduceEvent(state, {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: "msg_pre_respawn" },
      },
    } as unknown as AgentEvent);
    state = reduceEvent(state, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "stale leak text" },
      },
    } as unknown as AgentEvent);
    expect(state.streamingThinkingText.get("msg_pre_respawn:0")).toBe(
      "stale leak text",
    );

    // Bridge respawns — fresh init event arrives.
    state = reduceEvent(state, {
      type: "system",
      subtype: "init",
      cwd: "/tmp",
      session_id: "new-sess",
      uuid: "init-uuid",
      tools: [],
      slash_commands: [],
      mcp_servers: [],
      model: "m",
      permissionMode: "default",
    } as AgentEvent);

    // Bug: stale entry survives respawn.
    expect(state.streamingThinkingText.size).toBe(0);
  });

  /**
   * B6 — Stream deltas arriving with a stale `currentStreamMessageId`
   * land in the wrong message slot.  The reducer never clears
   * `currentStreamMessageId` on a `result` event (only `init` clears
   * it).  If the bridge sends a `result` and then a stray
   * `content_block_delta` (out-of-order, late arrival) before the
   * next `message_start`, that delta is attributed to the previous
   * message's accumulator.
   */
  it("B6: thinking_delta after result lands on the previous message's accumulator", () => {
    let state = emptyState();
    // Latch a stream message id.
    state = reduceEvent(state, {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: "msg_old" },
      },
    } as unknown as AgentEvent);
    expect(state.currentStreamMessageId).toBe("msg_old");

    // Result arrives — turn over.
    state = reduceEvent(state, {
      type: "result",
      subtype: "success",
      is_error: false,
    } as ResultEvent);

    // A stray thinking_delta arrives after result, before any new
    // message_start.  Bug: it's accumulated against `msg_old`.
    state = reduceEvent(state, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "ghost text" },
      },
    } as unknown as AgentEvent);

    // Expected: no accumulator entry should be created, because the
    // turn is over and we have no current stream message id.
    expect(state.currentStreamMessageId).toBeNull();
    expect(state.streamingThinkingText.has("msg_old:0")).toBe(false);
  });

  /**
   * B7 — `addRunningToolUses` does not check whether the tool_use id
   * already has a recorded `tool_result`.  If `tool_result` arrives
   * BEFORE the assistant event (out-of-order delivery — the bridge
   * batches user/tool_result events ahead of the assistant frame),
   * the assistant event re-adds the id to `runningToolUseIds`,
   * leaving it stuck "running" forever (no future tool_result will
   * clear it).
   */
  it("B7: assistant event after late tool_result re-marks the tool_use as running", () => {
    let state = emptyState();
    // Tool result arrives FIRST — recorded into toolResults map but
    // runningToolUseIds isn't populated yet so clearToolResults is a
    // no-op.
    const userEvt: UserEvent = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_oo",
            content: "result data",
          },
        ],
      },
      uuid: "u-oo",
    } as UserEvent;
    state = reduceEvent(state, userEvt);
    expect(state.toolResults.has("tu_oo")).toBe(true);
    expect(state.runningToolUseIds.has("tu_oo")).toBe(false);

    // Now the assistant event arrives carrying the tool_use that
    // matches the already-seen tool_result.
    state = reduceEvent(
      state,
      assistantEvt({
        id: "msg_oo",
        content: [
          {
            type: "tool_use",
            id: "tu_oo",
            name: "Bash",
            input: {},
          } as ToolUseBlockData,
        ],
        stopReason: null,
      }),
    );

    // Expected: since toolResults already has tu_oo, the tool is NOT
    // running — but `addRunningToolUses` doesn't consult toolResults
    // and unconditionally adds it.
    expect(state.runningToolUseIds.has("tu_oo")).toBe(false);
  });

  /**
   * B8 — `freezePendingThinking` overwrites entries that already exist
   * in `thinkingElapsed`?  Actually the function checks `nextElapsed.has(key)`
   * and only sets if absent — so this isn't a bug.  What IS a bug:
   * the function clears `thinkingStartedAt` to a NEW EMPTY MAP even
   * when only some entries needed freezing.  If a future assistant
   * event creates a new thinking block that *should* have had its
   * timer started simultaneously with the freeze, the empty map is
   * fine — but if `thinkingStartedAt` had unrelated entries (different
   * messageIds), they're all wiped.  This affects parallel agents
   * (parent_tool_use_id sub-agents emit interleaved messages).
   *
   * Reproducer: start two thinking blocks across two messages; a
   * `result` event from one would freeze BOTH, even if only one ended.
   */
  it("B8: freezePendingThinking on a result event freezes UNRELATED messages' thinking timers", () => {
    vi.useFakeTimers();
    try {
      const T0 = 1_700_000_000_000;
      vi.setSystemTime(T0);

      let state = emptyState();
      // Sub-agent A starts thinking.
      state = reduceEvent(
        state,
        assistantEvt({
          id: "msg_A",
          content: [{ type: "thinking", thinking: "A reasons" }],
          stopReason: null,
        }),
      );
      // Concurrently, sub-agent B starts thinking.
      state = reduceEvent(
        state,
        assistantEvt({
          id: "msg_B",
          content: [{ type: "thinking", thinking: "B reasons" }],
          stopReason: null,
        }),
      );
      expect(state.thinkingStartedAt.get("msg_A:0")).toBe(T0);
      expect(state.thinkingStartedAt.get("msg_B:0")).toBe(T0);

      // Sub-agent A returns a result.  Bug: B's thinking is also frozen.
      vi.setSystemTime(T0 + 1_000);
      state = reduceEvent(state, {
        type: "result",
        subtype: "success",
        is_error: false,
      } as ResultEvent);

      // Expected: msg_B's thinking timer is still alive because B
      // hasn't ended.  Currently both are frozen indiscriminately.
      expect(state.thinkingStartedAt.has("msg_B:0")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
