import "../styles/components/agent/AgentSessionView.css";
import { useEffect, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentEvent,
  ContentBlock,
  ToolResultBlockData,
  ToolUseBlockData,
} from "./types";
import {
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
} from "./types";
import { softInterruptAgent } from "../api/agent";
import { useSession } from "../state/SessionContext";
import { deriveActivity, emptyState, reduceEvent } from "./messageStore";
import type { AgentSessionState, RenderedMessage } from "./messageStore";
import { TextBlock } from "./blocks/TextBlock";
import { ThinkingBlock } from "./blocks/ThinkingBlock";
import { ThinkingIndicator } from "./blocks/ThinkingIndicator";
import { ToolUseBlock } from "./blocks/ToolUseBlock";
import { ResultFooter } from "./blocks/ResultFooter";
import { AskUserQuestionCard } from "../components/AskUserQuestionCard";
import { ExitPlanModeCard } from "../components/ExitPlanModeCard";
import { PermissionRequestModal } from "../components/PermissionRequestModal";
import { PlanModeBanner } from "../components/PlanModeBanner";
import { TodoPanel } from "../components/TodoPanel";
import {
  isAskUserQuestionToolUse,
  buildAskAnswerEnvelope,
  type AskUserQuestionInput,
} from "../utils/askUserQuestion";
import {
  isExitPlanModeToolUse,
  buildExitPlanResult,
  type ExitPlanModeInput,
} from "../utils/exitPlanMode";
import {
  isPermRequest,
  buildPermResponse,
  type PermRequest,
  type PermissionDecision,
} from "../utils/permissionRequest";
import { extractTodos } from "../utils/todoStore";

interface AgentSessionViewProps {
  sessionId: string;
  /** Number of workspace_paths attached to the session.  When > 1 the
   *  masthead drops the long cwd path on the right — the chip row above
   *  already enumerates every attached folder, so repeating just the
   *  primary path is misleading.  When ≤ 1 we keep the path so single-
   *  folder sessions still see their working directory at a glance. */
  workspacePathCount: number;
}

interface AgentExitPayload {
  code: number | null;
  signal: string | null;
}

/**
 * Renders Claude's stream-json output as a chat-style timeline.
 *
 * Parent layout owns the composer; this component is just the message stream
 * + status header/footer. Subscribes to:
 *   - agent-event-{sessionId}  — typed AgentEvent per NDJSON line
 *   - agent-stderr-{sessionId} — stderr text chunks (surfaced on error)
 *   - agent-exit-{sessionId}   — process exit
 */
export function AgentSessionView({ sessionId, workspacePathCount }: AgentSessionViewProps) {
  // Resilient envelope sender — wraps `send_agent_input` IPC with a
  // respawn-on-not-found retry.  Used by the interactive cards
  // (AskUserQuestion, ExitPlanMode, canUseTool) so a tool reply
  // doesn't get dropped when the bridge has exited between turns.
  const { sendAgentEnvelope } = useSession();
  const [state, dispatch] = useReducer(reduceEvent, undefined, emptyState);
  const [stderr, setStderr] = useState("");
  const [exitInfo, setExitInfo] = useState<AgentExitPayload | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let unEvent: UnlistenFn | undefined;
    let unErr: UnlistenFn | undefined;
    let unExit: UnlistenFn | undefined;
    let cancelled = false;

    (async () => {
      const e = await listen<AgentEvent>(
        `agent-event-${sessionId}`,
        (msg) => dispatch(msg.payload),
      );
      const s = await listen<string>(
        `agent-stderr-${sessionId}`,
        (msg) => setStderr((prev) => prev + msg.payload),
      );
      const x = await listen<AgentExitPayload>(
        `agent-exit-${sessionId}`,
        (msg) => setExitInfo(msg.payload),
      );
      if (cancelled) {
        e();
        s();
        x();
        return;
      }
      unEvent = e;
      unErr = s;
      unExit = x;
    })();

    return () => {
      cancelled = true;
      unEvent?.();
      unErr?.();
      unExit?.();
    };
  }, [sessionId]);

  // Auto-scroll on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [state.messages, state.resultEvent, exitInfo]);

  // Clear the "Agent process exited" notice when a fresh init event arrives.
  // This is what makes a model swap (close → respawn) feel seamless: the old
  // subprocess fires `agent-exit-…` during teardown, but the new subprocess
  // emits a new init with a different session UUID — we use that as our cue
  // that the agent is alive again and the prior exit is no longer relevant.
  // Also clear any stale stderr — fresh subprocess, fresh diagnostic buffer.
  const initSessionId = state.initEvent?.session_id;
  useEffect(() => {
    if (!initSessionId) return;
    setExitInfo(null);
    setStderr("");
  }, [initSessionId]);

  if (!state.initialized && !exitInfo) {
    // Claude's `--print --input-format stream-json` mode doesn't emit anything
    // (not even the init event) until it receives the first user message on
    // stdin. So the "pre-init" state is just the user's empty inbox — invite
    // them to send their first message rather than implying we're stuck.
    return (
      <div className="agent-session-view">
        <AgentHeader state={state} sessionId={sessionId} workspacePathCount={workspacePathCount} />
        <div className="agent-session-empty">
          <span className="agent-empty-led" aria-hidden="true" />
          <span className="agent-empty-title">[ awaiting first signal ]</span>
          <span className="agent-empty-hint">type below to begin the session</span>
          {stderr && (
            <pre className="agent-empty-stderr">{stderr.slice(-2000)}</pre>
          )}
        </div>
      </div>
    );
  }

  // Compute turn numbers — every user message starts a new turn, all
  // following assistant messages share that turn until the next user input.
  // The number lives in the left gutter as `№ 01`, anchoring the page like
  // a numbered logbook entry rather than a flat chat thread.
  const numbered = assignTurnNumbers(state.messages);
  const turnCount = numbered.length === 0 ? 0 : numbered[numbered.length - 1].turn;

  // Decide whether to render the vintage thinking indicator: only when
  // Claude is actively working AND no streaming assistant text has begun
  // yet (the heartbeat cursor takes over once tokens start arriving).
  const activity = deriveActivity(state);
  const showThinkingIndicator =
    state.initialized
    && (activity.status === "awaiting" || activity.status === "thinking" || activity.status === "running")
    && (state.streamingMessageId === null
      || !hasAnyTextBlock(
          state.messages.find(
            (m) => m.role === "assistant" && m.id === state.streamingMessageId,
          ),
        ));

  // ─── Interactive tool detection ─────────────────────────────────
  // Walk all assistant messages, find the latest unanswered tool_use of
  // a known interactive type (AskUserQuestion, ExitPlanMode).  An
  // unanswered tool_use is one whose `id` is not present in
  // `state.toolResults`.  Render the corresponding card; suppress the
  // composer (the user must answer before continuing).
  const interactivePending = findPendingInteractive(state);
  const todos = extractTodos(
    state.messages.flatMap((m) => (m.role === "assistant" ? m.blocks : [])),
  );
  const permissionMode = state.initEvent?.permissionMode ?? "default";

  return (
    <div className="agent-session-view">
      <AgentHeader state={state} sessionId={sessionId} workspacePathCount={workspacePathCount} />
      <div className="agent-session-scroll" ref={scrollRef}>
        <div className="agent-session-messages">
          {numbered.map(({ message, turn, isFirstOfTurn }) => (
            <MessageRow
              key={message.id}
              message={message}
              turnNumber={turn}
              isFirstOfTurn={isFirstOfTurn}
              toolResults={state.toolResults}
              streamingMessageId={state.streamingMessageId}
              thinkingStartedAt={state.thinkingStartedAt}
              thinkingElapsed={state.thinkingElapsed}
            />
          ))}
          {showThinkingIndicator ? (
            <ThinkingIndicator
              since={activity.since}
              variant={activity.status as "awaiting" | "thinking" | "running"}
              toolName={activity.toolName}
            />
          ) : null}
          {state.resultEvent ? <ResultFooter result={state.resultEvent} /> : null}
          {exitInfo && shouldShowExitNotice(exitInfo, state.messages.length) ? (
            <div className="agent-exit-notice">
              {classifyExit(exitInfo, stderr).label}
              {exitInfo.code !== null ? ` (code ${exitInfo.code})` : ""}
              {exitInfo.signal ? ` (signal ${exitInfo.signal})` : ""}
              {/* Start-Fresh action — clears the local exitInfo so the user
                  can submit again; the next submitAgentMessage's retry path
                  will spawn a fresh INITIAL session, no stale --resume. */}
              <button
                type="button"
                className="agent-exit-action"
                onClick={() => { setExitInfo(null); setStderr(""); }}
              >
                Start fresh from here
              </button>
            </div>
          ) : null}
          {stderr ? (
            <details className="agent-stderr-details">
              <summary>STDERR · {stderr.length} chars</summary>
              <pre className="agent-stderr-body">{stderr}</pre>
            </details>
          ) : null}
          {/* Horizon — gives a short conversation a visible foot rather
              than an empty void, and signals that more is welcome below. */}
          {turnCount > 0 && turnCount < 4 && !state.streamingMessageId ? (
            <div className="agent-session-horizon" aria-hidden="true">· · ·</div>
          ) : null}

          {/* TODO panel — pinned-bottom checklist when TodoWrite has fired. */}
          <TodoPanel todos={todos} />

          {/* Plan-mode banner — visible whenever Claude reports plan mode. */}
          <PlanModeBanner permissionMode={permissionMode} />

          {/* Interactive cards — ExitPlanMode / AskUserQuestion.
              `sendAgentEnvelope` retries-after-respawn so the user's
              reply isn't dropped when the bridge has exited between
              turns (M10). */}
          {interactivePending?.kind === "ExitPlanMode" && (
            <ExitPlanModeCard
              toolUseId={interactivePending.toolUseId}
              input={interactivePending.input}
              permissionMode={permissionMode}
              onSubmit={(decision) => {
                sendAgentEnvelope(
                  sessionId,
                  buildExitPlanResult(interactivePending.toolUseId, decision),
                ).catch((err) => console.warn("[ep] send failed:", err));
              }}
            />
          )}
          {interactivePending?.kind === "AskUserQuestion" && (
            <AskUserQuestionCard
              toolUseId={interactivePending.toolUseId}
              input={interactivePending.input}
              onSubmit={(answers) => {
                sendAgentEnvelope(
                  sessionId,
                  buildAskAnswerEnvelope(interactivePending.toolUseId, answers),
                ).catch((err) => console.warn("[aq] send failed:", err));
              }}
              onCancel={() => {
                sendAgentEnvelope(
                  sessionId,
                  buildAskAnswerEnvelope(interactivePending.toolUseId, [], { cancelled: true }),
                ).catch((err) => console.warn("[aq] cancel send failed:", err));
              }}
            />
          )}

          {/* Permission request modal — driven by NDJSON envelopes from
              the bridge's canUseTool.  The hook listens on the agent
              event stream for `_hermes_perm_request` types. */}
          <PermissionRequestGate sessionId={sessionId} permissionMode={permissionMode} sendAgentEnvelope={sendAgentEnvelope} />
        </div>
      </div>
    </div>
  );
}

/**
 * Bridge ⇄ frontend canUseTool gate.  Listens for `_hermes_perm_request`
 * envelopes on the agent stream, renders the modal, sends the user's
 * decision back via `sendAgentEnvelope` (retry-on-not-found, M10) as a
 * `_hermes_perm_response`.
 */
function PermissionRequestGate({
  sessionId,
  permissionMode,
  sendAgentEnvelope,
}: {
  sessionId: string;
  permissionMode: string;
  sendAgentEnvelope: (sessionId: string, envelope: unknown) => Promise<void>;
}) {
  const [request, setRequest] = useState<PermRequest | null>(null);

  useEffect(() => {
    let cancelled = false;
    let un: UnlistenFn | undefined;
    listen<unknown>(`agent-event-${sessionId}`, (msg) => {
      const ev = msg.payload;
      if (isPermRequest(ev)) {
        setRequest(ev);
      }
    }).then((u) => {
      if (cancelled) u(); else un = u;
    });
    return () => { cancelled = true; un?.(); };
  }, [sessionId]);

  if (!request) return null;

  function decide(decision: PermissionDecision) {
    if (!request) return;
    const env = buildPermResponse(request.id, decision);
    sendAgentEnvelope(sessionId, env).catch((err) =>
      console.warn("[perm] send failed:", err),
    );
    if (decision.kind === "allow" && decision.persist) {
      // Persist the rule to ~/.claude/settings.json (TUI parity per
      // locked decision §0.5).  Best-effort; the in-session allow has
      // already been wired via the response above.
      import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("write_permission_rule", {
          pattern: decision.persist,
          kind: "allow",
          scope: "user",
        }).catch((err) => console.warn("[perm] persist failed:", err)),
      );
    }
    setRequest(null);
  }

  return (
    <PermissionRequestModal
      request={request}
      permissionMode={permissionMode}
      onDecision={decide}
    />
  );
}

/** Returns the latest unanswered AskUserQuestion or ExitPlanMode tool_use,
 *  or null if none is pending.  An "unanswered" tool_use is one whose id
 *  is missing from the state's toolResults map. */
type PendingInteractive =
  | { kind: "AskUserQuestion"; toolUseId: string; input: AskUserQuestionInput }
  | { kind: "ExitPlanMode"; toolUseId: string; input: ExitPlanModeInput };

function findPendingInteractive(state: AgentSessionState): PendingInteractive | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.role !== "assistant") continue;
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const block = m.blocks[j];
      if (block.type !== "tool_use") continue;
      // Narrow: ContentBlock union may include UnknownBlockData where
      // `id` is `unknown`; once we know `type === "tool_use"`, treat
      // it as ToolUseBlockData with a string id.
      const tu = block as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
      if (state.toolResults.has(tu.id)) continue;
      if (isAskUserQuestionToolUse(tu)) {
        return { kind: "AskUserQuestion", toolUseId: tu.id, input: tu.input as AskUserQuestionInput };
      }
      if (isExitPlanModeToolUse(tu)) {
        return { kind: "ExitPlanMode", toolUseId: tu.id, input: tu.input as ExitPlanModeInput };
      }
    }
  }
  return null;
}

interface NumberedMessage {
  message: RenderedMessage;
  turn: number;
  isFirstOfTurn: boolean;
}

/** Has the (possibly-streaming) assistant message produced any text yet?
 *  When false, the heartbeat cursor has nothing to attach to — that's
 *  exactly when the ThinkingIndicator earns its keep. */
function hasAnyTextBlock(msg: RenderedMessage | undefined): boolean {
  if (!msg) return false;
  for (const b of msg.blocks) {
    if (isTextBlock(b)) {
      const t = (b as { text?: string }).text;
      if (typeof t === "string" && t.length > 0) return true;
    }
  }
  return false;
}

/**
 * Walk the message list and assign each message a turn number.  A turn
 * starts at every user message and includes all subsequent assistant
 * messages until the next user message.
 *
 * Pure helper — exported below for testability.
 */
export function assignTurnNumbers(messages: RenderedMessage[]): NumberedMessage[] {
  const out: NumberedMessage[] = [];
  let turn = 0;
  for (const msg of messages) {
    if (msg.role === "user") {
      turn += 1;
      out.push({ message: msg, turn, isFirstOfTurn: true });
    } else {
      // assistant messages before any user message are treated as turn 1.
      const t = turn === 0 ? 1 : turn;
      if (turn === 0) turn = 1;
      const isFirst = !out.some((m) => m.turn === t);
      out.push({ message: msg, turn: t, isFirstOfTurn: isFirst });
    }
  }
  return out;
}

interface AgentHeaderProps {
  state: AgentSessionState;
  sessionId: string;
  workspacePathCount: number;
}

function AgentHeader({ state, sessionId, workspacePathCount }: AgentHeaderProps) {
  const model = state.initEvent?.model;
  const cwd = state.initEvent?.cwd;
  const rate = state.rateLimitInfo;
  const showRateNotice = rate && rate.status !== "allowed";
  const activity = deriveActivity(state);

  // The masthead reads as a publication flag.  Quiescent state lists
  // AGENT · model · cwd in tracked uppercase mono.  Active states swap
  // the model line for a running ticker (THINKING · 12s, RUNNING BASH · 4s)
  // so the user always knows whether Claude is alive and what it's doing.
  const dotState = !state.initialized
    ? "idle"
    : activity.status === "idle"
      ? "ready"
      : activity.status === "running"
        ? "running"
        : "thinking";

  const isWorking = state.initialized && activity.status !== "idle";
  const tickerLabel = !state.initialized
    ? "READY"
    : activity.status === "running"
      ? `RUNNING ${(activity.toolName ?? "TOOL").toUpperCase()}`
      : activity.status === "thinking"
        ? "THINKING"
        : activity.status === "awaiting"
          ? "AWAITING CLAUDE"
          : "READY";

  const cwdLabel = cwd ? cwd.split("/").pop() ?? cwd : null;

  return (
    <div className="agent-session-header">
      <div className="agent-session-header-left">
        <span
          className="agent-session-status-dot"
          data-state={dotState}
          aria-hidden="true"
        />
        <span className="agent-session-flag">AGENT</span>
        <span className="agent-session-flag-sep" aria-hidden="true">·</span>
        {isWorking ? (
          <>
            <span className="agent-session-ticker">{tickerLabel}</span>
            {activity.since !== null ? (
              <>
                <span className="agent-session-flag-sep" aria-hidden="true">·</span>
                <ElapsedCounter since={activity.since} />
              </>
            ) : null}
            {/* Stop button — sends a soft interrupt via the bridge's
                control protocol.  Bridge stays alive; just cancels the
                current turn.  Available whenever Claude is doing something
                we'd want to be able to cancel. */}
            <button
              type="button"
              className="agent-session-stop"
              onClick={() => {
                softInterruptAgent(sessionId).catch((err) =>
                  console.warn("[agent] soft-interrupt failed:", err),
                );
              }}
              title="Stop this turn (Esc)"
              aria-label="Stop the current turn"
            >
              ◼ STOP
            </button>
          </>
        ) : (
          <>
            {model ? (
              <>
                <span className="agent-session-model">{model}</span>
                {cwdLabel ? (
                  <>
                    <span className="agent-session-flag-sep" aria-hidden="true">·</span>
                    <span className="agent-session-cwd-name" title={cwd ?? undefined}>{cwdLabel}</span>
                  </>
                ) : null}
              </>
            ) : (
              <span className="agent-session-ticker">READY</span>
            )}
          </>
        )}
      </div>
      <div className="agent-session-header-right">
        {state.cumulativeCostUsd > 0 || state.cumulativeOutputTokens > 0 ? (
          <span
            className="agent-session-cost"
            title={`Session cost: $${state.cumulativeCostUsd.toFixed(4)}\nOutput tokens: ${state.cumulativeOutputTokens.toLocaleString()}`}
            aria-label={`session cost ${state.cumulativeCostUsd.toFixed(2)} dollars`}
          >
            {`$${formatCost(state.cumulativeCostUsd)}`}
            <span className="agent-session-cost-sep" aria-hidden="true"> · </span>
            {`${formatTokens(state.cumulativeOutputTokens)} out`}
          </span>
        ) : null}
        {showRateNotice ? (
          <span className="agent-rate-notice">Rate limit · {rate!.status}</span>
        ) : null}
        {cwd && workspacePathCount <= 1 ? (
          <span className="agent-session-cwd" title={cwd}>{cwd}</span>
        ) : null}
      </div>
    </div>
  );
}

/** Format cost for the masthead lozenge.  Always shows at least cents
 *  precision, more decimals for very small amounts so the user sees
 *  the meter actually moving on cheap turns. */
function formatCost(usd: number): string {
  if (usd >= 1) return usd.toFixed(2);
  if (usd >= 0.01) return usd.toFixed(3);
  return usd.toFixed(4);
}

/** Token count formatter — k for thousands, plain for under 1k. */
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/**
 * Live elapsed counter — shows how long the current activity has been in
 * flight, ticking once per second.  Helps the user distinguish "Claude is
 * actively working" from "the subprocess hung and I should kill the session".
 *
 * Uses a local `useState` interval rather than a global animation frame
 * because per-second precision is plenty here and keeps re-renders cheap.
 */
function ElapsedCounter({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span className="agent-session-elapsed" aria-live="polite">
      {formatElapsed(elapsed)}
    </span>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/**
 * Decide whether to surface the "Agent process exited" notice.
 *
 * Claude's `--print` subprocess exits cleanly after every turn, so a code-0
 * exit during an active conversation is *normal*.  We only show the notice
 * when:
 *
 *   1. The exit was non-zero (something actually broke), OR
 *   2. The exit happened before any messages exchanged (the user couldn't
 *      have triggered a normal turn-end yet).
 *
 * A signal-driven exit (e.g. SIGTERM during cleanup) is also surfaced.
 *
 * Pure helper — exported so the rendering test can pin the policy.
 */
export function shouldShowExitNotice(
  info: AgentExitPayload,
  messageCount: number,
): boolean {
  if (info.signal) return true;
  if (info.code !== null && info.code !== 0) return true;
  // Normal turn-end exit during a live conversation — hide.
  return messageCount === 0;
}

/** Classify an agent-subprocess exit into a friendlier label, peeking at
 *  the stderr text to recognize the common failure modes (lost session,
 *  bridge crashed, SDK aborted).  Used by the exit notice. */
export function classifyExit(
  info: AgentExitPayload,
  stderr: string,
): { label: string; kind: "no-conversation" | "signal" | "crash" | "exit" } {
  const lc = (stderr ?? "").toLowerCase();
  if (lc.includes("no conversation found")) {
    return {
      label: "Couldn't resume that conversation — Claude no longer has a record of it",
      kind: "no-conversation",
    };
  }
  if (info.signal) {
    return {
      label: `Agent process killed by signal ${info.signal}`,
      kind: "signal",
    };
  }
  if (info.code !== null && info.code !== 0) {
    return { label: "Agent process crashed", kind: "crash" };
  }
  return { label: "Agent process exited", kind: "exit" };
}

interface MessageRowProps {
  message: RenderedMessage;
  toolResults: Map<string, ToolResultBlockData>;
  /** Streaming-state slice from the message store (Phase 5). */
  streamingMessageId?: string | null;
  thinkingStartedAt?: Map<string, number>;
  thinkingElapsed?: Map<string, number>;
  /** Unused since the №-numbered gutter was removed.  Kept on the prop
   *  surface so callers (tests, the messages map) don't need to refactor;
   *  may come back for a different left-gutter treatment later. */
  turnNumber?: number;
  /** When true, this message renders the turn's timestamp in the left
   *  gutter.  False on continuation messages (the assistant response
   *  that follows the user prompt within the same turn). */
  isFirstOfTurn?: boolean;
}

export function MessageRow({
  message,
  toolResults,
  streamingMessageId = null,
  thinkingStartedAt,
  thinkingElapsed,
  isFirstOfTurn = true,
}: MessageRowProps) {
  // Find the index of the last text block — the heartbeat cursor only goes on
  // *that* block when this assistant message is the one currently streaming.
  const isStreamingMessage =
    message.role === "assistant" && streamingMessageId === message.id;
  let lastTextIdx = -1;
  if (isStreamingMessage) {
    for (let i = message.blocks.length - 1; i >= 0; i--) {
      if (isTextBlock(message.blocks[i])) {
        lastTextIdx = i;
        break;
      }
    }
  }

  // "Raw" toggle: assistant messages can flip between rendered markdown and
  // the literal text source.  Useful when Claude returns a markdown table or
  // a mermaid diagram and the user wants to grab/inspect the underlying
  // source.  User messages don't need this — what you typed is what you see.
  const [showRaw, setShowRaw] = useState(false);
  const rawText = message.role === "assistant" ? collectRawText(message) : "";

  return (
    <div
      className={`agent-message agent-message-${message.role}`}
      data-role={message.role}
      data-first-of-turn={isFirstOfTurn ? "true" : "false"}
    >
      <div className="agent-message-gutter" aria-hidden="true">
        {isFirstOfTurn ? (
          <span className="agent-message-time">{formatHHMMSS(message.timestamp)}</span>
        ) : null}
      </div>
      <div className="agent-message-body">
        {message.role === "assistant" && rawText ? (
          <MessageRawToggle showing={showRaw} onToggle={() => setShowRaw((s) => !s)} />
        ) : null}
        {showRaw ? (
          <MessageRawView text={rawText} />
        ) : (
          message.blocks.map((block, i) => (
            <BlockRenderer
              key={i}
              block={block}
              blockIndex={i}
              messageId={message.id}
              toolResults={toolResults}
              isStreamingTail={isStreamingMessage && i === lastTextIdx}
              thinkingStartedAt={thinkingStartedAt}
              thinkingElapsed={thinkingElapsed}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Hover-only chrome: a small "raw" button in the top-right of an assistant
 *  message body that toggles between rendered markdown and the literal text
 *  source.  Clicking it twice returns to the rendered view. */
function MessageRawToggle({ showing, onToggle }: { showing: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`agent-message-raw-toggle${showing ? " is-active" : ""}`}
      onClick={onToggle}
      aria-pressed={showing}
      title={showing ? "Show rendered" : "Show raw source"}
    >
      {showing ? "rendered" : "raw"}
    </button>
  );
}

/** Raw markdown view with a copy-to-clipboard button.  Editorial-engineering
 *  styling: no card chrome, just a hairline rule and a `<pre>` of the source. */
function MessageRawView({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access can fail in headless or restricted contexts; ignore.
    }
  };
  return (
    <div className="agent-message-raw">
      <button
        type="button"
        className="agent-message-raw-copy"
        onClick={onCopy}
        aria-label="Copy raw source"
        title="Copy"
      >
        {copied ? "copied" : "copy"}
      </button>
      <pre className="agent-message-raw-body">{text}</pre>
    </div>
  );
}

/** Concatenate all text-block content of a message into a single string.
 *  Tool-use / thinking blocks are intentionally excluded — the raw view is
 *  about the assistant's prose, not the structural events around it. */
function collectRawText(message: RenderedMessage): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    if (isTextBlock(block) && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

/**
 * Format a Unix ms timestamp as `HH:MM:SS` (zero-padded, 24-hour, local time).
 * Returns an empty string when the timestamp is undefined — the timestamp
 * slot stays in the DOM but renders blank, and is hover-only via CSS regardless.
 */
export function formatHHMMSS(timestamp: number | undefined): string {
  if (timestamp === undefined) return "";
  const d = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface BlockRendererProps {
  block: ContentBlock;
  blockIndex: number;
  messageId: string;
  toolResults: Map<string, ToolResultBlockData>;
  isStreamingTail?: boolean;
  thinkingStartedAt?: Map<string, number>;
  thinkingElapsed?: Map<string, number>;
}

function BlockRenderer({
  block,
  blockIndex,
  messageId,
  toolResults,
  isStreamingTail,
  thinkingStartedAt,
  thinkingElapsed,
}: BlockRendererProps) {
  if (isTextBlock(block)) {
    return <TextBlock block={block} isStreamingTail={isStreamingTail} />;
  }
  if (isThinkingBlock(block)) {
    const key = `${messageId}:${blockIndex}`;
    return (
      <ThinkingBlock
        block={block}
        startedAt={thinkingStartedAt?.get(key)}
        elapsedMs={thinkingElapsed?.get(key)}
      />
    );
  }
  if (isToolUseBlock(block)) {
    return (
      <ToolUseBlock
        block={block as ToolUseBlockData}
        result={toolResults.get(block.id)}
      />
    );
  }
  // tool_result blocks normally don't reach here (the store routes them into
  // `toolResults` instead). If one appears in a user message alongside text,
  // we fall through to the catch-all below.
  return (
    <pre className="agent-unknown-block">
      {safeStringify(block)}
    </pre>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
