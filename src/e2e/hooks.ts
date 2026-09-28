/**
 * Test-only hooks for the automation bridge (src-tauri/src/e2e_bridge.rs).
 *
 * Loaded only when the frontend is built with VITE_HERMES_E2E=1, so normal
 * builds never contain this file. It exposes READ access to what the terminal
 * is showing — the terminal draws to a canvas, so its text is not in the DOM.
 * Everything else (clicking, typing) goes through the real DOM on purpose.
 * The one write is a crash switch, used to prove crash containment.
 */
import { pool, getFocusedSessionId } from "../terminal/pool";
import { armCrash } from "../components/CrashProbe";
import { loadedViews } from "../utils/lazyView";
import { getI18nSnapshot } from "../i18n/registry";
import { parseSessionEvent } from "../agent/contract/events";
import {
  dispatchSessionEvent,
  getSessionEventSnapshot,
  sessionIdsWithEvents,
  subscribeSessionEvents,
} from "../agent/contract/sessionEventStore";
import { listInboxItems, raiseInboxItem, resolveInboxItem } from "../agent/contract/inbox";
import type { InboxRaise } from "../agent/contract/inbox";
import { getAttentionSummary, getSessionStatus } from "../agent/status/attentionStore";
import { attentionDebug } from "../attention/debug";
import { setWindowFocusOverride } from "../attention/windowFocus";
import { listReviewChecks, reviewInputFromPatch, runReviewChecks } from "../agent/contract/reviewChecks";
import { clearFakeTurns, injectFakeTurns, type InjectedTurn } from "../review/turnSource";
import { getReviewState } from "../review/reviewStore";
import { setFakeLandTurnsForTest } from "../land/turnSource";
import type { Turn } from "../agent/contract/turns";
import { defaultDoneWhen, listRecipeRuns } from "../state/worktreeRecipes";
import { checksForTurn, getDoneWhenSnapshot } from "../doneWhen/store";
import { sendFailuresBack } from "../doneWhen/controller";
import { getTrackState, trackWorktreePaths } from "../track/store";

/** Notifications each watched session's subscriber received (C0 proof). */
const sessionEventWatches = new Map<string, { count: number; unsubscribe: () => void }>();

function readLines(sessionId: string): string[] | null {
  const entry = pool.get(sessionId);
  if (!entry) return null;
  const buffer = entry.terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    // A wrapped row continues the previous logical line.
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const hooks = {
  /**
   * Make one part of the UI throw on its next render, once — to prove the
   * crash stays inside it. Targets: "pane:<sessionId>",
   * "block:<messageId>:<blockIndex>".
   */
  crash: (target: string): void => armCrash(target),
  /** On-demand views whose code has been fetched so far (e.g. "Settings"). */
  loadedViews: (): string[] => loadedViews(),
  /** Languages whose translations are in memory ("en" is built in). */
  loadedLanguages: (): string[] =>
    getI18nSnapshot()
      .languages.filter((l) => Object.keys(l.messages).length > 0)
      .map((l) => l.locale)
      .sort(),
  /** Session ids that currently have a terminal. */
  terminalIds: (): string[] => [...pool.keys()],
  /** The session whose terminal has keyboard focus inside the app. */
  focusedSessionId: (): string | null => getFocusedSessionId(),
  /** Logical lines of the terminal buffer (scrollback + screen). */
  readTerminal: (sessionId: string): string[] | null => readLines(sessionId),
  terminalInfo: (sessionId: string) => {
    const entry = pool.get(sessionId);
    if (!entry) return null;
    return {
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
      attached: entry.attached,
      opened: entry.opened,
      cwd: entry.cwd,
      phase: entry.sessionPhase,
    };
  },
  /**
   * N10 (updates wait for idle): force `useAutoUpdater` to see an update as
   * ready, without reaching a real update server. `useAutoUpdater` reads
   * this override and fabricates a download/install that never touches the
   * network or the real installer — the real busy-gating logic still runs
   * for real (a real running session still blocks it).
   */
  forceUpdateReady: (version: string, body = ""): void => {
    window.__HERMES_TEST_UPDATE__ = window.__HERMES_TEST_UPDATE__ ?? {
      forcedUpdate: null,
      installCalls: 0,
      relaunchCalls: 0,
    };
    window.__HERMES_TEST_UPDATE__.forcedUpdate = { version, body };
  },
  /** Read back how many times the (faked) install/relaunch pipeline ran. */
  updateTestState: () => window.__HERMES_TEST_UPDATE__ ?? null,

  // ── C0 contracts: session events and the inbox (docs/adr/004) ──────
  /**
   * Feed one SessionEvent to a session, exactly as the Rust channel would.
   * The event goes through the same validating parser; a malformed one is
   * refused (false) and changes nothing.
   */
  injectSessionEvent: (sessionId: string, event: unknown): boolean => {
    const parsed = parseSessionEvent(event);
    if (!parsed || typeof sessionId !== "string" || sessionId === "") return false;
    dispatchSessionEvent(sessionId, parsed);
    return true;
  },
  /** The snapshot the app reads for a session (useSessionEvents). */
  sessionEventSnapshot: (sessionId: string) => getSessionEventSnapshot(sessionId),
  sessionEventSessionIds: (): string[] => sessionIdsWithEvents(),
  /** Subscribe to a session like a component would; count the wake-ups. */
  watchSessionEvents: (sessionId: string): void => {
    if (sessionEventWatches.has(sessionId)) return;
    const watch = { count: 0, unsubscribe: () => {} };
    watch.unsubscribe = subscribeSessionEvents(sessionId, () => {
      watch.count++;
    });
    sessionEventWatches.set(sessionId, watch);
  },
  sessionEventNotifications: (sessionId: string): number => sessionEventWatches.get(sessionId)?.count ?? -1,
  unwatchSessionEvents: (sessionId: string): void => {
    sessionEventWatches.get(sessionId)?.unsubscribe();
    sessionEventWatches.delete(sessionId);
  },
  raiseInboxItem: (input: InboxRaise) => raiseInboxItem(input),
  resolveInboxItem: (id: string): boolean => resolveInboxItem(id),
  inboxItems: () => listInboxItems(),

  // ── F10: the status each session shows (docs/adr/004 §1) ───────────
  /** The derived status the sidebar and the status strip render. */
  sessionStatus: (sessionId: string) => getSessionStatus(sessionId),
  /** Every session's status at a glance: counts and who needs a person. */
  attentionSummary: () => getAttentionSummary(),
  // ── F12 / N16: attention inbox ─────────────────────────────────────
  /**
   * Say whether the app window has the keyboard focus (null: ask the
   * window). A hands-free test must not take the focus from whoever uses
   * the machine, so "you are looking at this window" is stated here.
   */
  setWindowFocused: (value: boolean | null): void => setWindowFocusOverride(value),
  /** What the attention center decided and asked the OS for, oldest first. */
  attentionState: () => ({
    decisions: [...(attentionDebug.notifier?.log() ?? [])],
    os: [...attentionDebug.os],
    away: attentionDebug.away.map((e) => ({ payload: e.payload, result: e.result })),
    badge: [...attentionDebug.badge],
    keepAwake: [...attentionDebug.keepAwake],
  }),
  // ── F36: review checks (the seam F21's Review Desk runs) ──────────
  /** Checks registered so far (by plugins through review.registerCheck). */
  reviewChecks: () => listReviewChecks(),
  /**
   * Run every registered check over a diff, the way the Review Desk runs
   * them over a turn's patch (get_turn_diff). Stands in for F21 until it lands.
   */
  runReviewChecks: (sessionId: string, turn: number | null, patch: string, timeoutMs?: number) =>
    runReviewChecks(reviewInputFromPatch(sessionId, turn, patch), { timeoutMs }),
  // ── F21 Review Desk: fake turns while the ledger (F20) is not filled ──
  /** Give a session a turn ledger (turn + patch), as F20 will record it. */
  injectTurns: (sessionId: string, turns: InjectedTurn[]): void => injectFakeTurns(sessionId, turns),
  clearTurns: (sessionId?: string): void => clearFakeTurns(sessionId),
  /** What the desk keeps for a repository: viewed files, comments, deliveries. */
  reviewState: (repoPath: string) => getReviewState(repoPath),
  // ── F22 Land sheet: stand in for the turn ledger (F20) ─────────────
  /** The turns (and each turn's diff) the Land sheet reads for a session. */
  setFakeLandTurns: (sessionId: string, turns: Array<{ turn: Turn; patch: string }>): void =>
    setFakeLandTurnsForTest(sessionId, turns),
  // ── F26 worktree recipes ───────────────────────────────────────────
  /** Recipe runs the panel shows (state, log lines, ports, failure). */
  worktreeRecipeRuns: () => listRecipeRuns(),
  /** The done_when checks a session's worktree.toml declared. */
  defaultDoneWhen: (sessionId: string) => defaultDoneWhen(sessionId),
  // ── F27 Done-When: what the chip reads, and the result kept per turn ──
  doneWhenSnapshot: (sessionId: string) => getDoneWhenSnapshot(sessionId),
  doneWhenForTurn: (sessionId: string, n: number) => checksForTurn(sessionId, n),
  /** What "Send failures back" does when clicked now (F27 step 7 asks with
   *  no agent running, where it must refuse). */
  doneWhenSendBack: (sessionId: string) => sendFailuresBack(sessionId),
  // ── F28 Feature Tracks: what the store holds for a worktree ────────
  trackState: (worktreePath: string) => getTrackState(worktreePath),
  trackWorktreePaths: (): string[] => trackWorktreePaths(),
};

export type HermesE2EHooks = typeof hooks;

(window as unknown as { __HERMES_E2E__?: HermesE2EHooks }).__HERMES_E2E__ = hooks;
