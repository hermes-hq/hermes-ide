/**
 * Test-only hooks for the automation bridge (src-tauri/src/e2e_bridge.rs).
 *
 * Loaded only when the frontend is built with VITE_HERMES_E2E=1, so normal
 * builds never contain this file. It exposes READ access to what the terminal
 * is showing — the terminal draws to a canvas, so its text is not in the DOM.
 * Everything else (clicking, typing) goes through the real DOM on purpose.
 * The one write is a crash switch, used to prove crash containment.
 */
import { pool, getFocusedSessionId, isWebglAvailable, webglSessionIds, focusTerminal } from "../terminal/pool";
import { createTerminal } from "../terminal/TerminalPool";
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
import { stripStatus } from "../components/SessionStatusStrip";
import { userInputTimes } from "../agent/status/userInput";
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
import { getAllOverlaps, setTurnSourceForTest } from "../fleet/radarStore";
import { getFleetCaps } from "../fleet/fleetSettings";
import { getOccupancy, listQueuedTasks } from "../fleet/taskQueue";
import { getAllLoads } from "../fleet/fleetLoad";
import { FEATURE_FLAGS, getFeatureFlagOverride, getReleaseChannel, isFeatureFlagEnabled } from "../featureFlags";
import { PLATFORM } from "../utils/platform";
import { getE2ESessionBridge } from "./sessionBridge";
import { agentLaunchOptions } from "../agent/capabilities/choice";
import { createProject, getProjectsOrdered } from "../api/projects";
import { getDoctorState } from "../launcher/doctorStore";

/** A fake turn for the fake ledger: its number and what it changed. */
interface FakeTurn {
  n: number;
  paths?: string[];
  patch?: string;
}
import { listen } from "@tauri-apps/api/event";
import { GALLERY_EVENT } from "./DialogGalleryHost";
import { WHATS_NEW_PREVIEW_STORAGE_KEY } from "../components/startupDialogSettings";

/** Output each watched session received (F24 throughput). */
const outputWatches = new Map<
  string,
  { chunks: number; bytes: number; first: number; last: number; unlisten: () => void }
>();

/** What `recordSession` keeps per session (STATUS measurement). */
interface Recording {
  output: { t: number; d: string }[];
  events: { t: number; event: unknown }[];
  shown: { t: number; derived: { kind: string; confidence: string; source: string | null }; strip: { kind: string; confidence: string; source: string } }[];
  version: number;
  unlisten: (() => void)[];
}
const recordings = new Map<string, Recording>();

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
   * 2.0 launch contract: start a terminal agent with a model, effort and
   * account exactly as the launcher does (create_session with agentLaunch,
   * through the helper), and show it. Returns the new session's id.
   */
  launchWithChoice: async (opts: {
    agentId: string;
    task?: string;
    cwd?: string;
    label?: string;
    modelId?: string;
    effort?: string | null;
    accountId?: string;
    purpose?: "agent" | "login";
    /** Extra arguments after the agent's own (the launcher's extra args). */
    suffix?: string;
  }): Promise<string | null> => {
    const bridge = getE2ESessionBridge();
    if (!bridge) throw new Error("the session provider has not registered its e2e bridge");
    const launch = agentLaunchOptions({ modelId: opts.modelId ?? "default", effort: opts.effort ?? null, accountId: opts.accountId ?? "default" });
    // Like the launcher: the repository is a Hermes project of the session.
    let projectIds: string[] | undefined;
    if (opts.cwd) {
      const known = (await getProjectsOrdered()).find((p) => p.path.replace(/[\\/]+$/, "") === opts.cwd!.replace(/[\\/]+$/, ""));
      projectIds = [known ? known.id : (await createProject(opts.cwd, null)).id];
    }
    const session = await bridge.createSession({
      aiProvider: opts.agentId,
      mode: "terminal",
      label: opts.label ?? opts.task ?? opts.agentId,
      workingDirectory: opts.cwd,
      projectIds,
      initialPrompt: opts.task,
      customSuffix: opts.suffix,
      agentLaunch: { ...launch, purpose: opts.purpose ?? "agent" },
    });
    if (!session) return null;
    bridge.show(session.id);
    return session.id;
  },
  /**
   * Every feature flag as the app resolved it at startup: on or off, and
   * the override when one is set; with the release channel and platform.
   */
  featureFlags: () => ({
    channel: getReleaseChannel(),
    platform: PLATFORM,
    flags: Object.fromEntries(FEATURE_FLAGS.map((f) => [f.id, { on: isFeatureFlagEnabled(f.id), override: getFeatureFlagOverride(f.id) ?? null }])),
  }),
  /** The agent doctor's shared answer (rows, loading, error), as the launcher reads it. */
  doctorState: () => getDoctorState(),
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
  /** Ask a terminal to take the keyboard, as a pane that becomes focused or
   *  attaches does (the real path, focusTerminal). */
  focusTerminal: (sessionId: string): void => focusTerminal(sessionId),
  /**
   * Give a session id its terminal before the backend creates the session
   * (what New Session does), so a scenario can start a session in a folder
   * the wizard does not offer with `invoke("create_session", { sessionId })`
   * and still read everything its terminal prints.
   */
  prepareTerminal: (sessionId: string): Promise<void> => createTerminal(sessionId, ""),
  /** The session whose terminal has keyboard focus inside the app. */
  focusedSessionId: (): string | null => getFocusedSessionId(),
  /** Logical lines of the terminal buffer (scrollback + screen). */
  readTerminal: (sessionId: string): string[] | null => readLines(sessionId),
  /** The last `count` rows of the buffer, cheap enough to poll during a
   *  flood of output (F24 throughput). Wrapped rows are not joined. */
  terminalTail: (sessionId: string, count = 5): string[] | null => {
    const entry = pool.get(sessionId);
    if (!entry) return null;
    const buffer = entry.terminal.buffer.active;
    const rows: string[] = [];
    for (let i = Math.max(0, buffer.length - count); i < buffer.length; i++) {
      rows.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    return rows;
  },
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
      /** F24: this terminal holds a WebGL context right now. */
      webgl: entry.webgl !== null,
      /** Canvases the terminal's renderer put on its screen (WebGL only). */
      canvases: entry.container.querySelectorAll(".xterm-screen canvas").length,
    };
  },
  /** F24: sessions whose terminal holds a WebGL context, and whether this
   *  web view can create one at all. */
  graphicsContexts: () => ({ available: isWebglAvailable(), sessions: webglSessionIds() }),
  /**
   * F24 throughput: count the output chunks the backend delivers to one
   * session (a second listener next to the terminal's own), so a slow flood
   * can be told apart: slow delivery, or a slow screen.
   */
  watchOutput: async (sessionId: string): Promise<void> => {
    outputWatches.get(sessionId)?.unlisten();
    const watch = { chunks: 0, bytes: 0, first: 0, last: 0, unlisten: () => {} };
    outputWatches.set(sessionId, watch);
    watch.unlisten = await listen<string>(`pty-output-${sessionId}`, (event) => {
      const now = performance.now();
      if (watch.chunks === 0) watch.first = now;
      watch.last = now;
      watch.chunks++;
      watch.bytes += Math.floor((event.payload.length * 3) / 4);
    });
  },
  outputStats: (sessionId: string) => {
    const w = outputWatches.get(sessionId);
    return w ? { chunks: w.chunks, bytes: w.bytes, spanMs: Math.round(w.last - w.first) } : null;
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
  /** A plain shell session (no agent), shown in the focused pane. Returns its id. */
  newTerminal: async (opts: { label?: string; cwd?: string } = {}): Promise<string | null> => {
    const bridge = getE2ESessionBridge();
    if (!bridge) throw new Error("the session provider has not registered its e2e bridge");
    const session = await bridge.createSession({ mode: "terminal", label: opts.label, workingDirectory: opts.cwd });
    if (!session) return null;
    bridge.show(session.id);
    return session.id;
  },
  /**
   * UI-D: open one of the dialogs whose real trigger needs state a test run
   * cannot make cheaply (src/e2e/DialogGallery.tsx lists them), or close it
   * with null. The dialog is the app's own component, in the app's providers.
   */
  showDialog: (name: string | null): void => {
    if (name === null) window.localStorage.removeItem(WHATS_NEW_PREVIEW_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent(GALLERY_EVENT, { detail: name }));
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
  /**
   * Status measurement (STATUS track): from now on, keep everything one
   * session receives with the time it arrived: every output chunk (base64,
   * as the backend sends it), every session event, and what the sidebar
   * (deriveStatus) and the status strip then show. Read back with
   * `recording(sessionId, from)`; nothing here changes what the app does.
   */
  recordSession: async (sessionId: string): Promise<void> => {
    if (recordings.has(sessionId)) return;
    const rec: Recording = { output: [], events: [], shown: [], version: getSessionEventSnapshot(sessionId).version, unlisten: [] };
    recordings.set(sessionId, rec);
    const noteShown = (t: number) => {
      const d = getSessionStatus(sessionId);
      const s = stripStatus(getSessionEventSnapshot(sessionId), pool.get(sessionId)?.sessionPhase ?? "", userInputTimes(sessionId));
      const last = rec.shown[rec.shown.length - 1];
      const row = { t, derived: { kind: d.kind, confidence: d.confidence, source: d.source }, strip: { kind: s.status.kind, confidence: s.status.confidence, source: s.source } };
      if (last && JSON.stringify(last.derived) === JSON.stringify(row.derived) && JSON.stringify(last.strip) === JSON.stringify(row.strip)) return;
      rec.shown.push(row);
    };
    rec.unlisten.push(
      subscribeSessionEvents(sessionId, () => {
        const t = Date.now();
        const snap = getSessionEventSnapshot(sessionId);
        const fresh = Math.min(snap.version - rec.version, snap.events.length);
        for (const e of snap.events.slice(snap.events.length - fresh)) rec.events.push({ t, event: e });
        rec.version = snap.version;
        noteShown(t);
      }),
    );
    rec.unlisten.push(
      await listen<string>(`pty-output-${sessionId}`, (event) => {
        rec.output.push({ t: Date.now(), d: event.payload });
      }),
    );
    noteShown(Date.now());
  },
  recording: (sessionId: string, from: { output?: number; events?: number; shown?: number } = {}) => {
    const rec = recordings.get(sessionId);
    if (!rec) return null;
    return {
      output: rec.output.slice(from.output ?? 0),
      events: rec.events.slice(from.events ?? 0),
      shown: rec.shown.slice(from.shown ?? 0),
      counts: { output: rec.output.length, events: rec.events.length, shown: rec.shown.length },
    };
  },
  stopRecording: (sessionId: string): void => {
    for (const u of recordings.get(sessionId)?.unlisten ?? []) u();
    recordings.delete(sessionId);
  },
  unwatchSessionEvents: (sessionId: string): void => {
    sessionEventWatches.get(sessionId)?.unsubscribe();
    sessionEventWatches.delete(sessionId);
  },
  raiseInboxItem: (input: InboxRaise) => raiseInboxItem(input),

  // ── 2.0 fleet controls (F31, F37, N22) ─────────────────────────────
  /**
   * Answer the turn ledger (listTurns / getTurnDiff) from fake turns, for
   * as long as the app runs, until F20 fills the real one. A turn without
   * `paths` is read from its `patch`. Pass null to go back to the ledger.
   */
  setFakeTurnLedger: (ledger: Record<string, FakeTurn[]> | null): void => {
    if (!ledger) {
      setTurnSourceForTest(null);
      return;
    }
    const turnsOf = (sessionId: string): Turn[] =>
      (ledger[sessionId] ?? []).map((t) => ({
        sessionId,
        n: t.n,
        ref: `refs/hermes/${sessionId}/turn/${t.n}`,
        startedAt: 1790000000000 + t.n * 1000,
        endedAt: 1790000000500 + t.n * 1000,
        diffstat: { files: t.paths?.length ?? 0, insertions: 1, deletions: 0 },
        ...(t.paths ? { paths: t.paths } : {}),
      }));
    setTurnSourceForTest({
      listTurns: async (sessionId) => turnsOf(sessionId),
      getTurnDiff: async (sessionId, n) => {
        const turn = turnsOf(sessionId).find((t) => t.n === n);
        const fake = (ledger[sessionId] ?? []).find((t) => t.n === n);
        return turn ? { turn, patch: fake?.patch ?? "" } : null;
      },
    });
  },
  /** What the fleet controls hold: caps, queue, slots, load, overlaps. */
  fleetState: () => ({
    caps: getFleetCaps(),
    queue: listQueuedTasks().map((t) => ({ id: t.id, label: t.label, aiProvider: t.opts.aiProvider ?? null })),
    occupancy: getOccupancy(),
    loads: Object.fromEntries(getAllLoads()),
    overlaps: Object.fromEntries(getAllOverlaps()),
  }),
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
