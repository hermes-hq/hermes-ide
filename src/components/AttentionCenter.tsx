// ─── Attention center: badge, inbox, ⌘I, notifications, keep-awake ────
//
// F12 + N16, behind the `attentionInbox` feature flag (App.tsx mounts this
// only when it is on). Lives in the title bar.
//
//   badge      the number of items Blocked on you; click or ⌘⇧I opens the
//              inbox. The same count goes to the dock (macOS), the taskbar
//              overlay (Windows) or the urgency hint (Linux).
//   inbox      a listbox in two groups, Blocked on you and Ready for you,
//              oldest first. ↑↓ select, Space peeks at the request detail
//              (read-only), Enter jumps to the pane, M mutes the session
//              for an hour, Esc closes.
//   ⌘I         jumps to the session waiting longest; repeat to cycle.
//   notify     one OS notification per session (never for the session you
//              look at in a focused window); a Blocked on you item also
//              sends one away message when an address is configured.
//   awake      the machine stays awake while any session is working.
//
// Everything reads AgentStatus / inbox items only (the C0 contracts), so
// every agent looks the same here. The sidebar order is never touched.

import "../styles/components/AttentionCenter.css";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useInboxItems, raiseInboxItem, resolveInboxItem, resolveInboxItemsForSession, type InboxItem } from "../agent/contract/inbox";
import { getSessionEventSnapshot, subscribeAllSessionEvents } from "../agent/contract/sessionEventStore";
import { setAttentionBadge, setKeepAwake, sendAwayNotification } from "../api/attention";
import { attentionDebug, pushCapped } from "../attention/debug";
import { agentLabel, awayPayload, itemState, notificationText, stateKey } from "../attention/describe";
import { blockedCount, groupInbox, inboxKindForStatus, inboxRows, isMuted, nextBlockedSession } from "../attention/model";
import { muteSession, unmuteSession, useMutes, getMutes } from "../attention/mutes";
import { createNotifier, type Notifier } from "../attention/notifier";
import { startStatusBridge, type StatusBridge } from "../attention/statusBridge";
import { isWindowFocused, subscribeWindowFocus } from "../attention/windowFocus";
import { useI18n } from "../i18n/I18nProvider";
import type { SessionData } from "../types/session";
import { claimPcAppChords } from "../utils/keymap";
import { notifyAttention } from "../utils/notifications";
import { PLATFORM } from "../utils/platform";
import { matchAppShortcut } from "../utils/shortcuts";

interface AttentionCenterProps {
  sessions: Record<string, SessionData>;
  activeSessionId: string | null;
  /** Show the session's pane and give it the keyboard. */
  onJump: (sessionId: string) => void;
}

/** Windows/Linux chords of the two attention shortcuts (see app-shortcuts.json). */
const PC_CHORDS = ["{ctrl}{shift}I", "{ctrl}{shift}A"];

/** The status kind an item stands for, when it still matches the session. */
function statusFor(item: InboxItem) {
  if (!item.sessionId) return null;
  const status = getSessionEventSnapshot(item.sessionId).status.kind;
  return inboxKindForStatus(status) === item.kind ? status : null;
}

function optionId(item: InboxItem): string {
  return `attention-option-${item.id}`;
}

export function AttentionCenter({ sessions, activeSessionId, onJump }: AttentionCenterProps) {
  const { t } = useI18n();
  const items = useInboxItems();
  const mutes = useMutes();
  const focused = useSyncExternalStore(subscribeWindowFocus, isWindowFocused, isWindowFocused);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [peek, setPeek] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<Element | null>(null);

  // Latest values for callbacks that outlive a render (notifier, listeners).
  const latest = useRef({ sessions, activeSessionId, t, onJump });
  latest.current = { sessions, activeSessionId, t, onJump };

  const now = Date.now();
  const count = blockedCount(items, mutes, now);
  const groups = useMemo(() => groupInbox(items), [items]);
  const rows = useMemo(() => inboxRows(items), [items]);

  const announce = useCallback((text: string) => {
    // Clear first so the same sentence twice is announced twice.
    setAnnouncement("");
    requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  const describeRow = useCallback((item: InboxItem) => {
    const session = item.sessionId ? latest.current.sessions[item.sessionId] : undefined;
    return {
      task: session?.label ?? (item.sessionId ? item.sessionId : latest.current.t("attention.workspace")),
      agent: item.sessionId ? agentLabel(session) : "Hermes",
      state: latest.current.t(stateKey(itemState(item, statusFor(item)))),
    };
  }, []);

  // ── status -> inbox ─────────────────────────────────────────────────
  const bridgeRef = useRef<StatusBridge | null>(null);
  useEffect(() => {
    const bridge = startStatusBridge();
    bridgeRef.current = bridge;
    return () => {
      bridge.stop();
      bridgeRef.current = null;
    };
  }, []);

  // Items the disk guard reports (Rust `hermes-inbox-item`) join the inbox.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ title?: string; detail?: string; source?: string }>("hermes-inbox-item", (msg) => {
          const detail = msg.payload?.title || msg.payload?.detail;
          if (detail) raiseInboxItem({ kind: "error", sessionId: null, detail, source: msg.payload.source || "worktree" });
        }),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Closed sessions leave the inbox.
  const knownSessions = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(Object.keys(sessions));
    for (const id of knownSessions.current) {
      if (!now.has(id)) {
        bridgeRef.current?.forget(id);
        resolveInboxItemsForSession(id);
        unmuteSession(id);
      }
    }
    knownSessions.current = now;
  }, [sessions]);

  // ── notifications ───────────────────────────────────────────────────
  const notifierRef = useRef<Notifier | null>(null);
  if (!notifierRef.current) {
    notifierRef.current = createNotifier({
      now: () => Date.now(),
      isWindowFocused,
      activeSessionId: () => latest.current.activeSessionId,
      mutes: getMutes,
      text: (item) => {
        const session = item.sessionId ? latest.current.sessions[item.sessionId] : undefined;
        return notificationText(item, session, statusFor(item), latest.current.t);
      },
      awayPayload: (item) => {
        const session = item.sessionId ? latest.current.sessions[item.sessionId] : undefined;
        return awayPayload(item, session, statusFor(item));
      },
      showOs: (text, item) => {
        let delivered = false;
        try {
          delivered = notifyAttention(text.title, text.body);
        } catch (e) {
          console.warn("[attention] notification failed:", e);
        }
        pushCapped(attentionDebug.os, { itemId: item.id, title: text.title, body: text.body, delivered });
      },
      sendAway: (payload) => {
        const entry = { payload, result: null as (typeof attentionDebug.away)[number]["result"] };
        pushCapped(attentionDebug.away, entry);
        sendAwayNotification(payload)
          .then((result) => {
            entry.result = result;
            if (result.outcome === "failed") console.warn("[attention] away message failed:", result.error);
          })
          .catch((e) => {
            entry.result = { outcome: "error", error: String(e) };
          });
      },
    });
    attentionDebug.notifier = notifierRef.current;
  }
  useEffect(() => {
    notifierRef.current?.update(items);
  }, [items]);

  // New Blocked on you items are announced to screen readers.
  const announced = useRef<Set<string>>(new Set());
  useEffect(() => {
    const open = new Set(items.map((i) => i.id));
    for (const id of announced.current) if (!open.has(id)) announced.current.delete(id);
    const fresh = groups.blocked.filter((i) => !announced.current.has(i.id));
    for (const i of items) announced.current.add(i.id);
    const newest = fresh[fresh.length - 1];
    if (newest && !isMuted(getMutes(), newest.sessionId, Date.now())) {
      announce(t("attention.announceNew", describeRow(newest)));
    }
  }, [items, groups, announce, describeRow, t]);

  // Looking at a session reads its "ready" item and ends its notification
  // groups (its next request notifies again).
  useEffect(() => {
    if (!activeSessionId || !focused) return;
    bridgeRef.current?.acknowledgeReady(activeSessionId);
    notifierRef.current?.seen(activeSessionId);
  }, [activeSessionId, focused, items]);

  // ── the OS side: badge and keep-awake ──────────────────────────────
  useEffect(() => {
    pushCapped(attentionDebug.badge, count);
    setAttentionBadge(count).catch((e) => console.warn("[attention] badge:", e));
  }, [count]);
  useEffect(
    () => () => {
      setAttentionBadge(0).catch(() => {});
    },
    [],
  );

  const keepAwakeRef = useRef<boolean | null>(null);
  useEffect(() => {
    const recompute = () => {
      const working = Object.keys(latest.current.sessions).some(
        (id) => getSessionEventSnapshot(id).status.kind === "working",
      );
      if (keepAwakeRef.current === working) return;
      keepAwakeRef.current = working;
      pushCapped(attentionDebug.keepAwake, working);
      setKeepAwake(working).catch((e) => console.warn("[attention] keep awake:", e));
    };
    recompute();
    return subscribeAllSessionEvents(recompute);
  }, [sessions]);
  useEffect(
    () => () => {
      if (keepAwakeRef.current) setKeepAwake(false).catch(() => {});
      keepAwakeRef.current = null;
    },
    [],
  );

  // ── actions ─────────────────────────────────────────────────────────
  const jump = useCallback((sessionId: string) => {
    latest.current.onJump(sessionId);
  }, []);

  const openInbox = useCallback(() => {
    returnFocusRef.current = document.activeElement;
    setOpen(true);
    setPeek(false);
    const g = groupInbox(items);
    setSelectedId(inboxRows(items)[0]?.id ?? null);
    announce(t("attention.announceOpen", { blocked: g.blocked.length, ready: g.ready.length }));
  }, [items, announce, t]);

  const closeInbox = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setPeek(false);
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    if (restoreFocus && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
  }, []);

  const jumpNext = useCallback(() => {
    const target = nextBlockedSession(items, getMutes(), Date.now(), latest.current.activeSessionId);
    if (!target) {
      announce(t("attention.nothingWaiting"));
      return;
    }
    if (open) closeInbox(false);
    jump(target);
  }, [items, open, closeInbox, jump, announce, t]);

  // ⌘I / ⌘⇧I (Ctrl+Shift+I / Ctrl+Shift+A on Windows and Linux).
  useEffect(() => {
    const release = PLATFORM === "mac" ? () => {} : claimPcAppChords(PC_CHORDS);
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const action = matchAppShortcut(e);
      if (action === "app.attention-next") {
        e.preventDefault();
        e.stopPropagation();
        jumpNext();
      } else if (action === "app.attention-inbox") {
        e.preventDefault();
        e.stopPropagation();
        if (open) closeInbox(true);
        else openInbox();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      release();
    };
  }, [jumpNext, open, openInbox, closeInbox]);

  // Focus the listbox when the inbox opens.
  useEffect(() => {
    if (open) listRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Keep a valid selection as items come and go.
  const selectedIndex = Math.max(0, rows.findIndex((r) => r.id === selectedId));
  const selected: InboxItem | undefined = rows[selectedIndex];
  useEffect(() => {
    if (open && selected && selected.id !== selectedId) setSelectedId(selected.id);
    if (open && !selected && selectedId !== null) setSelectedId(null);
  }, [open, selected, selectedId]);

  useEffect(() => {
    if (!open || !selected) return;
    document.getElementById(optionId(selected))?.scrollIntoView?.({ block: "nearest" });
  }, [open, selected]);

  const activate = useCallback(
    (item: InboxItem) => {
      closeInbox(false);
      if (item.sessionId) jump(item.sessionId);
      // A workspace item has no pane to jump to: Enter dismisses it.
      else resolveInboxItem(item.id);
    },
    [closeInbox, jump],
  );

  const toggleMute = useCallback(
    (item: InboxItem) => {
      if (!item.sessionId) return;
      const { task } = describeRow(item);
      if (isMuted(getMutes(), item.sessionId, Date.now())) {
        unmuteSession(item.sessionId);
        announce(t("attention.announceUnmuted", { task }));
      } else {
        muteSession(item.sessionId);
        announce(t("attention.announceMuted", { task }));
      }
    },
    [announce, describeRow, t],
  );

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const move = (to: number) => {
      if (rows.length === 0) return;
      const i = Math.min(rows.length - 1, Math.max(0, to));
      setSelectedId(rows[i].id);
    };
    switch (e.key) {
      case "ArrowDown":
        move(selectedIndex + 1);
        break;
      case "ArrowUp":
        move(selectedIndex - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case " ":
        if (selected) setPeek((p) => !p);
        break;
      case "Enter":
        if (selected) activate(selected);
        break;
      case "m":
      case "M":
        if (selected) toggleMute(selected);
        break;
      case "Escape":
        if (peek) setPeek(false);
        else closeInbox(true);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  // Close when clicking outside.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeInbox(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, closeInbox]);

  const age = (createdAt: number) => {
    const minutes = Math.floor((now - createdAt) / 60_000);
    if (minutes < 1) return t("attention.ageNow");
    if (minutes < 60) return t("attention.ageMinutes", { n: minutes });
    return t("attention.ageHours", { n: Math.floor(minutes / 60) });
  };

  const renderOption = (item: InboxItem) => {
    const { task, agent, state } = describeRow(item);
    const muted = isMuted(mutes, item.sessionId, now);
    const isSelected = selected?.id === item.id;
    return (
      <div
        key={item.id}
        id={optionId(item)}
        role="option"
        aria-selected={isSelected}
        data-item-id={item.id}
        data-session-id={item.sessionId ?? ""}
        data-kind={item.kind}
        data-muted={muted ? "true" : "false"}
        className={`attention-option attention-kind-${item.kind}${isSelected ? " attention-option-selected" : ""}${muted ? " attention-option-muted" : ""}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setSelectedId(item.id)}
        onDoubleClick={() => activate(item)}
      >
        <span className="attention-option-dot" aria-hidden="true" />
        <span className="attention-option-main">
          <span className="attention-option-title">
            <span className="attention-option-task">{task}</span>
            <span className="attention-option-state">
              {agent} {state}
            </span>
          </span>
          {item.detail && <span className="attention-option-detail">{item.detail}</span>}
        </span>
        <span className="attention-option-meta">
          {muted ? <span className="attention-option-muted-tag">{t("attention.muted")}</span> : null}
          <span className="attention-option-age">{age(item.createdAt)}</span>
        </span>
      </div>
    );
  };

  const peekItem = open && peek ? selected : undefined;
  const peekInfo = peekItem ? describeRow(peekItem) : null;

  return (
    <div className="attention-center topbar-controls" ref={rootRef}>
      <button
        type="button"
        className={`attention-badge${count > 0 ? " attention-badge-hot" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("attention.badgeLabel", { count })}
        title={t("attention.badgeLabel", { count })}
        data-count={count}
        onClick={() => (open ? closeInbox(true) : openInbox())}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 1.5a4 4 0 0 0-4 4v2.3L2.7 10.4a.6.6 0 0 0 .5.9h9.6a.6.6 0 0 0 .5-.9L12 7.8V5.5a4 4 0 0 0-4-4ZM6.3 13a1.8 1.8 0 0 0 3.4 0"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="attention-badge-count">{count}</span>
      </button>
      <div className="attention-live" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {open && (
        <div className="attention-inbox" role="dialog" aria-label={t("attention.title")}>
          <div className="attention-inbox-header">
            <span className="attention-inbox-title">{t("attention.title")}</span>
          </div>
          <div
            ref={listRef}
            className="attention-list"
            role="listbox"
            tabIndex={0}
            aria-label={t("attention.title")}
            aria-activedescendant={selected ? optionId(selected) : undefined}
            onKeyDown={onListKeyDown}
          >
            {groups.blocked.length > 0 && (
              <div role="group" aria-labelledby="attention-group-blocked" className="attention-group" data-section="blocked">
                <div id="attention-group-blocked" role="presentation" className="attention-group-title">
                  {t("attention.blockedSection")} ({groups.blocked.length})
                </div>
                {groups.blocked.map(renderOption)}
              </div>
            )}
            {groups.ready.length > 0 && (
              <div role="group" aria-labelledby="attention-group-ready" className="attention-group" data-section="ready">
                <div id="attention-group-ready" role="presentation" className="attention-group-title">
                  {t("attention.readySection")} ({groups.ready.length})
                </div>
                {groups.ready.map(renderOption)}
              </div>
            )}
          </div>
          {rows.length === 0 && <p className="attention-empty">{t("attention.empty")}</p>}
          {peekItem && peekInfo && (
            <div className="attention-peek" role="region" aria-label={t("attention.peekLabel")} data-item-id={peekItem.id}>
              <dl className="attention-peek-facts">
                <dt>{t("attention.peekSession")}</dt>
                <dd>{peekInfo.task}</dd>
                <dt>{t("attention.peekState")}</dt>
                <dd>
                  {peekInfo.agent} {peekInfo.state}
                </dd>
                <dt>{t("attention.peekSince")}</dt>
                <dd>{new Date(peekItem.createdAt).toLocaleTimeString()}</dd>
              </dl>
              {peekItem.detail ? (
                <pre className="attention-peek-detail">{peekItem.detail}</pre>
              ) : (
                <p className="attention-peek-empty">{t("attention.peekNoDetail")}</p>
              )}
              <p className="attention-peek-hint">{t("attention.peekAnswerHint")}</p>
            </div>
          )}
          <div className="attention-inbox-footer" aria-hidden="true">
            {t("attention.hint")}
          </div>
        </div>
      )}
    </div>
  );
}
