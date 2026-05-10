import "../styles/components/agent/AgentSessionView.css";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
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
  isImageBlock,
} from "./types";
import { softInterruptAgent } from "../api/agent";
import { useSession } from "../state/SessionContext";
import { deriveActivity } from "./messageStore";
import type { AgentSessionState, RenderedMessage } from "./messageStore";
import { getOrCreateAgentSessionStore } from "./agentSessionStore";
import { TextBlock } from "./blocks/TextBlock";
import { ThinkingBlock } from "./blocks/ThinkingBlock";
import { ThinkingIndicator } from "./blocks/ThinkingIndicator";
import { ToolUseBlock } from "./blocks/ToolUseBlock";
import { ImageBlock } from "./blocks/ImageBlock";
import { ResultFooter } from "./blocks/ResultFooter";
import { AskUserQuestionCard } from "../components/AskUserQuestionCard";
import { ExitPlanModeCard } from "../components/ExitPlanModeCard";
import { PermissionRequestModal } from "../components/PermissionRequestModal";
import { PlanModeBanner } from "../components/PlanModeBanner";
import { TodoPanel } from "../components/TodoPanel";
import type { AskUserQuestionInput } from "../utils/askUserQuestion";
import type { ExitPlanModeInput } from "../utils/exitPlanMode";
import {
  buildPermResponse,
  type PermissionDecision,
} from "../utils/permissionRequest";
import { extractTodosFromMessages } from "../utils/todoStore";

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

/** Bridge from `useSyncExternalStore` into the per-session store.  Returning
 *  a stable snapshot reference (the store mutates via copy-on-write) keeps
 *  React from over-rendering.  The third argument is the SSR snapshot —
 *  vitest's render-tree path renders on the server first, so we pass the
 *  same accessor (the store's snapshot is plain data, no DOM/window
 *  dependencies). */
function useAgentSessionSnapshot(sessionId: string) {
  const store = getOrCreateAgentSessionStore(sessionId, listen);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return { snapshot, store };
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
  const sessionCtx = useSession();
  const { sendAgentEnvelope } = sessionCtx;
  // Long-lived per-session store: events keep streaming into reducer
  // state even when this component is unmounted (e.g., the user
  // switched to a different session in the sidebar), so the timeline
  // is intact when the view remounts.  See `agentSessionStore.ts`.
  const { snapshot, store } = useAgentSessionSnapshot(sessionId);
  const { state, stderr, exit: exitInfo } = snapshot;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Sticky-bottom flag: true when the user is already at (or very close
  // to) the bottom.  We only auto-scroll on new content while sticky;
  // if the user has scrolled up to read past output, leave them alone.
  const stickyBottomRef = useRef(true);

  // Track whether the user is at the bottom.  Updated on every scroll
  // event with a small tolerance — momentum scroll, sub-pixel rounding,
  // and cross-platform scrollbar sizes can leave a few pixels of error
  // even when the user is "at the bottom", so 24px is a safe margin.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const STICKY_THRESHOLD = 24;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickyBottomRef.current = distance <= STICKY_THRESHOLD;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll on new messages — but only when the user is at the bottom.
  // If they've scrolled up to re-read history, never yank them back.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!stickyBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [state.messages, state.resultEvent, exitInfo]);

  // Hooks below MUST run on every render — they sit above the
  // empty-state early return so the hook count never changes between
  // pre-init and post-first-message renders (see React #310).
  const todos = useMemo(
    () => extractTodosFromMessages(state.messages),
    [state.messages],
  );
  // Read the user's CURRENT intended mode from session state, not from
  // the bridge's stale init event.  When the user flips the chip mid-
  // session, the reducer updates `permission_mode` immediately, so the
  // modal can self-auto-allow even before the bridge has been told about
  // the change. Falls back to the init event for sessions that haven't
  // surfaced a session entry yet.
  const sessionEntryForPerm = sessionCtx.state.sessions[sessionId];

  if (!state.initialized && !exitInfo && state.messages.length === 0) {
    // Claude's `--print --input-format stream-json` mode doesn't emit anything
    // (not even the init event) until it receives the first user message on
    // stdin. So the "pre-init" state is just the user's empty inbox — invite
    // them to send their first message rather than implying we're stuck.
    //
    // Once messages.length > 0 (the user hit Send), we DROP this empty
    // state and fall through to the normal render — the user's echoed
    // message + the live thinking indicator give them feedback during
    // the bridge-spawn → init-arrives gap.
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

  // Decide whether to render the vintage thinking indicator.
  //
  // Two cases fire it:
  //   1. Post-init normal turn — Claude is thinking / running a tool /
  //      awaiting after a user message, and no streaming text has
  //      begun yet (the heartbeat cursor takes over once tokens start
  //      arriving on the assistant's reply).
  //   2. Pre-init FIRST turn — the user has sent their first message
  //      (state.messages.length > 0) but the bridge hasn't emitted
  //      init yet.  Without this, the user sees their echoed prompt
  //      and then dead silence until init arrives — which can be a
  //      noticeable beat on cold spawns.  The indicator fills the gap.
  const activity = deriveActivity(state);
  const isBootingFirstTurn = !state.initialized && state.messages.length > 0;
  const showThinkingIndicator =
    (state.initialized || isBootingFirstTurn)
    && (activity.status === "awaiting" || activity.status === "thinking" || activity.status === "running")
    && (state.streamingMessageId === null
      || !hasAnyTextBlock(
          state.messages.find(
            (m) => m.role === "assistant" && m.id === state.streamingMessageId,
          ),
        ));

  // ─── Interactive tools ───────────────────────────────────────────
  // AskUserQuestion / ExitPlanMode are dispatched via the
  // `_hermes_perm_request` stream from the bridge's canUseTool —
  // see <InteractivePermissionDispatcher /> below.  That's the SDK's
  // contract: the host injects answers as `updatedInput` rather than
  // writing a tool_result envelope.  No tool_use scanning needed here.
  // (`todos` and `sessionEntryForPerm` are computed via hooks above
  // the empty-state early return — keep that order.)
  const permissionMode =
    sessionEntryForPerm?.permission_mode
    ?? state.initEvent?.permissionMode
    ?? "default";

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
              streamingThinkingText={state.streamingThinkingText}
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
                onClick={() => store.clearExitNotice()}
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

          {/* All interactive tooling — AskUserQuestion, ExitPlanMode,
              and the generic permission modal — is driven by
              `_hermes_perm_request` envelopes from the bridge's
              canUseTool.  The dispatcher routes by toolName. */}
          <InteractivePermissionDispatcher
            sessionId={sessionId}
            permissionMode={permissionMode}
            sendAgentEnvelope={sendAgentEnvelope}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Bridge ⇄ frontend canUseTool dispatcher.
 *
 * Listens for `_hermes_perm_request` envelopes on the agent stream and
 * routes each by tool name:
 *
 *   AskUserQuestion → <AskUserQuestionCard />     allow → updatedInput
 *                                                  with answers record;
 *                                                  deny → user declined
 *   ExitPlanMode    → <ExitPlanModeCard />        allow → SDK runs the
 *                                                  tool, mode flips;
 *                                                  deny → SDK ends turn
 *                                                  with feedback message
 *   else            → <PermissionRequestModal />  generic allow/deny
 *
 * The user's decision goes back as `_hermes_perm_response` via
 * `sendAgentEnvelope` (retry-on-not-found, M10) so we don't drop a
 * decision when the bridge has exited between turns.
 */
function InteractivePermissionDispatcher({
  sessionId,
  permissionMode,
  sendAgentEnvelope,
}: {
  sessionId: string;
  permissionMode: string;
  sendAgentEnvelope: (sessionId: string, envelope: unknown) => Promise<void>;
}) {
  // Pending perm request lives in the long-lived store now (fix C1)
  // so a session-switch unmount can't strand the bridge waiting on
  // canUseTool.  The dispatcher just reads from the store and writes
  // back via clearPendingPermRequest after a decision.
  const { snapshot, store } = useAgentSessionSnapshot(sessionId);
  const request = snapshot.pendingPermRequest;

  // Per-request latch for the bypass auto-allow effect (fix B1).
  // React StrictMode + the store's snapshot churn can re-fire the
  // effect with the SAME closure-captured `request`, which used to
  // send the response envelope multiple times.  Tracking the last
  // request id we've sent for makes the effect idempotent per id.
  const lastBypassSentId = useRef<string | null>(null);
  // Per-request latch for in-flight IPC (fix B4).  A boolean shared
  // across requests would lock out the FIRST click on request B
  // while request A's send is still pending.  Keying by id means
  // each request gets its own dedup window.
  const inFlightForId = useRef<string | null>(null);
  // B3 — pin the send-error to the request id it came from so a stale
  // banner from request A can't leak into the render of an unrelated
  // request B.  The banner only renders when `sendError.requestId`
  // matches the currently-displayed request.
  const [sendError, setSendError] = useState<{ requestId: string; message: string } | null>(null);

  // Defense-in-depth: if the user is in bypass mode and a perm request is
  // sitting in the store, auto-resolve it as allow + clear it.  This catches
  // the race where the bridge dispatched a request milliseconds before the
  // setPermissionMode control op landed.  The PermissionRequestModal also
  // self-auto-allows on bypass (cosmetic), but doing it here means the
  // envelope never even gets to render.
  //
  // B1 — claim the latch DURING RENDER (not in the effect) so the early-
  // return below can suppress the modal on the SAME PASS.  Otherwise the
  // modal mounts before our effect runs and self-auto-allows a duplicate
  // envelope (the effect's send + the modal's onMount call both fire).
  // Refs are safe to mutate during render as long as the mutation is
  // purely a closure latch with no hook-ordering dependency.
  const willBypassAutoAllow =
    !!request
    && permissionMode === "bypassPermissions"
    && lastBypassSentId.current !== request.id;
  if (willBypassAutoAllow && request) {
    lastBypassSentId.current = request.id;
  }
  useEffect(() => {
    if (!willBypassAutoAllow || !request) return;
    const cached = request;
    // B2 — AskUserQuestion's `canUseTool` contract requires an
    // `answers` record on `updatedInput`; sending plain `allow` with
    // no payload makes the SDK treat the answer set as empty.
    // Synthesize a sensible default by picking the first option for
    // each question so bypass mode preserves the auto-allow promise
    // without breaking the tool contract.
    let decision: PermissionDecision = { kind: "allow" };
    if (request.toolName === "AskUserQuestion") {
      const askInput = request.input as unknown as AskUserQuestionInput;
      const answers: Record<string, string> = {};
      const questions = Array.isArray(askInput?.questions)
        ? askInput.questions
        : [];
      for (const q of questions) {
        const first = q?.options?.[0]?.label;
        if (typeof q?.question === "string") {
          answers[q.question] = typeof first === "string" ? first : "";
        }
      }
      decision = {
        kind: "allow",
        updatedInput: { ...(askInput as unknown as Record<string, unknown>), answers },
      };
    }
    const env = buildPermResponse(request.id, decision);
    // B1b — clear AFTER send succeeds so a failed send doesn't strand
    // the bridge.  On failure, re-inject the request and surface a
    // banner so the user can decide manually (mirrors decide()'s
    // recovery path).
    sendAgentEnvelope(sessionId, env)
      .then(() => {
        store.clearPendingPermRequest();
      })
      .catch((err) => {
        console.warn("[perm] bypass auto-allow send failed:", err);
        // Restore the request so the bridge isn't stranded — the user
        // can decide manually via the modal once it re-renders.  We
        // intentionally do NOT release `lastBypassSentId` here: the
        // request is back in the store and the effect would otherwise
        // re-fire and loop forever auto-retrying a broken send.
        store.injectEvent(cached as unknown as AgentEvent);
        setSendError({
          requestId: cached.id,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, [willBypassAutoAllow, request, permissionMode, sessionId, sendAgentEnvelope, store]);

  if (!request) return null;
  // B1 — once the bypass effect has latched for this request, avoid
  // rendering the interactive cards / modal underneath: the
  // PermissionRequestModal also self-auto-allows on bypass mount,
  // which would queue a SECOND envelope for the same id before our
  // optimistic clear lands.  Render nothing during the auto-allow
  // window — and for AskUserQuestion too, where the bypass effect
  // synthesizes the answer envelope itself.
  if (
    permissionMode === "bypassPermissions"
    && lastBypassSentId.current === request.id
  ) {
    return null;
  }

  function decide(decision: PermissionDecision) {
    if (!request) return;
    // Latch immediately so a double-click on the modal can't fire
    // two `_hermes_perm_response` envelopes for the same request id
    // (fix H6).  Keyed by request id (fix B4) so an in-flight send
    // for request A doesn't silently drop the first click on
    // request B.
    if (inFlightForId.current === request.id) return;
    inFlightForId.current = request.id;
    const env = buildPermResponse(request.id, decision);
    // Optimistically clear so the modal closes immediately; if the
    // send fails we restore the request via the store and surface
    // an error banner (also fix H6 — used to be silent console.warn).
    const cached = request;
    store.clearPendingPermRequest();
    setSendError(null);
    sendAgentEnvelope(sessionId, env)
      .catch((err) => {
        console.warn("[perm] send failed:", err);
        // Re-surface the request — the bridge is still waiting and
        // the user needs another shot at deciding.
        store.injectEvent(cached as unknown as AgentEvent);
        setSendError({
          requestId: cached.id,
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        if (inFlightForId.current === cached.id) {
          inFlightForId.current = null;
        }
      });
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
  }

  // Banner that surfaces a failed `_hermes_perm_response` send.  The
  // bridge is still waiting on canUseTool, so we re-show the modal
  // (decide() restored the request via the store) and prepend a
  // visible error so the user understands why the click didn't land.
  // B3 — only show the banner when the error belongs to the request
  // currently on screen; otherwise a stale failure from request A
  // would mis-attribute itself to an unrelated request B.
  const errorBanner = sendError && sendError.requestId === request.id ? (
    <div className="agent-perm-error" role="alert">
      Couldn't deliver your decision: {sendError.message}.  Try again — the
      agent is still waiting.
    </div>
  ) : null;

  if (request.toolName === "AskUserQuestion") {
    const input = request.input as unknown as AskUserQuestionInput;
    return (
      <>
        {errorBanner}
        <AskUserQuestionCard
          dialogId={request.id}
          input={input}
          onAllow={(updatedInput) => decide({ kind: "allow", updatedInput })}
          onDeny={() => decide({ kind: "deny", message: "User cancelled the question" })}
        />
      </>
    );
  }

  if (request.toolName === "ExitPlanMode") {
    const input = request.input as unknown as ExitPlanModeInput;
    return (
      <>
        {errorBanner}
        <ExitPlanModeCard
          dialogId={request.id}
          input={input}
          permissionMode={permissionMode}
          onAllow={() => decide({ kind: "allow" })}
          onDeny={(feedback) =>
            decide({
              kind: "deny",
              message: feedback === "" ? "User rejected the plan" : feedback,
            })
          }
        />
      </>
    );
  }

  return (
    <>
      {errorBanner}
      <PermissionRequestModal
        request={request}
        permissionMode={permissionMode}
        onDecision={decide}
      />
    </>
  );
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
    ? "Ready"
    : activity.status === "running"
      ? `Running ${activity.toolName ?? "tool"}`
      : activity.status === "thinking"
        ? "Thinking"
        : activity.status === "awaiting"
          ? "Awaiting Claude"
          : "Ready";

  const cwdLabel = cwd ? cwd.split("/").pop() ?? cwd : null;

  // Three-zone grid: [status] [title] [meta].  Title is the only
  // flexible cell; it truncates with ellipsis on narrow panes so the
  // meta zone (cost · STOP) never gets pushed off-screen.  STOP lives
  // in the meta zone — far from the title's growth axis.
  const showCwdFull = cwd && workspacePathCount <= 1;
  return (
    <div className="agent-session-header">
      <div className="agent-session-header-status">
        <span
          className="agent-session-status-dot"
          data-state={dotState}
          aria-hidden="true"
        />
        <span className="agent-session-flag">Agent</span>
      </div>

      <div className="agent-session-header-title">
        {isWorking ? (
          <>
            <span className="agent-session-ticker">{tickerLabel}</span>
            {activity.since !== null ? (
              <>
                <span className="agent-session-flag-sep" aria-hidden="true">·</span>
                <ElapsedCounter since={activity.since} />
              </>
            ) : null}
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
        {showCwdFull ? (
          <span className="agent-session-cwd" title={cwd}>{cwd}</span>
        ) : null}
      </div>

      <div className="agent-session-header-meta">
        {state.cumulativeOutputTokens > 0 ? (
          <span
            className="agent-session-cost"
            title={`Output tokens: ${state.cumulativeOutputTokens.toLocaleString()}`}
            aria-label={`${state.cumulativeOutputTokens.toLocaleString()} output tokens`}
          >
            <span className="agent-session-cost-tokens">{`${formatTokens(state.cumulativeOutputTokens)} out`}</span>
          </span>
        ) : null}
        {showRateNotice ? (
          <span className="agent-rate-notice">Rate limit · {rate!.status}</span>
        ) : null}
        {isWorking ? (
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
            ◼ Stop
          </button>
        ) : null}
      </div>
    </div>
  );
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
  /** Fallback text for thinking blocks whose `block.thinking` field
   *  arrived empty (newer SDK / model behaviour with partial messages). */
  streamingThinkingText?: Map<string, string>;
  /** No longer used by the speaker-chip layout but kept on the prop
   *  surface so existing callers / tests don't break. */
  turnNumber?: number;
  /** When true, this is the first message of its turn — the speaker
   *  chip carries the timestamp.  Continuation messages (assistant
   *  replies after a user prompt within the same turn) suppress the
   *  timestamp so the eye groups the turn as one unit. */
  isFirstOfTurn?: boolean;
}

export function MessageRow({
  message,
  toolResults,
  streamingMessageId = null,
  thinkingStartedAt,
  thinkingElapsed,
  streamingThinkingText,
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
  const speakerName = message.role === "user" ? "You" : "Hermes";

  return (
    <div
      className={`agent-message agent-message-${message.role}`}
      data-role={message.role}
      data-first-of-turn={isFirstOfTurn ? "true" : "false"}
    >
      <div className="agent-message-speaker">
        <span
          className="agent-message-avatar"
          data-role={message.role}
          aria-hidden="true"
        >
          {message.role === "user" ? <UserIcon /> : <BotIcon />}
        </span>
        <span className="agent-message-name">{speakerName}</span>
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
              streamingThinkingText={streamingThinkingText}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Speaker-chip icons.  Drawn inline with `currentColor` so each
 *  theme's accent (via the brass-remap landed in #254) paints the
 *  glyph — green-phosphor on hacker, cyan on tron, terracotta on
 *  designer, etc.  Sized to fit the 24px avatar chip. */
function BotIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Antenna */}
      <line x1="8" y1="2.5" x2="8" y2="4.5" />
      <circle cx="8" cy="2" r="0.7" fill="currentColor" stroke="none" />
      {/* Head */}
      <rect x="3" y="4.5" width="10" height="8" rx="2" />
      {/* Eyes */}
      <circle cx="6" cy="8.5" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8.5" r="0.85" fill="currentColor" stroke="none" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Head */}
      <circle cx="8" cy="5.5" r="2.6" />
      {/* Shoulders */}
      <path d="M3 13.5c0-2.6 2.2-4.3 5-4.3s5 1.7 5 4.3" />
    </svg>
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
  streamingThinkingText?: Map<string, string>;
}

function BlockRenderer({
  block,
  blockIndex,
  messageId,
  toolResults,
  isStreamingTail,
  thinkingStartedAt,
  thinkingElapsed,
  streamingThinkingText,
}: BlockRendererProps) {
  if (isTextBlock(block)) {
    return <TextBlock block={block} isStreamingTail={isStreamingTail} />;
  }
  if (isThinkingBlock(block)) {
    const key = `${messageId}:${blockIndex}`;
    // Fallback: when the consolidated `assistant` event ships the
    // thinking block as `{ thinking: "" }` (newer SDK / model
    // behaviour under `includePartialMessages: true`), the actual
    // text only ever arrived via `thinking_delta` partials and is
    // now in the streaming accumulator.  Render whichever is non-empty.
    const fallback = streamingThinkingText?.get(key) ?? "";
    const effective = block.thinking || fallback;
    const blockToRender =
      effective === block.thinking ? block : { ...block, thinking: effective };
    return (
      <ThinkingBlock
        block={blockToRender}
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
  if (isImageBlock(block)) {
    return <ImageBlock block={block} />;
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
