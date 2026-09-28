/**
 * Review Desk (F21, ⌘G) — one place to review everything an agent changed.
 *
 * The diff runs from the merge-base to the worktree (untracked files
 * included), grouped by turn or by file, with a viewed checkbox per file,
 * line comments, and send-back routed to the agent that made the turn:
 * a terminal agent gets review-<n>.md plus ONE visible tagged line pasted
 * only when the person presses Send; Hermes shows "delivered" when the
 * agent's next prompt signal carries the tag, otherwise "not delivered"
 * with Retry. A working agent gets nothing typed into it: the send stops
 * at "waiting" and the person presses "Send now" once the turn has ended.
 * An agent whose launch installed no prompt hook shows "pasted" instead —
 * the line went in, nobody can confirm it. One turn can be reverted
 * (git apply -R, previewed first).
 * Deterministic risk flags mark lockfiles, new dependencies, workflow
 * edits, auth/crypto paths, secret patterns, new binaries, install scripts
 * and curl | sh.
 *
 * It replaces SessionGitPanel, the Workbench Git tab and GitPanel as the
 * primary git surface (behind the `reviewDesk` flag); the log, stash and
 * conflict views live on in its Repository tab.
 *
 * Keys: j/k next/previous file or turn · [ ] previous/next turn ·
 * c comment on the selected line · s send the selected turn's comments ·
 * x revert the selected turn · Esc close.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../state/SessionContext";
import { useI18n } from "../i18n/I18nProvider";
import { getSessionEventSnapshot, subscribeSessionEvents, useSessionEvents } from "../agent/contract/sessionEventStore";
import type { SessionEvent } from "../agent/contract/events";
import type { Turn } from "../agent/contract/turns";
import { writeToSession } from "../api/sessions";
import { gitStatus, gitMergeStatus, gitResolveConflict, gitAbortMerge } from "../api/git";
import type { GitProjectStatus, MergeStatus, ConflictStrategy } from "../types/git";
import type { SessionData } from "../types/session";
import { reviewDiff, reviewRevertPatch, reviewRevertPreview, reviewWriteFile, type ReviewDiff, type RevertPreview } from "../review/api";
import { parsePatch, type DiffLine, type ParsedFile } from "../review/patch";
import { riskFlagsFor, type RiskFlag } from "../review/riskFlags";
import { commentsForSession, encodePaste, pasteLine, reviewMarkdown, type ReviewComment } from "../review/reviewModel";
import { deliveryReceiptAvailable, isBusy, sendReviewBack } from "../review/sendBack";
import {
  addComment,
  markSent,
  nextReviewNumber,
  removeComment,
  setDelivery,
  setViewed,
  useReviewState,
} from "../review/reviewStore";
import { getTurnDiffFor, listTurnsFor } from "../review/turnSource";
import { GitLogView } from "./GitLogView";
import { GitStashSection } from "./GitStashSection";
import { GitMergeBanner } from "./GitMergeBanner";
import { GitConflictViewer } from "./GitConflictViewer";
import "../styles/components/ReviewDesk.css";

interface ReviewDeskProps {
  /** The focused session: its folder is what is reviewed. */
  sessionId: string;
  sessions: readonly SessionData[];
  onClose: () => void;
}

/** One turn of one session, with its patch parsed. */
export interface TurnEntry {
  readonly sessionId: string;
  readonly agentLabel: string;
  readonly turn: Turn;
  readonly patch: string;
  readonly files: readonly ParsedFile[];
}

type GroupBy = "file" | "turn";
type Tab = "review" | "repository";
type Selection = { kind: "file"; path: string } | { kind: "turn"; sessionId: string; n: number };

interface CommentDraft {
  readonly sessionId: string;
  readonly turnN: number | null;
  readonly path: string;
  readonly side: "new" | "old";
  readonly line: number;
  readonly excerpt: string;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** The turn (session and number) that last touched a path, for routing a comment made in the by-file view. */
export function turnForPath(turns: readonly TurnEntry[], path: string): TurnEntry | null {
  let hit: TurnEntry | null = null;
  for (const t of turns) if (t.files.some((f) => f.path === path)) hit = t;
  return hit;
}

function agentLabel(session: SessionData | undefined, fallback: string): string {
  if (!session) return fallback;
  return session.label || session.agent_name || session.ai_provider || fallback;
}

/** Sessions events since the last look, for the receipt watcher. */
function watchSessionEvents(sessionId: string, listener: (event: SessionEvent) => void): () => void {
  let seen = getSessionEventSnapshot(sessionId).version;
  return subscribeSessionEvents(sessionId, () => {
    const snap = getSessionEventSnapshot(sessionId);
    const fresh = Math.max(0, Math.min(snap.events.length, snap.version - seen));
    seen = snap.version;
    for (const e of snap.events.slice(snap.events.length - fresh)) listener(e);
  });
}

const SEND_DEPS = {
  writeFile: reviewWriteFile,
  paste: (sessionId: string, line: string) => writeToSession(sessionId, encodePaste(line)),
  onSessionEvent: watchSessionEvents,
  status: (sessionId: string) => getSessionEventSnapshot(sessionId).status,
};

/** "Send now" for a send held while the agent worked: enabled only once the turn has ended. */
function SendNowButton({ sessionId, label, onClick }: { sessionId: string; label: string; onClick: () => void }) {
  const busy = isBusy(useSessionEvents(sessionId).status);
  return (
    <button type="button" className="review-btn review-btn-small review-send-now-btn" disabled={busy} data-busy={busy ? "1" : "0"} onClick={onClick}>
      {label}
    </button>
  );
}

export function ReviewDesk({ sessionId, sessions, onClose }: ReviewDeskProps) {
  const { t } = useI18n();
  const { dispatch } = useSession();
  const focused = sessions.find((s) => s.id === sessionId);
  const repoPath = focused?.working_directory ?? "";
  const review = useReviewState(repoPath);

  const [diff, setDiff] = useState<ReviewDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [turns, setTurns] = useState<TurnEntry[]>([]);
  const [groupBy, setGroupBy] = useState<GroupBy>("file");
  const [tab, setTab] = useState<Tab>("review");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [draftText, setDraftText] = useState("");
  const [revert, setRevert] = useState<{ entry: TurnEntry; preview: RevertPreview | null; error: string | null; busy: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);

  // Sessions working in the same folder: their turns belong to this review.
  const repoSessions = useMemo(
    () => sessions.filter((s) => s.working_directory && normalizePath(s.working_directory) === normalizePath(repoPath)),
    [sessions, repoPath],
  );

  const load = useCallback(async () => {
    if (!repoPath) {
      setLoading(false);
      setDiffError("this session has no folder");
      return;
    }
    setLoading(true);
    setDiffError(null);
    const [diffResult, turnResult] = await Promise.all([
      reviewDiff(repoPath).then((d) => ({ ok: true as const, d })).catch((e: unknown) => ({ ok: false as const, e })),
      Promise.all(
        repoSessions.map(async (s) => {
          const list = await listTurnsFor(s.id);
          const entries = await Promise.all(
            list.map(async (turn) => {
              const td = await getTurnDiffFor(s.id, turn.n);
              const patch = td?.patch ?? "";
              return { sessionId: s.id, agentLabel: agentLabel(s, s.id.slice(0, 8)), turn, patch, files: parsePatch(patch) } satisfies TurnEntry;
            }),
          );
          return entries;
        }),
      ),
    ]);
    if (diffResult.ok) setDiff(diffResult.d);
    else setDiffError(String(diffResult.e));
    setTurns(turnResult.flat().sort((a, b) => a.turn.startedAt - b.turn.startedAt || a.turn.n - b.turn.n));
    setLoading(false);
  }, [repoPath, repoSessions]);

  useEffect(() => {
    void load();
  }, [load, reloadTick]);

  const files = useMemo(() => (diff ? diff.files.map((f) => ({ file: f, parsed: parsePatch(f.patch)[0] ?? null, flags: [] as RiskFlag[] })) : []), [diff]);
  const flagsByPath = useMemo(() => {
    const m = new Map<string, RiskFlag[]>();
    for (const f of files) if (f.parsed) m.set(f.file.path, riskFlagsFor(f.parsed));
    return m;
  }, [files]);
  const flagCount = useMemo(() => [...flagsByPath.values()].reduce((n, l) => n + l.length, 0), [flagsByPath]);
  const totals = useMemo(() => ({ add: files.reduce((n, f) => n + f.file.additions, 0), del: files.reduce((n, f) => n + f.file.deletions, 0) }), [files]);

  // Keep the selection valid when the data changes.
  useEffect(() => {
    if (loading) return;
    if (groupBy === "file") {
      if (selection?.kind === "file" && files.some((f) => f.file.path === selection.path)) return;
      setSelection(files.length > 0 ? { kind: "file", path: files[0].file.path } : null);
    } else {
      if (selection?.kind === "turn" && turns.some((e) => e.sessionId === selection.sessionId && e.turn.n === selection.n)) return;
      setSelection(turns.length > 0 ? { kind: "turn", sessionId: turns[0].sessionId, n: turns[0].turn.n } : null);
    }
  }, [loading, groupBy, files, turns, selection]);

  const selectedTurn = selection?.kind === "turn" ? turns.find((e) => e.sessionId === selection.sessionId && e.turn.n === selection.n) ?? null : null;
  const selectedFile = selection?.kind === "file" ? files.find((f) => f.file.path === selection.path) ?? null : null;

  const move = useCallback(
    (delta: number) => {
      if (groupBy === "file") {
        if (files.length === 0) return;
        const i = Math.max(0, files.findIndex((f) => selection?.kind === "file" && f.file.path === selection.path));
        const next = files[(i + delta + files.length) % files.length];
        setSelection({ kind: "file", path: next.file.path });
      } else {
        if (turns.length === 0) return;
        const i = Math.max(0, turns.findIndex((e) => selection?.kind === "turn" && e.sessionId === selection.sessionId && e.turn.n === selection.n));
        const next = turns[(i + delta + turns.length) % turns.length];
        setSelection({ kind: "turn", sessionId: next.sessionId, n: next.turn.n });
      }
    },
    [groupBy, files, turns, selection],
  );

  const moveTurn = useCallback(
    (delta: number) => {
      if (turns.length === 0) return;
      setGroupBy("turn");
      const i = Math.max(0, turns.findIndex((e) => selection?.kind === "turn" && e.sessionId === selection.sessionId && e.turn.n === selection.n));
      const next = turns[(i + delta + turns.length) % turns.length];
      setSelection({ kind: "turn", sessionId: next.sessionId, n: next.turn.n });
    },
    [turns, selection],
  );

  const startComment = useCallback(
    (path: string, line: DiffLine, entry: TurnEntry | null) => {
      const routed = entry ?? turnForPath(turns, path);
      const side: "new" | "old" = line.kind === "del" ? "old" : "new";
      const no = side === "old" ? line.oldNo : line.newNo;
      if (no === null) return;
      setDraft({
        sessionId: routed?.sessionId ?? sessionId,
        turnN: routed?.turn.n ?? null,
        path,
        side,
        line: no,
        excerpt: line.text,
      });
      setDraftText("");
      setTimeout(() => draftRef.current?.focus(), 0);
    },
    [turns, sessionId],
  );

  const saveComment = useCallback(() => {
    if (!draft || !draftText.trim()) return;
    addComment(repoPath, { ...draft, text: draftText.trim() });
    setDraft(null);
    setDraftText("");
  }, [draft, draftText, repoPath]);

  /** The review a comment went out in, or null while it is unsent. */
  const sentOf = useCallback((id: string): number | null => review.sent[id] ?? null, [review.sent]);
  const unsentFor = useCallback(
    (sid: string) => commentsForSession(review.comments, sid).filter((c) => sentOf(c.id) === null),
    [review.comments, sentOf],
  );

  const runSend = useCallback(
    async (sid: string, n: number, comments: readonly ReviewComment[]) => {
      const session = sessions.find((s) => s.id === sid);
      const label = agentLabel(session, sid.slice(0, 8));
      const content = reviewMarkdown({ n, agentLabel: label, repoPath, branch: diff?.branch ?? null, comments });
      if (session?.mode === "agent") {
        // A structured agent gets a message: the line goes to its composer,
        // where the person sends it (Hermes never sends on its own).
        try {
          const filePath = await reviewWriteFile(sid, n, content);
          dispatch({ type: "SET_COMPOSER_DRAFT", sessionId: sid, draft: pasteLine(n, filePath) });
          setDelivery(repoPath, n, sid, { kind: "queued", reason: "placed in the composer" }, filePath);
        } catch (e) {
          setDelivery(repoPath, n, sid, { kind: "failed", reason: String(e) }, null);
        }
        return;
      }
      await sendReviewBack(
        { ...SEND_DEPS, canConfirm: (id) => deliveryReceiptAvailable(sessions.find((s) => s.id === id)) },
        { sessionId: sid, n, content, line: (filePath) => pasteLine(n, filePath) },
        (state) => setDelivery(repoPath, n, sid, state, review.deliveries[n]?.filePath ?? null),
      ).then((out) => setDelivery(repoPath, n, sid, out.state, out.filePath));
    },
    [sessions, repoPath, diff?.branch, dispatch, review.deliveries],
  );

  const send = useCallback(
    async (sid: string) => {
      const comments = unsentFor(sid);
      if (comments.length === 0) return;
      const n = nextReviewNumber(repoPath);
      markSent(
        repoPath,
        comments.map((c) => c.id),
        n,
      );
      await runSend(sid, n, comments);
    },
    [unsentFor, repoPath, runSend],
  );

  /** Retry (not delivered / failed) and Send now (waiting): the same review goes out again. */
  const resend = useCallback(
    async (n: number) => {
      const d = review.deliveries[n];
      if (!d) return;
      const comments = review.comments.filter((c) => sentOf(c.id) === n);
      await runSend(d.sessionId, n, comments);
    },
    [review.deliveries, review.comments, sentOf, runSend],
  );

  const openRevert = useCallback(
    async (entry: TurnEntry) => {
      setRevert({ entry, preview: null, error: null, busy: false });
      try {
        const preview = await reviewRevertPreview(repoPath, entry.patch);
        setRevert((r) => (r && r.entry === entry ? { ...r, preview } : r));
      } catch (e) {
        setRevert((r) => (r && r.entry === entry ? { ...r, error: String(e) } : r));
      }
    },
    [repoPath],
  );

  const confirmRevert = useCallback(async () => {
    if (!revert) return;
    setRevert({ ...revert, busy: true });
    try {
      const result = await reviewRevertPatch(repoPath, revert.entry.patch);
      if (result.ok) {
        setNotice(
          result.method === "3way"
            ? t("review.revertedThreeWay", { n: revert.entry.turn.n })
            : t("review.reverted", { n: revert.entry.turn.n }),
        );
        setRevert(null);
        setReloadTick((x) => x + 1);
      } else {
        setRevert({ ...revert, busy: false, error: result.message });
      }
    } catch (e) {
      setRevert({ ...revert, busy: false, error: String(e) });
    }
  }, [revert, repoPath, t]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Keyboard: never while typing, never while the revert sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
      if (e.key === "Escape") {
        e.preventDefault();
        if (revert) setRevert(null);
        else if (draft) setDraft(null);
        else onClose();
        return;
      }
      if (typing || revert || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "j":
          e.preventDefault();
          move(1);
          break;
        case "k":
          e.preventDefault();
          move(-1);
          break;
        case "[":
          e.preventDefault();
          moveTurn(-1);
          break;
        case "]":
          e.preventDefault();
          moveTurn(1);
          break;
        case "c": {
          e.preventDefault();
          const first = document.querySelector<HTMLElement>(".review-desk .review-line.review-line-add, .review-desk .review-line.review-line-del");
          first?.click();
          break;
        }
        case "s":
          e.preventDefault();
          if (selectedTurn) void send(selectedTurn.sessionId);
          break;
        case "x":
          e.preventDefault();
          if (selectedTurn) void openRevert(selectedTurn);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, move, moveTurn, send, openRevert, selectedTurn, draft, revert]);

  const viewedSet = useMemo(() => new Set(review.viewed), [review.viewed]);
  const commentsFor = (path: string) => review.comments.filter((c) => c.path === path);

  const renderFile = (parsed: ParsedFile | null, file: { path: string; isBinary: boolean; truncated: boolean; status: string }, entry: TurnEntry | null) => {
    const comments = commentsFor(file.path);
    if (!parsed) return <div className="review-empty">{t("review.noTextDiff")}</div>;
    if (file.isBinary) return <div className="review-empty">{t("review.binaryFile")}</div>;
    if (file.truncated) return <div className="review-empty">{t("review.truncated")}</div>;
    return (
      <div className="review-hunks">
        {parsed.hunks.map((h, hi) => (
          <div className="review-hunk" key={hi}>
            <div className="review-hunk-header">{h.header}</div>
            {h.lines.map((line, li) => {
              const side: "new" | "old" = line.kind === "del" ? "old" : "new";
              const no = side === "old" ? line.oldNo : line.newNo;
              const here = comments.filter((c) => c.side === side && c.line === no);
              const isDraft = draft && draft.path === file.path && draft.side === side && draft.line === no;
              return (
                <div key={li}>
                  <div
                    className={`review-line review-line-${line.kind}`}
                    data-path={file.path}
                    data-side={side}
                    data-line={no ?? ""}
                    role="button"
                    tabIndex={-1}
                    title={t("review.commentOnLine")}
                    onClick={() => startComment(file.path, line, entry)}
                  >
                    <span className="review-line-no">{line.oldNo ?? ""}</span>
                    <span className="review-line-no">{line.newNo ?? ""}</span>
                    <span className="review-line-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
                    <span className="review-line-text">{line.text}</span>
                  </div>
                  {here.map((c) => (
                    <div className="review-comment" key={c.id} data-session={c.sessionId} data-turn={c.turnN ?? ""} data-sent={sentOf(c.id) ?? ""}>
                      <span className="review-comment-route">
                        {t("review.toAgent", { agent: agentLabel(sessions.find((s) => s.id === c.sessionId), c.sessionId.slice(0, 8)) })}
                        {c.turnN !== null ? ` · T${c.turnN}` : ""}
                        {sentOf(c.id) !== null ? ` · ${t("review.sentAs", { n: sentOf(c.id) ?? 0 })}` : ""}
                      </span>
                      <span className="review-comment-text">{c.text}</span>
                      {sentOf(c.id) === null && (
                        <button type="button" className="review-comment-remove" onClick={() => removeComment(repoPath, c.id)} aria-label={t("review.removeComment")}>
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  {isDraft && (
                    <div className="review-comment-editor">
                      <textarea
                        ref={draftRef}
                        value={draftText}
                        placeholder={t("review.commentPlaceholder", { agent: agentLabel(sessions.find((s) => s.id === draft.sessionId), draft.sessionId.slice(0, 8)) })}
                        onChange={(e) => setDraftText(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveComment();
                        }}
                        rows={3}
                      />
                      <div className="review-comment-editor-actions">
                        <button type="button" className="review-btn review-comment-save" onClick={saveComment} disabled={!draftText.trim()}>
                          {t("review.addComment")}
                        </button>
                        <button type="button" className="review-btn review-btn-quiet" onClick={() => setDraft(null)}>
                          {t("common.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  const renderDelivery = (n: number) => {
    const d = review.deliveries[n];
    if (!d) return null;
    const label =
      d.kind === "sending"
        ? t("review.sending")
        : d.kind === "delivered"
          ? t("review.delivered")
          : d.kind === "queued"
            ? t("review.inComposer")
            : d.kind === "waiting"
              ? t("review.waitingForTurn")
              : d.kind === "pasted"
                ? t("review.pastedNoReceipt")
                : d.kind === "not_delivered"
                  ? t("review.notDelivered")
                  : d.kind === "failed"
                    ? t("review.failed", { reason: d.reason })
                    : "";
    const glyph = d.kind === "delivered" ? "✓" : d.kind === "pasted" ? "→" : d.kind === "not_delivered" || d.kind === "failed" ? "!" : "…";
    const copyLine = d.filePath && (
      <button
        type="button"
        className="review-btn review-btn-small review-btn-quiet review-copy-line-btn"
        onClick={() => navigator.clipboard.writeText(pasteLine(n, d.filePath ?? "")).catch(() => {})}
      >
        {t("review.copyLine")}
      </button>
    );
    return (
      <span className={`review-delivery review-delivery-${d.kind}`} data-state={d.kind} data-n={n}>
        <span className="review-delivery-glyph" aria-hidden="true">
          {glyph}
        </span>
        {t("review.reviewN", { n })} · {label}
        {d.kind === "waiting" && <SendNowButton sessionId={d.sessionId} label={t("review.sendNow")} onClick={() => void resend(n)} />}
        {(d.kind === "not_delivered" || d.kind === "failed") && (
          <button type="button" className="review-btn review-btn-small review-retry-btn" onClick={() => void resend(n)}>
            {t("review.retry")}
          </button>
        )}
        {(d.kind === "not_delivered" || d.kind === "failed" || d.kind === "pasted") && copyLine}
      </span>
    );
  };

  const renderSendPanel = () => {
    const bySession = new Map<string, ReviewComment[]>();
    for (const c of review.comments) {
      const list = bySession.get(c.sessionId) ?? [];
      list.push(c);
      bySession.set(c.sessionId, list);
    }
    const numbers = Object.keys(review.deliveries)
      .map(Number)
      .sort((a, b) => a - b);
    if (bySession.size === 0 && numbers.length === 0) return null;
    return (
      <div className="review-send-panel">
        {[...bySession.entries()].map(([sid, list]) => {
          const unsent = list.filter((c) => sentOf(c.id) === null);
          const session = sessions.find((s) => s.id === sid);
          const label = agentLabel(session, sid.slice(0, 8));
          const gone = !session || session.phase === "destroyed";
          return (
            <div className="review-send" key={sid} data-session={sid} data-unsent={unsent.length}>
              <span className="review-send-label">
                {t("review.commentsFor", { count: unsent.length, agent: label })}
              </span>
              <button
                type="button"
                className="review-btn review-send-btn"
                disabled={unsent.length === 0 || gone}
                title={gone ? t("review.sessionGone") : t("review.sendHint")}
                onClick={() => void send(sid)}
              >
                {t("review.sendTo", { agent: label })}
              </button>
            </div>
          );
        })}
        {numbers.length > 0 && <div className="review-deliveries">{numbers.map((n) => <span key={n}>{renderDelivery(n)}</span>)}</div>}
      </div>
    );
  };

  const flagBadges = (path: string) =>
    (flagsByPath.get(path) ?? []).map((f, i) => (
      <span className="review-flag" data-kind={f.kind} title={f.detail} key={`${f.kind}-${i}`}>
        {f.label}
      </span>
    ));

  return (
    <div className="review-desk-backdrop" onClick={onClose}>
      <div
        className="review-desk"
        role="dialog"
        aria-modal="true"
        aria-label={t("review.title")}
        data-repo={repoPath}
        data-group={groupBy}
        data-tab={tab}
        data-loading={loading ? "1" : "0"}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="review-head">
          <div className="review-title">
            <span className="review-title-text">{t("review.title")}</span>
            <span className="review-scope" title={repoPath}>
              {focused ? agentLabel(focused, focused.id.slice(0, 8)) : ""}
              {diff?.branch ? ` · ${diff.branch}` : ""}
              {diff ? ` → ${diff.baseRef}` : ""}
            </span>
          </div>
          <div className="review-tabs" role="tablist">
            <button type="button" role="tab" className="review-tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>
              {t("review.tabReview")}
            </button>
            <button type="button" role="tab" className="review-tab" aria-selected={tab === "repository"} onClick={() => setTab("repository")}>
              {t("review.tabRepository")}
            </button>
          </div>
          <button type="button" className="review-close" onClick={onClose} aria-label={t("common.close")} title="Esc">
            ✕
          </button>
        </header>

        {tab === "review" && (
          <>
            <div className="review-toolbar">
              <div className="review-group" role="radiogroup" aria-label={t("review.groupBy")}>
                <button type="button" role="radio" aria-checked={groupBy === "file"} className="review-group-btn" data-group="file" onClick={() => setGroupBy("file")}>
                  {t("review.byFile")}
                </button>
                <button type="button" role="radio" aria-checked={groupBy === "turn"} className="review-group-btn" data-group="turn" onClick={() => setGroupBy("turn")}>
                  {t("review.byTurn")}
                </button>
              </div>
              <span className="review-summary" data-files={files.length} data-flags={flagCount} data-viewed={review.viewed.filter((p) => files.some((f) => f.file.path === p)).length}>
                {t("review.summary", { files: files.length, add: totals.add, del: totals.del })}
                {" · "}
                {t("review.viewedCount", { viewed: review.viewed.filter((p) => files.some((f) => f.file.path === p)).length, files: files.length })}
                {flagCount > 0 && (
                  <>
                    {" · "}
                    <span className="review-summary-flags">{t("review.flagCount", { count: flagCount })}</span>
                  </>
                )}
              </span>
              <button type="button" className="review-btn review-btn-quiet review-refresh" onClick={() => setReloadTick((x) => x + 1)} title={t("review.refresh")}>
                ↻
              </button>
            </div>

            <div className="review-body">
              <nav className="review-nav" aria-label={groupBy === "file" ? t("review.byFile") : t("review.byTurn")}>
                {loading && <div className="review-empty">{t("review.loading")}</div>}
                {!loading && diffError && <div className="review-error">{diffError}</div>}
                {!loading && !diffError && groupBy === "file" && files.length === 0 && <div className="review-empty">{t("review.nothingChanged")}</div>}
                {!loading && groupBy === "file" &&
                  files.map(({ file }) => (
                    <div
                      key={file.path}
                      className={`review-file-row${selection?.kind === "file" && selection.path === file.path ? " review-row-selected" : ""}`}
                      data-path={file.path}
                      data-status={file.status}
                      data-flags={(flagsByPath.get(file.path) ?? []).map((f) => f.kind).join(" ")}
                      onClick={() => setSelection({ kind: "file", path: file.path })}
                    >
                      <label className="review-viewed" onClick={(e) => e.stopPropagation()} title={t("review.viewed")}>
                        <input type="checkbox" checked={viewedSet.has(file.path)} onChange={(e) => setViewed(repoPath, file.path, e.target.checked)} />
                      </label>
                      <span className={`review-file-status review-file-status-${file.status}`}>{file.status[0].toUpperCase()}</span>
                      <span className="review-file-path">{file.path}</span>
                      <span className="review-file-stat">
                        <span className="review-add">+{file.additions}</span> <span className="review-del">−{file.deletions}</span>
                      </span>
                      {flagBadges(file.path)}
                    </div>
                  ))}
                {!loading && groupBy === "turn" && turns.length === 0 && <div className="review-empty">{t("review.noTurns")}</div>}
                {!loading && groupBy === "turn" &&
                  turns.map((entry) => (
                    <div
                      key={`${entry.sessionId}:${entry.turn.n}`}
                      className={`review-turn-row${selection?.kind === "turn" && selection.sessionId === entry.sessionId && selection.n === entry.turn.n ? " review-row-selected" : ""}`}
                      data-session={entry.sessionId}
                      data-turn={entry.turn.n}
                      onClick={() => setSelection({ kind: "turn", sessionId: entry.sessionId, n: entry.turn.n })}
                    >
                      <span className="review-turn-n">T{entry.turn.n}</span>
                      <span className="review-turn-agent">{entry.agentLabel}</span>
                      <span className="review-file-stat">
                        {entry.turn.diffstat.files} {t("review.filesShort")} · <span className="review-add">+{entry.turn.diffstat.insertions}</span>{" "}
                        <span className="review-del">−{entry.turn.diffstat.deletions}</span>
                      </span>
                    </div>
                  ))}
              </nav>

              <section className="review-main" aria-live="polite">
                {notice && <div className="review-notice">{notice}</div>}
                {!loading && groupBy === "file" && selectedFile && (
                  <>
                    <div className="review-main-head">
                      <span className="review-main-path">{selectedFile.file.path}</span>
                      {flagBadges(selectedFile.file.path)}
                      {(() => {
                        const owner = turnForPath(turns, selectedFile.file.path);
                        return owner ? <span className="review-main-owner">{t("review.lastChangedBy", { agent: owner.agentLabel, n: owner.turn.n })}</span> : null;
                      })()}
                    </div>
                    {renderFile(selectedFile.parsed, selectedFile.file, null)}
                  </>
                )}
                {!loading && groupBy === "turn" && selectedTurn && (
                  <>
                    <div className="review-main-head">
                      <span className="review-main-path">
                        T{selectedTurn.turn.n} · {selectedTurn.agentLabel}
                      </span>
                      <button type="button" className="review-btn review-btn-small review-revert-btn" onClick={() => void openRevert(selectedTurn)}>
                        {t("review.revertTurn", { n: selectedTurn.turn.n })}
                      </button>
                    </div>
                    {selectedTurn.files.length === 0 && <div className="review-empty">{t("review.noChangeTurn")}</div>}
                    {selectedTurn.files.map((pf) => (
                      <div className="review-turn-file" key={pf.path} data-path={pf.path}>
                        <div className="review-turn-file-head">
                          <label className="review-viewed" title={t("review.viewed")}>
                            <input type="checkbox" checked={viewedSet.has(pf.path)} onChange={(e) => setViewed(repoPath, pf.path, e.target.checked)} />
                          </label>
                          <span className="review-file-path">{pf.path}</span>
                          <span className="review-file-stat">
                            <span className="review-add">+{pf.additions}</span> <span className="review-del">−{pf.deletions}</span>
                          </span>
                          {riskFlagsFor(pf).map((f, i) => (
                            <span className="review-flag" data-kind={f.kind} title={f.detail} key={`${f.kind}-${i}`}>
                              {f.label}
                            </span>
                          ))}
                        </div>
                        {renderFile(pf, { path: pf.path, isBinary: pf.isBinary, truncated: false, status: pf.status }, selectedTurn)}
                      </div>
                    ))}
                  </>
                )}
              </section>
            </div>

            {renderSendPanel()}
            <footer className="review-keys" aria-hidden="true">
              <kbd>j</kbd>/<kbd>k</kbd> {t("review.keyMove")} · <kbd>[</kbd>/<kbd>]</kbd> {t("review.keyTurn")} · <kbd>c</kbd> {t("review.keyComment")} · <kbd>s</kbd>{" "}
              {t("review.keySend")} · <kbd>x</kbd> {t("review.keyRevert")} · <kbd>Esc</kbd> {t("common.close")}
            </footer>
          </>
        )}

        {tab === "repository" && <RepositoryTab sessionId={sessionId} />}

        {revert && (
          <div className="review-revert-backdrop" onClick={() => !revert.busy && setRevert(null)}>
            <div className="review-revert-preview" role="dialog" aria-modal="true" aria-label={t("review.revertTurn", { n: revert.entry.turn.n })} onClick={(e) => e.stopPropagation()}>
              <h3>{t("review.revertTurn", { n: revert.entry.turn.n })}</h3>
              <p className="review-revert-who">{revert.entry.agentLabel}</p>
              {!revert.preview && !revert.error && <div className="review-empty">{t("review.loading")}</div>}
              {revert.preview && (
                <>
                  <p className={`review-revert-clean review-revert-clean-${revert.preview.clean ? "yes" : "no"}`} data-clean={revert.preview.clean ? "1" : "0"}>
                    {revert.preview.clean ? t("review.revertClean") : t("review.revertNotClean", { message: revert.preview.message })}
                  </p>
                  <ul className="review-revert-files">
                    {revert.preview.files.map((f) => (
                      <li key={f.path} data-path={f.path}>
                        <span className="review-file-path">{f.path}</span>{" "}
                        <span className="review-file-stat">
                          <span className="review-add">−{f.additions}</span> <span className="review-del">+{f.deletions}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {revert.error && <div className="review-error">{revert.error}</div>}
              <div className="review-revert-actions">
                <button type="button" className="review-btn review-btn-danger review-revert-confirm" disabled={!revert.preview || revert.preview.files.length === 0 || revert.busy} onClick={() => void confirmRevert()}>
                  {revert.busy ? t("review.reverting") : t("review.revertConfirm", { n: revert.entry.turn.n })}
                </button>
                <button type="button" className="review-btn review-btn-quiet" disabled={revert.busy} onClick={() => setRevert(null)}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The log, stash and conflict views, kept from the git panel. */
function RepositoryTab({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<GitProjectStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [merge, setMerge] = useState<Record<string, MergeStatus>>({});
  const [conflict, setConflict] = useState<{ projectId: string; path: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);

  const refresh = useCallback(() => {
    gitStatus(sessionId)
      .then(async (s) => {
        setProjects(s.projects);
        const statuses: Record<string, MergeStatus> = {};
        for (const p of s.projects) {
          if (!p.is_git_repo) continue;
          try {
            statuses[p.project_id] = await gitMergeStatus(sessionId, p.project_id);
          } catch {
            // no merge information for this project
          }
        }
        setMerge(statuses);
      })
      .catch((e) => setError(String(e)));
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const resolve = (projectId: string) => (path: string, strategy: ConflictStrategy) => {
    gitResolveConflict(sessionId, projectId, path, strategy)
      .then(() => {
        setToast(t("review.conflictResolved", { path }));
        setConflict(null);
        refresh();
      })
      .catch((e) => setToast(String(e)));
  };

  return (
    <div className="review-repository">
      {error && <div className="review-error">{error}</div>}
      {projects.length === 0 && !error && <div className="review-empty">{t("review.noRepository")}</div>}
      {projects
        .filter((p) => p.is_git_repo)
        .map((p) => {
          const m = merge[p.project_id];
          return (
            <section className="review-repo-project" key={p.project_id} data-project={p.project_id}>
              <h3 className="review-repo-name">
                {p.project_name} {p.branch && <span className="review-repo-branch">{p.branch}</span>}
              </h3>
              {m?.in_merge && (
                <GitMergeBanner
                  mergeStatus={m}
                  onResolve={resolve(p.project_id)}
                  onViewConflict={(path) => setConflict({ projectId: p.project_id, path })}
                  onAbort={() => {
                    setAborting(true);
                    gitAbortMerge(sessionId, p.project_id)
                      .then(() => setToast(t("review.mergeAborted")))
                      .catch((e) => setToast(String(e)))
                      .finally(() => {
                        setAborting(false);
                        refresh();
                      });
                  }}
                  aborting={aborting}
                />
              )}
              <GitStashSection
                sessionId={sessionId}
                projectId={p.project_id}
                stashCount={p.stash_count}
                hasChanges={p.files.length > 0}
                onRefresh={refresh}
                onToast={(message) => setToast(message)}
              />
              <div className="review-repo-log">
                <GitLogView sessionId={sessionId} projectId={p.project_id} />
              </div>
            </section>
          );
        })}
      {toast && <div className="review-notice">{toast}</div>}
      {conflict && (
        <GitConflictViewer
          sessionId={sessionId}
          projectId={conflict.projectId}
          filePath={conflict.path}
          onResolve={resolve(conflict.projectId)}
          onClose={() => setConflict(null)}
        />
      )}
    </div>
  );
}
