/**
 * Pure-logic reducer that folds Claude Agent stream-json events into
 * a normalized list of "turns" for rendering.
 *
 * NOT a React hook — keep it pure so it's vitest-testable against the fixtures.
 *
 * Folding rules:
 * - `stream_event` partials are DROPPED (we use full `assistant` events instead).
 * - `system/init` is captured once into `initEvent` and flips `initialized = true`.
 * - Other `system/*` events are ignored (they're flow markers like "requesting").
 * - `assistant` events with the same `message.id` are MERGED — content arrays are
 *   concatenated in arrival order. Claude commonly emits one assistant event per
 *   content block (thinking, then tool_use, then text), all sharing the same id.
 * - `user` events with `tool_result` blocks update the `toolResults` map keyed by
 *   `tool_use_id`. They are NOT appended as user messages (they're rendered inline
 *   by the paired `tool_use` block).
 * - `user` events with text content are appended as user messages.
 * - `result` updates `resultEvent`.
 * - `rate_limit_event` updates `rateLimitInfo`.
 * - `parse_error` events are appended to `unknownEvents` for diagnostics.
 * - Unknown event types are appended to `unknownEvents` (don't crash).
 */

import type {
  AgentEvent,
  AssistantEvent,
  ContentBlock,
  InitEvent,
  RateLimitInfo,
  ResultEvent,
  TextBlockData,
  ThinkingBlockData,
  ToolResultBlockData,
  UserEvent,
} from "./types";
import {
  isAssistantEvent,
  isInitEvent,
  isParseErrorEvent,
  isRateLimitEvent,
  isResultEvent,
  isStreamPartial,
  isSystemEvent,
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
  isUserEvent,
} from "./types";

export interface RenderedMessage {
  /** `message.id` for assistant; `user-{uuid}` for user. */
  id: string;
  role: "user" | "assistant";
  blocks: ContentBlock[];
  usage?: AssistantEvent["message"]["usage"];
  parentToolUseId?: string | null;
  /**
   * Unix ms timestamp captured when the message was first observed by the
   * reducer (i.e., on the first assistant/user event with this id).
   * Rendered as a hover-only marginalia annotation in the right gutter.
   */
  timestamp?: number;
}

export interface AgentSessionState {
  initialized: boolean;
  initEvent: InitEvent | null;
  messages: RenderedMessage[];
  /** tool_use_id → tool_result block (for pairing with tool_use). */
  toolResults: Map<string, ToolResultBlockData>;
  resultEvent: ResultEvent | null;
  rateLimitInfo: RateLimitInfo | null;
  lastError: string | null;
  /** Diagnostic catch-all — anything we couldn't classify. */
  unknownEvents: AgentEvent[];
  /**
   * Phase 5 streaming state — three precious "alive" cues.
   *
   * `streamingMessageId`: id of the assistant message currently being streamed
   * (`stop_reason === null`). Cleared on the closing assistant event
   * (`stop_reason !== null`) or on the `result` event. Drives the heartbeat
   * cursor at the end of the latest text block.
   *
   * `runningToolUseIds`: set of `tool_use.id`s observed in an assistant event
   * that have not yet been paired with a `tool_result` user event. Drives the
   * tool-respiration animation on the matching tool block. Reconstructed (new
   * `Set`) on every change for React identity-based memoization.
   *
   * `thinkingStartedAt`: map keyed by `messageId + ":" + blockIndex` to an
   * epoch-ms timestamp. Set on first observation of a thinking block; deleted
   * once the block has ended (a non-thinking block follows in the same message,
   * or the `result` event arrives, or a closing assistant event arrives).
   *
   * `thinkingElapsed`: map keyed identically, holding the frozen `Date.now() -
   * startedAt` value once the thinking block ends. Read by `<ThinkingBlock>` to
   * render a stable elapsed counter on subsequent renders.
   */
  streamingMessageId: string | null;
  runningToolUseIds: Set<string>;
  thinkingStartedAt: Map<string, number>;
  thinkingElapsed: Map<string, number>;
  /**
   * Streaming-thinking-text accumulator.  Keyed identically to
   * `thinkingStartedAt` (`messageId + ":" + blockIndex`).  Populated from
   * `stream_event` → `content_block_delta` → `thinking_delta` envelopes
   * when the SDK's consolidated `assistant` event ships an empty
   * `thinking: ""` placeholder (newer SDK / model behavior with
   * `includePartialMessages: true`).  The renderer falls back to this
   * value when `block.thinking` is empty.
   */
  streamingThinkingText: Map<string, string>;
  /**
   * The id of the most recent `stream_event` `message_start` envelope.
   * Needed because the per-block partial events (`content_block_delta`,
   * etc.) only carry an `index`, not a `message.id`, so we have to
   * remember which assistant message they belong to.
   */
  currentStreamMessageId: string | null;
  /** Running total of `total_cost_usd` across every `result` event seen
   *  this session.  Drives the masthead cost lozenge.  Note this is the
   *  *bridge process's* lifetime, which with the long-lived bridge equals
   *  the user's session.  Reset on workspace restore. */
  cumulativeCostUsd: number;
  /** Same idea for input tokens. Used by the Usage panel after it opens late. */
  cumulativeInputTokens: number;
  /** Same idea for output tokens — quick "how much have I gotten back?" */
  cumulativeOutputTokens: number;
  /** Account info from the SDK's `query.accountInfo()`.  Captured once
   *  per session via the bridge's `_hermes_event/account_info` envelope.
   *  Populates the Usage panel's "Account" section. */
  accountInfo: {
    email?: string;
    organization?: string;
    subscriptionType?: string;
    apiKeySource?: string;
    tokenSource?: string;
    apiProvider?: string;
  } | null;
  /** Latest rate-limit snapshot per `rateLimitType` ("five_hour" /
   *  "weekly" / etc.).  rate_limit_events arrive on every turn; we keep
   *  the most recent of each kind so the Usage panel can show all the
   *  active windows at once. */
  rateLimits: Record<string, RateLimitInfo>;
  /** Set of result-event uuids we've already accumulated cost / tokens
   *  for.  Some bridge versions re-emit prior result envelopes on
   *  resume, which would otherwise double-count session cost (M1 fix).
   *  Bounded retention is fine because Claude assigns one uuid per
   *  turn; even a marathon session is < 10 KB. */
  seenResultEventIds: Set<string>;
  /** Wall-clock ms when the most recent `result` event was observed.
   *  Used by `deriveActivity` to decide that a turn has concluded
   *  even when no assistant message was appended (e.g., the user
   *  hit Stop before Claude streamed its first byte).  Without this,
   *  the "awaiting claude" indicator stays spinning forever because
   *  the last message in `messages` is still the user's prompt.
   *  Null until the first `result` event arrives. */
  resultEventAt: number | null;
}

export function emptyState(): AgentSessionState {
  return {
    cumulativeCostUsd: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    accountInfo: null,
    rateLimits: {},
    initialized: false,
    initEvent: null,
    messages: [],
    toolResults: new Map(),
    resultEvent: null,
    rateLimitInfo: null,
    lastError: null,
    unknownEvents: [],
    streamingMessageId: null,
    runningToolUseIds: new Set(),
    thinkingStartedAt: new Map(),
    thinkingElapsed: new Map(),
    streamingThinkingText: new Map(),
    currentStreamMessageId: null,
    seenResultEventIds: new Set(),
    resultEventAt: null,
  };
}

function upsertAssistant(
  messages: RenderedMessage[],
  event: AssistantEvent,
): RenderedMessage[] {
  const id = event.message.id;
  const existingIdx = messages.findIndex((m) => m.role === "assistant" && m.id === id);
  const incomingBlocks = Array.isArray(event.message.content) ? event.message.content : [];

  if (existingIdx === -1) {
    const next: RenderedMessage = {
      id,
      role: "assistant",
      blocks: [...incomingBlocks],
      usage: event.message.usage,
      parentToolUseId: event.parent_tool_use_id ?? null,
      timestamp: Date.now(),
    };
    return [...messages, next];
  }

  const existing = messages[existingIdx];
  const mergedBlocks = mergeAssistantBlocks(existing.blocks, incomingBlocks);
  // If the merge produced no real change (replay of an identical event),
  // skip the array allocation entirely so React reference-equality stays cheap.
  if (mergedBlocks === existing.blocks && (event.message.usage ?? existing.usage) === existing.usage) {
    return messages;
  }
  const merged: RenderedMessage = {
    ...existing,
    blocks: mergedBlocks,
    // Latest usage wins (Claude reports cumulative usage on the latest event).
    usage: event.message.usage ?? existing.usage,
  };
  const out = messages.slice();
  out[existingIdx] = merged;
  return out;
}

/**
 * Merge incoming assistant content blocks into an existing list while
 * deduping by content-block identity.  This guards against bridge-resume
 * scenarios where the same assistant event is replayed and the SDK quirk
 * where a cumulative-content payload arrives alongside incremental updates.
 *
 * Identity rules (in order of precedence):
 *   - `tool_use`  → match on `(type, id)`.
 *   - `thinking`  → match on `(type, signature)` if `signature` is set; else
 *                   if an empty-thinking placeholder exists at the same
 *                   index, replace it in-place with the non-empty version.
 *   - `text`      → match on `(type, text)` exact.
 *
 * Returns the original `existing` reference if no incoming block contributed
 * a change, so callers can short-circuit downstream allocations.
 */
function mergeAssistantBlocks(
  existing: ContentBlock[],
  incoming: ContentBlock[],
): ContentBlock[] {
  if (incoming.length === 0) return existing;

  let out: ContentBlock[] | null = null;
  const target = (): ContentBlock[] => {
    if (!out) out = existing.slice();
    return out;
  };

  for (let i = 0; i < incoming.length; i++) {
    const block = incoming[i];
    const current = out ?? existing;

    if (isToolUseBlock(block)) {
      const dup = current.some(
        (b) => isToolUseBlock(b) && b.id === block.id,
      );
      if (dup) continue;
      target().push(block);
      continue;
    }

    if (isThinkingBlock(block)) {
      const sig = (block as { signature?: unknown }).signature;
      // Replace an empty-thinking placeholder at the same index with
      // the non-empty version.  This runs FIRST, regardless of whether
      // the new block has a signature — without it, the placeholder
      // that the stream-partial reducer synthesizes on
      // `content_block_start|thinking` would never be replaced (the
      // real assistant event arrives with both a signature AND real
      // text, which used to skip this branch).
      const sameIdx = i < current.length ? current[i] : undefined;
      if (
        sameIdx !== undefined &&
        isThinkingBlock(sameIdx) &&
        (sameIdx as { thinking?: string }).thinking === "" &&
        typeof (block as { thinking?: string }).thinking === "string" &&
        (block as { thinking?: string }).thinking !== ""
      ) {
        const arr = target();
        arr[i] = block;
        continue;
      }
      if (typeof sig === "string" && sig.length > 0) {
        const dup = current.some(
          (b) =>
            isThinkingBlock(b) &&
            (b as { signature?: unknown }).signature === sig,
        );
        if (dup) continue;
        target().push(block);
        continue;
      }
      // Exact-content match dedupe (replay).
      const dup = current.some(
        (b) =>
          isThinkingBlock(b) &&
          (b as { thinking?: string }).thinking ===
            (block as { thinking?: string }).thinking,
      );
      if (dup) continue;
      target().push(block);
      continue;
    }

    if (block.type === "text") {
      const text = (block as { text?: string }).text ?? "";
      const dup = current.some(
        (b) => b.type === "text" && (b as { text?: string }).text === text,
      );
      if (dup) continue;
      target().push(block);
      continue;
    }

    // Fallback: append unfamiliar block types as-is (no dedupe basis).
    target().push(block);
  }

  return out ?? existing;
}

function appendUserMessage(
  messages: RenderedMessage[],
  event: UserEvent,
): RenderedMessage[] {
  const blocks = Array.isArray(event.message.content) ? event.message.content : [];
  const id = `user-${event.uuid ?? `${messages.length}`}`;
  return [
    ...messages,
    {
      id,
      role: "user",
      blocks,
      parentToolUseId: event.parent_tool_use_id ?? null,
      timestamp: Date.now(),
    },
  ];
}

function recordToolResults(
  toolResults: Map<string, ToolResultBlockData>,
  blocks: ContentBlock[],
): Map<string, ToolResultBlockData> {
  let mutated: Map<string, ToolResultBlockData> | null = null;
  for (const block of blocks) {
    if (isToolResultBlock(block)) {
      if (!mutated) mutated = new Map(toolResults);
      mutated.set(block.tool_use_id, block);
    }
  }
  return mutated ?? toolResults;
}

/**
 * Build a stable lookup key for the streaming-state thinking maps.
 * The block index is the position inside the *merged* content array of an
 * assistant message, so a key uniquely identifies a single thinking block in
 * a conversation across reducer calls.
 */
function thinkingBlockKey(messageId: string, blockIndex: number): string {
  return `${messageId}:${blockIndex}`;
}

/**
 * Find the assistant message in `messages` by id and return its merged blocks,
 * or `null` if not found. Used for thinking-elapsed bookkeeping which depends
 * on the *post-merge* block layout.
 */
function findAssistantBlocks(
  messages: RenderedMessage[],
  messageId: string,
): ContentBlock[] | null {
  const m = messages.find((msg) => msg.role === "assistant" && msg.id === messageId);
  return m ? m.blocks : null;
}

/**
 * After an assistant event has been merged into the messages list, reconcile
 * the thinking-state maps:
 *
 * 1. For every thinking block in this message, ensure `thinkingStartedAt` has
 *    an entry (preserving the original first-seen timestamp).
 * 2. For every thinking block that is *no longer* the trailing block (i.e.,
 *    a non-thinking block exists at a higher index), capture elapsed and
 *    delete the started entry.
 *
 * Returns new Map instances only if a change happened, otherwise returns the
 * input maps unchanged so React reference-equality memoization stays cheap.
 */
function reconcileThinkingForMessage(
  messageId: string,
  blocks: ContentBlock[],
  thinkingStartedAt: Map<string, number>,
  thinkingElapsed: Map<string, number>,
  now: number,
): {
  thinkingStartedAt: Map<string, number>;
  thinkingElapsed: Map<string, number>;
} {
  let nextStarted: Map<string, number> | null = null;
  let nextElapsed: Map<string, number> | null = null;

  // Index of the last non-thinking block (-1 if none). A thinking block at
  // position `i` is considered "ended" iff `lastNonThinkingIdx > i`.
  let lastNonThinkingIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (!isThinkingBlock(blocks[i])) {
      lastNonThinkingIdx = i;
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!isThinkingBlock(block)) continue;
    const key = thinkingBlockKey(messageId, i);

    // Track whether this entry's timer pre-existed before this invocation.
    // If we create the timer here, we must NOT also freeze it in the same
    // call — that would record elapsed=0 for late-arriving thinking blocks
    // whose merged layout already has trailing non-thinking content.
    const preExisted = thinkingStartedAt.has(key);

    // 1. First-seen → start timer (only if no elapsed already captured).
    if (!preExisted && !thinkingElapsed.has(key)) {
      if (!nextStarted) nextStarted = new Map(thinkingStartedAt);
      nextStarted.set(key, now);
    }

    // 2. Has another non-thinking block come in *after* this thinking block?
    // If so, the thinking step has ended — capture elapsed and clear started.
    // Only freeze entries whose timer pre-existed, otherwise we'd record an
    // immediate elapsed=0 for a never-observed-alive thinking block (B3b).
    const ended = lastNonThinkingIdx > i;
    if (ended && preExisted) {
      const startedAt =
        (nextStarted ?? thinkingStartedAt).get(key) ?? thinkingStartedAt.get(key);
      if (startedAt !== undefined && !thinkingElapsed.has(key)) {
        if (!nextElapsed) nextElapsed = new Map(thinkingElapsed);
        nextElapsed.set(key, Math.max(0, now - startedAt));
      }
      if ((nextStarted ?? thinkingStartedAt).has(key)) {
        if (!nextStarted) nextStarted = new Map(thinkingStartedAt);
        nextStarted.delete(key);
      }
    }
  }

  return {
    thinkingStartedAt: nextStarted ?? thinkingStartedAt,
    thinkingElapsed: nextElapsed ?? thinkingElapsed,
  };
}

/**
 * Freeze every still-pending thinking timer. Used when the turn ends (closing
 * assistant event with a `stop_reason`, or the final `result` event).
 *
 * Exported so the per-session store can apply the same freeze on a subprocess
 * exit that arrives without a result event (signal kill, abort, crash) —
 * otherwise the heartbeat cursor and thinking elapsed counter would tick
 * forever even though the turn is over.
 */
export function freezePendingThinking(
  thinkingStartedAt: Map<string, number>,
  thinkingElapsed: Map<string, number>,
  now: number,
): {
  thinkingStartedAt: Map<string, number>;
  thinkingElapsed: Map<string, number>;
} {
  if (thinkingStartedAt.size === 0) {
    return { thinkingStartedAt, thinkingElapsed };
  }
  const nextElapsed = new Map(thinkingElapsed);
  for (const [key, startedAt] of thinkingStartedAt) {
    if (!nextElapsed.has(key)) {
      nextElapsed.set(key, Math.max(0, now - startedAt));
    }
  }
  return {
    thinkingStartedAt: new Map(),
    thinkingElapsed: nextElapsed,
  };
}

/**
 * Count the number of distinct message ids that own a pending thinking
 * timer.  Used by the `result` event branch (B8) to decide whether the
 * freeze is unambiguous: at most one message → freeze; multiple → leave
 * alone, since `result` doesn't carry a message id and we can't tell
 * which concurrent sub-agent message it terminated.
 */
function countDistinctMessageIdsInThinking(
  thinkingStartedAt: Map<string, number>,
): number {
  if (thinkingStartedAt.size === 0) return 0;
  const ids = new Set<string>();
  for (const key of thinkingStartedAt.keys()) {
    const colonIdx = key.lastIndexOf(":");
    ids.add(colonIdx >= 0 ? key.slice(0, colonIdx) : key);
  }
  return ids.size;
}

/**
 * For an assistant event, walk the new (this-event-only) content blocks and
 * mark any tool_use ids as running. Note: matching tool_results may arrive in
 * a *later* user event, which is where we remove ids — see `clearToolResults`.
 */
function addRunningToolUses(
  running: Set<string>,
  blocks: ContentBlock[],
  toolResults: Map<string, ToolResultBlockData>,
): Set<string> {
  let next: Set<string> | null = null;
  for (const b of blocks) {
    if (isToolUseBlock(b)) {
      // Out-of-order delivery: a tool_result may have already arrived for
      // this tool_use_id before the assistant event itself.  In that case
      // the tool isn't running — skip it, otherwise it would be stuck
      // "running" forever (no future tool_result will clear it) (B7).
      if (toolResults.has(b.id)) continue;
      if (running.has(b.id)) continue;
      if (!next) next = new Set(running);
      next.add(b.id);
    }
  }
  return next ?? running;
}

function clearToolResults(
  running: Set<string>,
  blocks: ContentBlock[],
): Set<string> {
  let next: Set<string> | null = null;
  for (const b of blocks) {
    if (isToolResultBlock(b)) {
      if (running.has(b.tool_use_id)) {
        if (!next) next = new Set(running);
        next.delete(b.tool_use_id);
      }
    }
  }
  return next ?? running;
}

/**
 * Inspect a `stream_event` partial and update the streaming-thinking-text
 * accumulator when it carries a `thinking_delta`.  Every other partial is
 * a no-op — we still rely on full `assistant` events for everything else.
 *
 * Three subtypes are interesting:
 *   - `message_start`        → latch the assistant `message.id`.  Per-block
 *                              deltas below carry only an `index`, so we
 *                              need this id to build a stable accumulator
 *                              key (`messageId:blockIndex`).
 *   - `content_block_start`  → if the block is `thinking`, clear any
 *                              accumulator entry for this slot so a new
 *                              block doesn't inherit stale text from a
 *                              prior thinking block at the same index
 *                              (different message id ⇒ different key
 *                              already, but explicit reset costs nothing
 *                              and is robust to id collisions on resume).
 *   - `content_block_delta`  → if `delta.type === "thinking_delta"`,
 *                              append `delta.thinking` to the slot.
 */
function reduceStreamPartial(
  state: AgentSessionState,
  event: AgentEvent,
): AgentSessionState {
  const inner = (event as { event?: {
    type?: string;
    index?: number;
    delta?: { type?: string; thinking?: string };
    content_block?: { type?: string };
    message?: { id?: string };
  } }).event;
  if (!inner) return state;

  if (inner.type === "message_start") {
    const id = inner.message?.id;
    if (typeof id === "string" && id !== state.currentStreamMessageId) {
      return { ...state, currentStreamMessageId: id };
    }
    return state;
  }

  if (
    inner.type === "content_block_start"
    && inner.content_block?.type === "thinking"
    && typeof inner.index === "number"
    && state.currentStreamMessageId
  ) {
    const msgId = state.currentStreamMessageId;
    const blockIdx = inner.index;
    const key = `${msgId}:${blockIdx}`;

    // 1. Clear any stale streaming-thinking accumulator entry for this slot.
    let nextStreamingText = state.streamingThinkingText;
    if (state.streamingThinkingText.has(key)) {
      nextStreamingText = new Map(state.streamingThinkingText);
      nextStreamingText.delete(key);
    }

    // 2. Synthesize a placeholder assistant message with an empty
    //    thinking block at `blockIdx` if no real message exists yet.
    //    Without this, the consolidated `assistant` event doesn't
    //    arrive until thinking is fully done (often 30 s+), and the
    //    operator stares at "Awaiting Claude" the whole time even
    //    though we ARE receiving `thinking_delta` partials.  The
    //    placeholder makes the in-conversation ThinkingBlock render
    //    immediately; subsequent deltas flow into
    //    `streamingThinkingText` and the BlockRenderer's merge logic
    //    surfaces them in the body in real time.  When the real
    //    assistant event eventually lands, `mergeAssistantBlocks`
    //    replaces the empty placeholder at `blockIdx` with the signed
    //    real block (see the placeholder-replacement branch).
    let nextMessages = state.messages;
    let nextThinkingStartedAt = state.thinkingStartedAt;
    let nextStreamingMessageId = state.streamingMessageId;
    const existingIdx = state.messages.findIndex(
      (m) => m.role === "assistant" && m.id === msgId,
    );
    if (existingIdx === -1) {
      const placeholderBlocks: ContentBlock[] = [];
      // Pad with empty text blocks if the thinking block isn't at
      // index 0 (rare but possible).  These get replaced by
      // mergeAssistantBlocks when the real blocks land.
      for (let i = 0; i < blockIdx; i++) {
        placeholderBlocks.push({ type: "text", text: "" } as TextBlockData);
      }
      placeholderBlocks.push({
        type: "thinking",
        thinking: "",
      } as ThinkingBlockData);
      const placeholder: RenderedMessage = {
        id: msgId,
        role: "assistant",
        blocks: placeholderBlocks,
        parentToolUseId: null,
        timestamp: Date.now(),
      };
      nextMessages = [...state.messages, placeholder];
      nextStreamingMessageId = msgId;
      if (!state.thinkingStartedAt.has(key)) {
        nextThinkingStartedAt = new Map(state.thinkingStartedAt).set(
          key,
          Date.now(),
        );
      }
    } else {
      // Message already exists — ensure a thinking block sits at
      // `blockIdx` and start the timer.
      const existing = state.messages[existingIdx];
      const needsBlock =
        existing.blocks.length <= blockIdx
        || !isThinkingBlock(existing.blocks[blockIdx]);
      if (needsBlock) {
        const newBlocks = existing.blocks.slice();
        while (newBlocks.length < blockIdx) {
          newBlocks.push({ type: "text", text: "" } as TextBlockData);
        }
        newBlocks[blockIdx] = {
          type: "thinking",
          thinking: "",
        } as ThinkingBlockData;
        const updated: RenderedMessage = { ...existing, blocks: newBlocks };
        nextMessages = state.messages.slice();
        nextMessages[existingIdx] = updated;
      }
      if (!state.thinkingStartedAt.has(key)) {
        nextThinkingStartedAt = new Map(state.thinkingStartedAt).set(
          key,
          Date.now(),
        );
      }
      if (state.streamingMessageId !== msgId) {
        nextStreamingMessageId = msgId;
      }
    }

    if (
      nextStreamingText === state.streamingThinkingText
      && nextMessages === state.messages
      && nextThinkingStartedAt === state.thinkingStartedAt
      && nextStreamingMessageId === state.streamingMessageId
    ) {
      return state;
    }
    return {
      ...state,
      streamingThinkingText: nextStreamingText,
      messages: nextMessages,
      thinkingStartedAt: nextThinkingStartedAt,
      streamingMessageId: nextStreamingMessageId,
    };
  }

  if (
    inner.type === "content_block_delta"
    && inner.delta?.type === "thinking_delta"
    && typeof inner.delta.thinking === "string"
    && typeof inner.index === "number"
    && state.currentStreamMessageId
  ) {
    const key = `${state.currentStreamMessageId}:${inner.index}`;
    const prev = state.streamingThinkingText.get(key) ?? "";
    const next = new Map(state.streamingThinkingText);
    next.set(key, prev + inner.delta.thinking);
    return { ...state, streamingThinkingText: next };
  }

  return state;
}

/**
 * Pure reducer — given the previous state and an incoming event,
 * return the next state. Never mutates the input.
 */
export function reduceEvent(
  state: AgentSessionState,
  event: AgentEvent,
): AgentSessionState {
  // 1. stream_event partials.  Historically dropped wholesale, but newer
  //    SDK / model combinations only ever emit thinking text via
  //    `thinking_delta` envelopes — the consolidated `assistant` event
  //    arrives with `thinking: ""`.  We selectively harvest just enough
  //    state from partials to populate the thinking accumulator; every
  //    other partial is still ignored (the rest of the reducer continues
  //    to fold from full `assistant` events as before).
  if (isStreamPartial(event)) {
    return reduceStreamPartial(state, event);
  }

  // 2. system/* events.
  if (isSystemEvent(event)) {
    if (isInitEvent(event)) {
      // H4 fix: a fresh init means the bridge respawned.  Any tool_use
      // ids we were tracking belong to the prior subprocess and will
      // never get a matching tool_result, so freeze the activity
      // indicator's "running" state instead of letting it hang
      // forever.  thinking timers similarly belong to the dead
      // subprocess — freeze elapsed values so they render as final
      // rather than ticking up.
      const now = Date.now();
      const { thinkingStartedAt, thinkingElapsed } = freezePendingThinking(
        state.thinkingStartedAt,
        state.thinkingElapsed,
        now,
      );
      return {
        ...state,
        initialized: true,
        initEvent: event,
        runningToolUseIds:
          state.runningToolUseIds.size === 0
            ? state.runningToolUseIds
            : new Set(),
        streamingMessageId: null,
        thinkingStartedAt,
        thinkingElapsed,
        // Bridge respawn — any cached stream message-id belongs to the
        // dead subprocess.  Clearing prevents a fresh delta from being
        // attached to the wrong message slot.
        currentStreamMessageId: null,
        // Same reasoning for the streaming-thinking-text accumulator:
        // entries belong to the dead subprocess and would otherwise leak
        // forever across bridge respawns (B5).
        streamingThinkingText:
          state.streamingThinkingText.size === 0
            ? state.streamingThinkingText
            : new Map(),
      };
    }
    // Other system events (status, etc.) are flow markers — ignore quietly.
    return state;
  }

  // 3. Assistant events: merge by message.id.
  if (isAssistantEvent(event)) {
    const nextMessages = upsertAssistant(state.messages, event);
    const messageId = event.message.id;
    const incomingBlocks = Array.isArray(event.message.content)
      ? event.message.content
      : [];
    const mergedBlocks = findAssistantBlocks(nextMessages, messageId) ?? [];
    const now = Date.now();

    // streamingMessageId reflects whether *this* turn is mid-stream.
    // Claude's stream-json emits `stop_reason: null` on partial assistant
    // events and a non-null stop_reason on the closing event of the turn.
    const stopReason = event.message.stop_reason;
    const isClosing = stopReason !== undefined && stopReason !== null;
    const streamingMessageId = isClosing ? null : messageId;

    // Run-set: add any new tool_use ids from this event's incoming blocks.
    // Pass `state.toolResults` so out-of-order delivery (tool_result before
    // assistant event) doesn't re-mark an already-resolved tool as running.
    const runningToolUseIds = addRunningToolUses(
      state.runningToolUseIds,
      incomingBlocks,
      state.toolResults,
    );

    // Thinking state: reconcile against the *merged* block layout.
    let { thinkingStartedAt, thinkingElapsed } = reconcileThinkingForMessage(
      messageId,
      mergedBlocks,
      state.thinkingStartedAt,
      state.thinkingElapsed,
      now,
    );

    // Closing event also freezes any thinking timers that are still alive
    // (e.g., a turn that ended with a final thinking block).
    if (isClosing) {
      const frozen = freezePendingThinking(
        thinkingStartedAt,
        thinkingElapsed,
        now,
      );
      thinkingStartedAt = frozen.thinkingStartedAt;
      thinkingElapsed = frozen.thinkingElapsed;
    }

    return {
      ...state,
      messages: nextMessages,
      streamingMessageId,
      runningToolUseIds,
      thinkingStartedAt,
      thinkingElapsed,
    };
  }

  // 4. User events.
  if (isUserEvent(event)) {
    const blocks = Array.isArray(event.message.content) ? event.message.content : [];
    const hasToolResults = blocks.some((b) => isToolResultBlock(b));
    const hasNonToolResult = blocks.some((b) => !isToolResultBlock(b));

    let nextToolResults = state.toolResults;
    let nextMessages = state.messages;
    let nextRunning = state.runningToolUseIds;

    if (hasToolResults) {
      nextToolResults = recordToolResults(state.toolResults, blocks);
      nextRunning = clearToolResults(state.runningToolUseIds, blocks);
    }
    if (hasNonToolResult) {
      // Echoed user prompt or other non-tool-result content — render as a user message.
      nextMessages = appendUserMessage(state.messages, event);
    }

    if (
      nextToolResults === state.toolResults &&
      nextMessages === state.messages &&
      nextRunning === state.runningToolUseIds
    ) {
      return state;
    }
    return {
      ...state,
      toolResults: nextToolResults,
      messages: nextMessages,
      runningToolUseIds: nextRunning,
    };
  }

  // 5. Result event — captured for end-of-turn footer.
  if (isResultEvent(event)) {
    const now = Date.now();
    // B8: a `result` event indicates the *parent* turn ended, not
    // necessarily every concurrently-streaming sub-agent message.  When
    // multiple distinct messageIds have pending thinking timers we can't
    // tell which one ended, so leave them all alive — a stale ticker is
    // less harmful than freezing an unrelated sub-agent's clock.  The
    // single-message case (the common one) still freezes as before.
    const distinctMessageIds = countDistinctMessageIdsInThinking(
      state.thinkingStartedAt,
    );
    const { thinkingStartedAt, thinkingElapsed } =
      distinctMessageIds <= 1
        ? freezePendingThinking(
            state.thinkingStartedAt,
            state.thinkingElapsed,
            now,
          )
        : { thinkingStartedAt: state.thinkingStartedAt, thinkingElapsed: state.thinkingElapsed };
    // M1 fix: dedupe by uuid.  Some bridge versions re-emit prior
    // result envelopes on resume; without this guard the masthead
    // cost lozenge would balloon to ~2× / ~3× / N× actual spend.
    // Events with no uuid (older bridges) skip the dedup check and
    // accumulate as before — they aren't subject to the re-emit bug.
    const eventId = typeof event.uuid === "string" ? event.uuid : null;
    const alreadyAccumulated =
      eventId !== null && state.seenResultEventIds.has(eventId);
    const turnCost = alreadyAccumulated
      ? 0
      : typeof event.total_cost_usd === "number"
        ? event.total_cost_usd
        : 0;
    const turnOut = alreadyAccumulated
      ? 0
      : (() => {
          const u = (event as { usage?: { output_tokens?: unknown } }).usage;
          const v = u?.output_tokens;
          return typeof v === "number" ? v : 0;
        })();
    const turnIn = alreadyAccumulated
      ? 0
      : (() => {
          const u = (event as { usage?: { input_tokens?: unknown } }).usage;
          const v = u?.input_tokens;
          return typeof v === "number" ? v : 0;
        })();
    const seenResultEventIds =
      eventId !== null && !alreadyAccumulated
        ? appendCappedResultId(state.seenResultEventIds, eventId)
        : state.seenResultEventIds;
    // H4 (turn end): clear runningToolUseIds — Claude's contract
    // says any tool_use issued in this turn has its tool_result
    // emitted before the result event, so an entry left here is an
    // orphan that would hang the activity indicator forever.
    return {
      ...state,
      resultEvent: event,
      resultEventAt: now,
      seenResultEventIds,
      cumulativeCostUsd: state.cumulativeCostUsd + turnCost,
      cumulativeInputTokens: state.cumulativeInputTokens + turnIn,
      cumulativeOutputTokens: state.cumulativeOutputTokens + turnOut,
      // A SUCCESSFUL result clears any prior error — once the user has
      // recovered (via /compact, /branch, a fork, etc.) the banner
      // should disappear.  Mid-turn events (assistant deltas, tool
      // results) leave `lastError` untouched so the banner stays put
      // until the next FULL turn lands; the result event itself is
      // what gates banner visibility via `selectFatalError`.
      lastError: event.is_error
        ? event.result ?? `Agent returned ${event.subtype}`
        : null,
      streamingMessageId: null,
      runningToolUseIds:
        state.runningToolUseIds.size === 0
          ? state.runningToolUseIds
          : new Set(),
      thinkingStartedAt,
      thinkingElapsed,
      // The turn is over — drop the latched stream message id so a stray
      // late-arriving content_block_delta doesn't get attributed to the
      // previous message's accumulator (B6).
      currentStreamMessageId: null,
    };
  }

  // 6. Rate-limit events — non-blocking notice.  Also indexed per
  // rateLimitType in `rateLimits` so the Usage panel can show every
  // active window (5-hour, weekly, etc.) at once.
  if (isRateLimitEvent(event)) {
    const info = event.rate_limit_info;
    const kind =
      info && typeof (info as { rateLimitType?: string }).rateLimitType === "string"
        ? (info as { rateLimitType: string }).rateLimitType
        : "default";
    return {
      ...state,
      rateLimitInfo: info,
      rateLimits: { ...state.rateLimits, [kind]: info },
    };
  }

  // 6b. Hermes side-channel event — `account_info` from the bridge's
  // SDK accountInfo() probe.  Not a Claude-protocol event, but it
  // arrives on the same stdout stream so we handle it inline here.
  const ev = event as { type?: string; subtype?: string; info?: unknown };
  if (ev.type === "_hermes_event" && ev.subtype === "account_info") {
    const info = ev.info as AgentSessionState["accountInfo"];
    if (info && typeof info === "object") {
      return { ...state, accountInfo: info };
    }
  }

  // 7. Parse errors and unknown events — diagnostic bucket.
  if (isParseErrorEvent(event)) {
    return {
      ...state,
      unknownEvents: appendCappedUnknown(state.unknownEvents, event),
      lastError: event.error,
    };
  }

  // 8. Catch-all — never crash on unfamiliar event types.
  return {
    ...state,
    unknownEvents: appendCappedUnknown(state.unknownEvents, event),
  };
}

/**
 * Cap on the diagnostic `unknownEvents` array.  In a healthy session
 * this should be empty or near-empty; if a misbehaving bridge spams
 * malformed events it would otherwise grow without bound (each entry
 * is the full event payload).  We keep the most recent N entries and
 * drop the oldest — the diagnostic value is in seeing what's
 * happening *now*, not preserving thousand-event history. */
const UNKNOWN_EVENT_BUFFER_CAP = 200;

function appendCappedUnknown(
  prev: AgentEvent[],
  next: AgentEvent,
): AgentEvent[] {
  if (prev.length < UNKNOWN_EVENT_BUFFER_CAP) {
    return [...prev, next];
  }
  // Slide window: drop oldest, keep cap-1 most recent + the new entry.
  const slice = prev.slice(prev.length - UNKNOWN_EVENT_BUFFER_CAP + 1);
  slice.push(next);
  return slice;
}

/**
 * Cap on `seenResultEventIds` retention.  Sets are insertion-ordered in
 * JavaScript, so we can implement FIFO eviction by slicing off the oldest
 * entries when adding a new one would exceed the cap.  In a healthy session
 * this cap is never reached (Claude assigns one uuid per turn); a
 * misbehaving bridge that fires synthetic result events on every keystroke
 * would otherwise grow this set without bound. */
const RESULT_EVENT_ID_CAP = 1000;

function appendCappedResultId(
  prev: Set<string>,
  next: string,
): Set<string> {
  if (prev.size < RESULT_EVENT_ID_CAP) {
    const out = new Set(prev);
    out.add(next);
    return out;
  }
  // Drop oldest entries to make room for the new one.
  const arr = [...prev];
  const sliced = arr.slice(arr.length - RESULT_EVENT_ID_CAP + 1);
  sliced.push(next);
  return new Set(sliced);
}

/** Convenience: fold an array of events into a final state. */
export function reduceAll(events: AgentEvent[]): AgentSessionState {
  return events.reduce(reduceEvent, emptyState());
}

/**
 * Derive a coarse "what is the agent doing right now?" status from the live
 * reducer state.  Used by the session header to show one of:
 *
 *   - `awaiting`  — user has sent a message but no assistant event has come
 *                   back yet.  We're waiting on Claude's first byte.
 *   - `running`   — a tool_use is in flight (no matching tool_result yet).
 *                   `toolName` carries the tool's name (e.g. "Bash") and
 *                   `since` carries the wall-clock when it started.
 *   - `thinking`  — assistant is mid-stream but no tool is running.  This is
 *                   the model writing a reply or computing internal thinking.
 *   - `idle`      — nothing in flight.
 *
 * Pure function — exported for testability and so the header can call it on
 * every render cheaply.  The traversal is bounded by the message list size,
 * so even on long conversations it's negligible.
 */
export interface AgentActivity {
  status: "idle" | "awaiting" | "thinking" | "running";
  /** Tool name when `status === "running"`. */
  toolName?: string;
  /** Wall-clock ms when this activity started.  Used by the header for an
   *  elapsed counter — null when no meaningful start time is known. */
  since: number | null;
}

export function deriveActivity(state: AgentSessionState): AgentActivity {
  // 1. Tool in flight always wins — that's what's actually consuming time.
  if (state.runningToolUseIds.size > 0) {
    let toolName: string | undefined;
    let since: number | null = null;
    // Walk newest-first so we report the most recently issued tool.
    for (let i = state.messages.length - 1; i >= 0 && !toolName; i--) {
      const msg = state.messages[i];
      if (msg.role !== "assistant") continue;
      for (let j = msg.blocks.length - 1; j >= 0; j--) {
        const block = msg.blocks[j];
        if (isToolUseBlock(block) && state.runningToolUseIds.has(block.id)) {
          toolName = block.name;
          since = msg.timestamp ?? null;
          break;
        }
      }
    }
    return { status: "running", toolName, since };
  }

  // 2. Streaming assistant message → "thinking" (writing a reply).
  if (state.streamingMessageId) {
    const msg = state.messages.find(
      (m) => m.role === "assistant" && m.id === state.streamingMessageId,
    );
    return { status: "thinking", since: msg?.timestamp ?? null };
  }

  // 3. Tail of conversation is a user message with no assistant reply yet.
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === "user") {
    // If a `result` event has arrived AT OR AFTER the user message
    // was sent, the turn has already concluded — likely interrupted
    // or errored before Claude emitted any assistant content.  In
    // that case `streamingMessageId` is already null and no assistant
    // message ever got appended, so without this branch the
    // "awaiting claude" indicator would stay spinning forever (the
    // last message in `messages` is still the user prompt).  The
    // timestamp comparison avoids a false-idle for the NEXT turn:
    // when the user fires off a brand-new prompt after a finished
    // turn, `resultEventAt` is older than the new user message so
    // we still report `awaiting` until Claude actually replies.
    const lastTs = last.timestamp ?? 0;
    if (
      state.resultEventAt !== null &&
      state.resultEventAt >= lastTs
    ) {
      return { status: "idle", since: null };
    }
    return { status: "awaiting", since: last.timestamp ?? null };
  }

  return { status: "idle", since: null };
}
