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
 * primary git surface (behind the `reviewDesk` flag): their per-file stage,
 * unstage and discard, commit, push, pull and branch switch live on in its
 * Changes section (the same GitProjectSection), and the log, stash and
 * conflict views in its Repository tab.
 *
 * Keys: j/k next/previous file or turn · [ ] previous/next turn ·
 * c comment on the selected line · s send the selected turn's comments ·
 * x revert the selected turn · Esc close.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSession } from "../state/SessionContext";
import { useI18n } from "../i18n/I18nProvider";
import { getSessionEventSnapshot, subscribeSessionEvents } from "../agent/contract/sessionEventStore";
import type { SessionEvent } from "../agent/contract/events";
import type { Turn } from "../agent/contract/turns";
import { writeToSession } from "../api/sessions";
import { gitStatus, gitMergeStatus, gitResolveConflict, gitAbortMerge } from "../api/git";
import type { GitProjectStatus, MergeStatus, ConflictStrategy } from "../types/git";
import type { SessionData } from "../types/session";
import { isNotAGitRepository, reviewDiff, reviewRevertPatch, reviewRevertPreview, reviewWriteFile, type ReviewDiff, type RevertPreview } from "../review/api";
import { parsePatch, type DiffLine, type ParsedFile } from "../review/patch";
import { riskFlagsFor, type RiskFlag } from "../review/riskFlags";
import { anchorContext, commentsForSession, encodePaste, pasteLine, relocateComment, reviewMarkdown, type AnchorLine, type ReviewComment } from "../review/reviewModel";
import { deliveryReceiptAvailable, isBusy, sendReviewBack } from "../review/sendBack";
import {
  addComment,
  markSent,
  nextReviewNumber,
  removeComment,
  setDelivery,
  setReverted,
  setViewed,
  useReviewState,
} from "../review/reviewStore";
import { getBetweenFor, getTurnDiffFor, listTurnsFor } from "../review/turnSource";
import { agentDisplayName, getAgent } from "../catalog/agentCatalog";
import { translatePlural } from "../i18n/plural";
import { GitLogView } from "./GitLogView";
import { GitStashSection } from "./GitStashSection";
import { GitMergeBanner } from "./GitMergeBanner";
import { getSessionStatus, useSessionStatus } from "../agent/status/attentionStore";
import { WorktreeOverviewPanel } from "./WorktreeOverviewPanel";
import { SessionWorktreeSetup } from "./WorktreeSetupSummary";
import { isLandSheetOpen, LAND_SHEET_CLOSED_EVENT, openLandSheet, type LandSheetClosed } from "../land/LandSheetHost";
import { isFeatureFlagEnabled } from "../featureFlags";
import { GitConflictViewer } from "./GitConflictViewer";
import { GitProjectSection } from "./GitProjectSection";
import type { GitToast } from "./GitPanel";
import { useGitStatus } from "../hooks/useGitStatus";
import { draftMessage, draftSubject, type DraftInput } from "../land/draft";
import { Button, CloseButton, IconButton } from "./ui/Button";
import { Checkbox } from "./ui/Choice";
import { Textarea } from "./ui/Input";
import { Segmented } from "./ui/Segmented";
import { TabPanel, Tabs } from "./ui/Tabs";
// The kit's visually hidden text (the viewed box's label).
import "../styles/ui/badge.css";
import "../styles/components/ReviewDesk.css";

// A key name, shown as printed on the keyboard in every language.
const ESC_KEY = "Esc";

interface ReviewDeskProps {
  /** The focused session: its folder is what is reviewed. */
  sessionId: string;
  sessions: readonly SessionData[];
  onClose: () => void;
}

/** One turn of one session, with its patch parsed. */
export interface TurnEntry {
  readonly sessionId: string;
  /** The agent's name ("Claude Code"), never the session's task text. */
  readonly agentLabel: string;
  readonly turn: Turn;
  readonly patch: string;
  readonly files: readonly ParsedFile[];
  /**
   * "agent": what the turn changed. "between": what changed before turn
   * `turn.n` that no turn made (the person's edits): never reverted as the
   * agent's, never the owner of a file.
   */
  readonly kind: "agent" | "between";
}

type GroupBy = "file" | "turn";
type Tab = "review" | "repository" | "worktrees";
type Selection = { kind: "file"; path: string } | { kind: "turn"; sessionId: string; n: number; between: boolean };

const isEntry = (sel: Selection | null, e: TurnEntry) =>
  sel?.kind === "turn" && sel.sessionId === e.sessionId && sel.n === e.turn.n && sel.between === (e.kind === "between");

interface CommentDraft {
  readonly sessionId: string;
  readonly turnN: number | null;
  readonly path: string;
  readonly side: "new" | "old";
  readonly line: number;
  readonly excerpt: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** A file's diff lines as comments anchor on them. */
function anchorLines(parsed: ParsedFile): AnchorLine[] {
  const out: AnchorLine[] = [];
  for (const h of parsed.hunks)
    for (const l of h.lines) out.push(l.kind === "del" ? { side: "old", no: l.oldNo, text: l.text } : { side: "new", no: l.newNo, text: l.text });
  return out;
}

/** A path with its folder shrinking first, so the file name stays readable. */
function SplitPath({ path, className = "review-file-path" }: { path: string; className?: string }) {
  const at = path.lastIndexOf("/");
  return (
    <span className={`${className} review-path-split`} title={path}>
      {at >= 0 && <span className="review-path-dir">{path.slice(0, at + 1)}</span>}
      <span className="review-path-base">{path.slice(at + 1)}</span>
    </span>
  );
}

/** "14:05", the local time of an epoch-ms instant. */
function clock(at: number): string {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** The turn (session and number) that last touched a path, for routing a comment made in the by-file view. */
export function turnForPath(turns: readonly TurnEntry[], path: string): TurnEntry | null {
  let hit: TurnEntry | null = null;
  for (const t of turns) if (t.kind === "agent" && t.files.some((f) => f.path === path)) hit = t;
  return hit;
}

function agentLabel(session: SessionData | undefined, fallback: string): string {
  if (!session) return fallback;
  return session.label || session.agent_name || session.ai_provider || fallback;
}

/** The agent's name as people know it ("Claude Code"); the session's label only when no agent is known. */
export function agentName(session: SessionData | undefined, fallback: string): string {
  if (!session) return fallback;
  return agentDisplayName(session) ?? getAgent(session.ai_provider)?.name ?? (session.agent_name || session.ai_provider || session.label || fallback);
}

/**
 * The name of each session's agent among these sessions: "Claude Code";
 * when two run the same agent, each also carries its session's label
 * (shortened), so comments and sends can still be told apart.
 */
export function agentNames(sessions: readonly SessionData[]): Map<string, string> {
  const base = new Map(sessions.map((s) => [s.id, agentName(s, s.id.slice(0, 8))]));
  const counts = new Map<string, number>();
  for (const n of base.values()) counts.set(n, (counts.get(n) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const s of sessions) {
    const n = base.get(s.id) ?? s.id.slice(0, 8);
    const label = (s.label ?? "").trim();
    const short = label.length > 24 ? `${label.slice(0, 23)}…` : label;
    out.set(s.id, (counts.get(n) ?? 0) > 1 && short && short !== n ? `${n} (${short})` : n);
  }
  return out;
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
  // The session's status as Hermes shows it: an agent's own "working" is
  // not undone by the terminal's guesses (launchHelper flag) while it works
  // quietly, so nothing is typed into a busy agent.
  status: (sessionId: string) => getSessionStatus(sessionId),
};

/** "Send now" for a send held while the agent worked: enabled only once the turn has ended. */
function SendNowButton({ sessionId, label, onClick }: { sessionId: string; label: string; onClick: () => void }) {
  const busy = isBusy(useSessionStatus(sessionId));
  return (
    <Button size="sm" className="review-send-now-btn" disabled={busy} data-busy={busy ? "1" : "0"} onClick={onClick}>
      {label}
    </Button>
  );
}

/** A file's "viewed" box. Its row selects the file on click; the box must not. */
function ViewedBox({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <span className="review-viewed-wrap" onClick={(e) => e.stopPropagation()} title={label}>
      <Checkbox className="review-viewed" checked={checked} onChange={onChange} label={<span className="h-visually-hidden">{label}</span>} />
    </span>
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
  // The folder is not a git repository (or the session has none): a plain empty state, not an error.
  const [noRepository, setNoRepository] = useState(false);
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
  const tabPrefix = `review-desk-${useId().replace(/:/g, "")}`;

  // Sessions working in the same folder: their turns belong to this review.
  const sameFolder = sessions.filter((s) => s.working_directory && normalizePath(s.working_directory) === normalizePath(repoPath));
  // Only which sessions they are and their names matter here: a status
  // update (new session objects, many times a minute) must not reload the
  // review, which would hide the diff and an open comment while it loads.
  const folderNames = agentNames(sameFolder);
  const repoSessionsKey = sameFolder.map((s) => `${s.id}\u0000${folderNames.get(s.id)}`).join("\u0001");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const repoSessions = useMemo(() => sameFolder, [repoSessionsKey]);
  const names = useMemo(() => agentNames(repoSessions), [repoSessions]);
  /** A session's agent, by name ("Claude Code"), for every label in the desk. */
  const nameOf = useCallback((id: string) => names.get(id) ?? agentName(sessions.find((s) => s.id === id), id.slice(0, 8)), [names, sessions]);

  const load = useCallback(async () => {
    if (!repoPath) {
      setLoading(false);
      setDiffError(null);
      setNoRepository(true);
      return;
    }
    setLoading(true);
    setDiffError(null);
    setNoRepository(false);
    const [diffResult, turnResult] = await Promise.all([
      reviewDiff(repoPath).then((d) => ({ ok: true as const, d })).catch((e: unknown) => ({ ok: false as const, e })),
      Promise.all(
        repoSessions.map(async (s) => {
          const list = await listTurnsFor(s.id);
          const name = names.get(s.id) ?? agentName(s, s.id.slice(0, 8));
          const entries = await Promise.all(
            list.map(async (turn) => {
              const [td, between] = await Promise.all([getTurnDiffFor(s.id, turn.n), getBetweenFor(s.id, turn.n)]);
              const patch = td?.patch ?? "";
              const out: TurnEntry[] = [];
              // What changed before this turn that no turn made: the person's own row.
              if (between && between.patch.trim() !== "") {
                out.push({
                  sessionId: s.id,
                  agentLabel: name,
                  turn: { ...turn, startedAt: between.at, endedAt: between.at, diffstat: between.diffstat, degraded: false, checks: undefined },
                  patch: between.patch,
                  files: parsePatch(between.patch),
                  kind: "between",
                });
              }
              out.push({ sessionId: s.id, agentLabel: name, turn, patch, files: parsePatch(patch), kind: "agent" });
              return out;
            }),
          );
          return entries.flat();
        }),
      ),
    ]);
    if (diffResult.ok) setDiff(diffResult.d);
    else if (isNotAGitRepository(diffResult.e)) setNoRepository(true);
    else setDiffError(String(diffResult.e));
    setTurns(
      turnResult
        .flat()
        .sort((a, b) => a.turn.startedAt - b.turn.startedAt || a.turn.n - b.turn.n || (a.kind === "between" ? -1 : b.kind === "between" ? 1 : 0)),
    );
    setLoading(false);
  }, [repoPath, repoSessions, names]);

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
  // The Changes section's commit message starts from the turns (as the Land
  // sheet drafts it). Without turns it is only the subject (from the branch):
  // the review's totals cover the whole branch, not what is staged.
  const commitDraft = useMemo(() => {
    if (!diff) return "";
    // Only a task's own branch (hermes/...) gets a drafted message: on a
    // person's branch ("main") the branch name says nothing about the change.
    if (!(diff.branch ?? "").startsWith("hermes/")) return "";
    const input: DraftInput = {
      branch: diff.branch ?? "",
      label: focused ? agentLabel(focused, focused.id.slice(0, 8)) : "",
      turns: turns.map((e) => ({ turn: e.turn, files: e.files.map((f) => f.path) })),
      feature: null,
      diffstat: { files: files.length, insertions: totals.add, deletions: totals.del },
    };
    return input.turns.length > 0 ? draftMessage(input) : draftSubject(input);
  }, [diff, focused, turns, files.length, totals]);
  const reloadReview = useCallback(() => setReloadTick((x) => x + 1), []);
  const selectChangedFile = useCallback((path: string) => {
    setGroupBy("file");
    setSelection({ kind: "file", path });
  }, []);

  // Keep the selection valid when the data changes.
  useEffect(() => {
    if (loading) return;
    if (groupBy === "file") {
      if (selection?.kind === "file" && files.some((f) => f.file.path === selection.path)) return;
      setSelection(files.length > 0 ? { kind: "file", path: files[0].file.path } : null);
    } else {
      if (selection?.kind === "turn" && turns.some((e) => isEntry(selection, e))) return;
      setSelection(turns.length > 0 ? { kind: "turn", sessionId: turns[0].sessionId, n: turns[0].turn.n, between: turns[0].kind === "between" } : null);
    }
  }, [loading, groupBy, files, turns, selection]);

  const selectedTurn = selection?.kind === "turn" ? turns.find((e) => isEntry(selection, e)) ?? null : null;
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
        const i = Math.max(0, turns.findIndex((e) => isEntry(selection, e)));
        const next = turns[(i + delta + turns.length) % turns.length];
        setSelection({ kind: "turn", sessionId: next.sessionId, n: next.turn.n, between: next.kind === "between" });
      }
    },
    [groupBy, files, turns, selection],
  );

  const moveTurn = useCallback(
    (delta: number) => {
      if (turns.length === 0) return;
      setGroupBy("turn");
      const i = Math.max(0, turns.findIndex((e) => isEntry(selection, e)));
      const next = turns[(i + delta + turns.length) % turns.length];
      setSelection({ kind: "turn", sessionId: next.sessionId, n: next.turn.n, between: next.kind === "between" });
    },
    [turns, selection],
  );

  const startComment = useCallback(
    (path: string, line: DiffLine, entry: TurnEntry | null, parsed: ParsedFile) => {
      const routed = entry && entry.kind === "agent" ? entry : turnForPath(turns, path);
      const side: "new" | "old" = line.kind === "del" ? "old" : "new";
      const no = side === "old" ? line.oldNo : line.newNo;
      if (no === null) return;
      // Kept with the comment so it finds its line again after the next turn.
      const lines = anchorLines(parsed);
      const index = lines.findIndex((l) => l.side === side && l.no === no);
      const context = index >= 0 ? anchorContext(lines, index) : { before: [], after: [] };
      setDraft({
        sessionId: routed?.sessionId ?? sessionId,
        turnN: routed?.turn.n ?? null,
        path,
        side,
        line: no,
        excerpt: line.text,
        before: context.before,
        after: context.after,
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
      const label = nameOf(sid);
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
    [sessions, repoPath, diff?.branch, dispatch, review.deliveries, nameOf],
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
      if (entry.kind !== "agent") return;
      setRevert({ entry, preview: null, error: null, busy: false });
      try {
        const preview = await reviewRevertPreview(repoPath, entry.patch);
        // Reverted before (from here or by hand): say so instead of a conflict.
        setReverted(repoPath, entry.sessionId, entry.turn.n, !!preview.alreadyReverted);
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
      const n = revert.entry.turn.n;
      if (result.ok || result.method === "already") {
        setReverted(repoPath, revert.entry.sessionId, n, true);
        setNotice(result.method === "already" ? t("review.alreadyReverted", { n }) : result.method === "3way" ? t("review.revertedThreeWay", { n }) : t("review.reverted", { n }));
        setRevert(null);
        setReloadTick((x) => x + 1);
      } else {
        setNotice(t("review.revertFailed", { n, message: result.message }));
        setRevert({ ...revert, busy: false, error: result.message });
      }
    } catch (e) {
      setNotice(t("review.revertFailed", { n: revert.entry.turn.n, message: String(e) }));
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
      // The Land sheet over the desk has the keys (Esc closes the sheet, not the desk).
      if (isLandSheetOpen()) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
      if (e.key === "Escape") {
        e.preventDefault();
        if (revert) setRevert(null);
        else if (draft) setDraft(null);
        // In another text field (the commit message): leave the field, keep the desk and the text.
        else if (typing) target.blur();
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

  // The Land sheet opened from here: Cancel brings the person back to the
  // desk; the desk closes only once a land or an archive went through.
  useEffect(() => {
    const onClosed = (e: Event) => {
      const detail = (e as CustomEvent<LandSheetClosed>).detail;
      if (detail?.sessionId === sessionId && detail.landed) onClose();
    };
    window.addEventListener(LAND_SHEET_CLOSED_EVENT, onClosed);
    return () => window.removeEventListener(LAND_SHEET_CLOSED_EVENT, onClosed);
  }, [sessionId, onClose]);

  const viewedSet = useMemo(() => new Set(review.viewed), [review.viewed]);
  const revertedSet = useMemo(() => new Set(review.reverted), [review.reverted]);
  const commentsFor = (path: string) => review.comments.filter((c) => c.path === path);

  const renderFile = (parsed: ParsedFile | null, file: { path: string; isBinary: boolean; truncated: boolean; status: string }, entry: TurnEntry | null) => {
    const comments = commentsFor(file.path);
    if (!parsed) return <div className="review-empty">{t("review.noTextDiff")}</div>;
    if (file.isBinary) return <div className="review-empty">{t("review.binaryFile")}</div>;
    if (file.truncated) return <div className="review-empty">{t("review.truncated")}</div>;
    // Each comment finds its line again by its text and the lines around
    // it (the next turn may have moved it); one whose line is gone is shown
    // on top, marked outdated.
    const lines = anchorLines(parsed);
    const placed = new Map<string, { at: number | null; c: ReviewComment }>();
    for (const c of comments) placed.set(c.id, { at: relocateComment(c, lines), c });
    const outdated = [...placed.values()].filter((p) => p.at === null).map((p) => p.c);
    const renderComment = (c: ReviewComment, isOutdated: boolean) => (
      <div className={`review-comment${isOutdated ? " review-comment-outdated" : ""}`} key={c.id} data-session={c.sessionId} data-turn={c.turnN ?? ""} data-sent={sentOf(c.id) ?? ""} data-outdated={isOutdated ? "1" : "0"}>
        {isOutdated && (
          <span className="review-comment-outdated-badge" title={t("review.outdatedTitle", { line: c.line, excerpt: c.excerpt.trim().slice(0, 80) })}>
            {t("review.outdated")}
          </span>
        )}
        <span className="review-comment-route">
          {t("review.toAgent", { agent: nameOf(c.sessionId) })}
          {c.turnN !== null ? ` · T${c.turnN}` : ""}
          {sentOf(c.id) !== null ? ` · ${t("review.sentAs", { n: sentOf(c.id) ?? 0 })}` : ""}
        </span>
        <span className="review-comment-text">{c.text}</span>
        {sentOf(c.id) === null && <CloseButton className="review-comment-remove" onClick={() => removeComment(repoPath, c.id)} label={t("review.removeComment")} />}
      </div>
    );
    return (
      <div className="review-hunks">
        {outdated.map((c) => renderComment(c, true))}
        {parsed.hunks.map((h, hi) => (
          <div className="review-hunk" key={hi}>
            <div className="review-hunk-header">{h.header}</div>
            {h.lines.map((line, li) => {
              const side: "new" | "old" = line.kind === "del" ? "old" : "new";
              const no = side === "old" ? line.oldNo : line.newNo;
              const here = comments.filter((c) => c.side === side && no !== null && placed.get(c.id)?.at === no);
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
                    onClick={() => startComment(file.path, line, entry, parsed)}
                  >
                    <span className="review-line-no">{line.oldNo ?? ""}</span>
                    <span className="review-line-no">{line.newNo ?? ""}</span>
                    <span className="review-line-mark">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
                    <span className="review-line-text">{line.text}</span>
                  </div>
                  {here.map((c) => renderComment(c, false))}
                  {isDraft && (
                    <div className="review-comment-editor">
                      <Textarea
                        ref={draftRef}
                        value={draftText}
                        placeholder={t("review.commentPlaceholder", { agent: nameOf(draft.sessionId) })}
                        onChange={(e) => setDraftText(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveComment();
                        }}
                        rows={3}
                      />
                      <div className="review-comment-editor-actions">
                        <Button size="sm" variant="quiet" onClick={() => setDraft(null)}>
                          {t("common.cancel")}
                        </Button>
                        <Button size="sm" variant="primary" className="review-comment-save" onClick={saveComment} disabled={!draftText.trim()}>
                          {t("review.addComment")}
                        </Button>
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
      <Button
        size="sm"
        variant="quiet"
        className="review-copy-line-btn"
        onClick={() => navigator.clipboard.writeText(pasteLine(n, d.filePath ?? "")).catch(() => {})}
      >
        {t("review.copyLine")}
      </Button>
    );
    return (
      <span className={`review-delivery review-delivery-${d.kind}`} data-state={d.kind} data-n={n}>
        <span className="review-delivery-glyph" aria-hidden="true">
          {glyph}
        </span>
        {t("review.reviewN", { n })} · {label}
        {d.kind === "waiting" && <SendNowButton sessionId={d.sessionId} label={t("review.sendNow")} onClick={() => void resend(n)} />}
        {(d.kind === "not_delivered" || d.kind === "failed") && (
          <Button size="sm" className="review-retry-btn" onClick={() => void resend(n)}>
            {t("review.retry")}
          </Button>
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
          const label = nameOf(sid);
          const gone = !session || session.phase === "destroyed";
          return (
            <div className="review-send" key={sid} data-session={sid} data-unsent={unsent.length}>
              <span className="review-send-label">
                {translatePlural("review.commentsToSend", unsent.length, { agent: label })}
              </span>
              <Button
                size="sm"
                className="review-send-btn"
                disabled={unsent.length === 0 || gone}
                title={gone ? t("review.sessionGone") : t("review.sendHint")}
                onClick={() => void send(sid)}
              >
                {t("review.sendTo", { agent: label })}
              </Button>
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
          <Tabs<Tab>
            idPrefix={tabPrefix}
            className="review-tabs"
            tabClassName="review-tab"
            label={t("review.title")}
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "review", label: t("review.tabReview") },
              { value: "repository", label: t("review.tabRepository") },
              // Disk guard (diskGuard flag): the Worktrees view of the git panel this desk replaces.
              ...(isFeatureFlagEnabled("diskGuard") ? [{ value: "worktrees" as const, label: t("review.tabWorktrees") }] : []),
            ]}
          />
          <LandButtons sessionId={sessionId} />
          <CloseButton className="review-close" onClick={onClose} label={t("common.close")} title={ESC_KEY} />
        </header>

        {tab === "review" && (
          <TabPanel idPrefix={tabPrefix} value="review" className="review-tabpanel">
            <div className="review-toolbar">
              <Segmented<GroupBy>
                className="review-group"
                size="sm"
                label={t("review.groupBy")}
                value={groupBy}
                onChange={setGroupBy}
                options={[
                  { value: "file", label: t("review.byFile") },
                  { value: "turn", label: t("review.byTurn") },
                ]}
              />
              <span className="review-summary" data-files={files.length} data-flags={flagCount} data-viewed={review.viewed.filter((p) => files.some((f) => f.file.path === p)).length}>
                {translatePlural("review.summaryFiles", files.length, { add: totals.add, del: totals.del })}
                {" · "}
                {t("review.viewedCount", { viewed: review.viewed.filter((p) => files.some((f) => f.file.path === p)).length, files: files.length })}
                {flagCount > 0 && (
                  <>
                    {" · "}
                    <span className="review-summary-flags">{translatePlural("review.riskFlags", flagCount)}</span>
                  </>
                )}
              </span>
              <IconButton size="sm" className="review-refresh" onClick={() => setReloadTick((x) => x + 1)} label={t("review.refresh")} icon="↻" />
            </div>

            <div className="review-body">
              <nav className="review-nav" aria-label={groupBy === "file" ? t("review.byFile") : t("review.byTurn")}>
                <ChangesSection sessionId={sessionId} draft={commitDraft} fromTurns={turns.length > 0} onChanged={reloadReview} onSelectFile={selectChangedFile} />
                {loading && <div className="review-empty">{t("review.loading")}</div>}
                {!loading && diffError && <div className="review-error">{diffError}</div>}
                {!loading && noRepository && (
                  <div className="review-empty" data-empty="no-repository">
                    {t("review.noRepository")}
                  </div>
                )}
                {!loading && !diffError && !noRepository && groupBy === "file" && files.length === 0 && <div className="review-empty">{t("review.nothingChanged")}</div>}
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
                      <ViewedBox checked={viewedSet.has(file.path)} label={t("review.viewed")} onChange={(v) => setViewed(repoPath, file.path, v)} />
                      <span className={`review-file-status review-file-status-${file.status}`}>{file.status[0].toUpperCase()}</span>
                      <SplitPath path={file.path} />
                      <span className="review-file-stat">
                        <span className="review-add">+{file.additions}</span> <span className="review-del">−{file.deletions}</span>
                      </span>
                      {flagBadges(file.path)}
                    </div>
                  ))}
                {!loading && groupBy === "turn" && turns.length === 0 && <div className="review-empty">{t("review.noTurns")}</div>}
                {!loading && groupBy === "turn" &&
                  turns.map((entry) => {
                    const between = entry.kind === "between";
                    const reverted = !between && revertedSet.has(`${entry.sessionId}:${entry.turn.n}`);
                    return (
                      <div
                        key={`${entry.sessionId}:${between ? "b" : "t"}${entry.turn.n}`}
                        className={`review-turn-row${isEntry(selection, entry) ? " review-row-selected" : ""}`}
                        data-session={entry.sessionId}
                        data-turn={entry.turn.n}
                        data-kind={entry.kind}
                        data-reverted={reverted ? "1" : "0"}
                        onClick={() => setSelection({ kind: "turn", sessionId: entry.sessionId, n: entry.turn.n, between })}
                      >
                        <span className="review-turn-n">{between ? "·" : `T${entry.turn.n}`}</span>
                        <span className="review-turn-agent">{between ? t("review.betweenTurns") : `${entry.agentLabel} · ${clock(entry.turn.startedAt)}`}</span>
                        {reverted && <span className="review-turn-reverted">{t("review.turnReverted")}</span>}
                        <span className="review-file-stat">
                          {translatePlural("review.fileCount", entry.turn.diffstat.files)} · <span className="review-add">+{entry.turn.diffstat.insertions}</span>{" "}
                          <span className="review-del">−{entry.turn.diffstat.deletions}</span>
                        </span>
                      </div>
                    );
                  })}
              </nav>

              <section className="review-main" aria-live="polite">
                {notice && <div className="review-notice">{notice}</div>}
                {!loading && groupBy === "file" && selectedFile && (
                  <>
                    <div className="review-main-head">
                      <SplitPath path={selectedFile.file.path} className="review-main-path" />
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
                        {selectedTurn.kind === "between" ? t("review.betweenTurnsBefore", { n: selectedTurn.turn.n }) : `T${selectedTurn.turn.n} · ${selectedTurn.agentLabel}`}
                      </span>
                      {selectedTurn.kind === "agent" && revertedSet.has(`${selectedTurn.sessionId}:${selectedTurn.turn.n}`) && <span className="review-turn-reverted">{t("review.turnReverted")}</span>}
                      {/* The person's own edits are never reverted as a turn. */}
                      {selectedTurn.kind === "agent" && (
                        <Button size="sm" className="review-revert-btn" onClick={() => void openRevert(selectedTurn)}>
                          {t("review.revertTurn", { n: selectedTurn.turn.n })}
                        </Button>
                      )}
                    </div>
                    {selectedTurn.files.length === 0 && <div className="review-empty">{t("review.noChangeTurn")}</div>}
                    {selectedTurn.files.map((pf) => (
                      <div className="review-turn-file" key={pf.path} data-path={pf.path}>
                        <div className="review-turn-file-head">
                          <ViewedBox checked={viewedSet.has(pf.path)} label={t("review.viewed")} onChange={(v) => setViewed(repoPath, pf.path, v)} />
                          <SplitPath path={pf.path} />
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
              {t("review.keySend")} · <kbd>x</kbd> {t("review.keyRevert")} · <kbd>{ESC_KEY}</kbd> {t("common.close")}
            </footer>
          </TabPanel>
        )}

        {tab === "repository" && (
          <TabPanel idPrefix={tabPrefix} value="repository" className="review-tabpanel">
            <RepositoryTab sessionId={sessionId} />
          </TabPanel>
        )}
        {tab === "worktrees" && (
          <TabPanel idPrefix={tabPrefix} value="worktrees" className="review-tabpanel review-worktrees">
            <WorktreeOverviewPanel />
          </TabPanel>
        )}

        {revert && (
          <div className="review-revert-backdrop" onClick={() => !revert.busy && setRevert(null)}>
            <div className="review-revert-preview" role="dialog" aria-modal="true" aria-label={t("review.revertTurn", { n: revert.entry.turn.n })} onClick={(e) => e.stopPropagation()}>
              <h3>{t("review.revertTurn", { n: revert.entry.turn.n })}</h3>
              <p className="review-revert-who">{revert.entry.agentLabel}</p>
              {!revert.preview && !revert.error && <div className="review-empty">{t("review.loading")}</div>}
              {revert.preview && (
                <>
                  <p
                    className={`review-revert-clean review-revert-clean-${revert.preview.clean ? "yes" : "no"}`}
                    data-clean={revert.preview.clean ? "1" : "0"}
                    data-already={revert.preview.alreadyReverted ? "1" : "0"}
                  >
                    {revert.preview.alreadyReverted
                      ? t("review.alreadyReverted", { n: revert.entry.turn.n })
                      : revert.preview.clean
                        ? t("review.revertClean")
                        : t("review.revertNotClean", { message: revert.preview.message })}
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
                <Button disabled={revert.busy} onClick={() => setRevert(null)}>
                  {t("common.cancel")}
                </Button>
                <Button variant="danger-solid" className="review-revert-confirm" disabled={!revert.preview || revert.preview.files.length === 0 || !!revert.preview.alreadyReverted || revert.busy} onClick={() => void confirmRevert()}>
                  {revert.busy ? t("review.reverting") : t("review.revertConfirm", { n: revert.entry.turn.n })}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Land sheet's entry point (landSheet flag), which lived in the git
 * panel this desk replaces: one button per project the session works on in
 * a worktree of its own. The sheet opens over the desk: Cancel brings the
 * person back to it, and it closes once a land or an archive went through.
 */
function LandButtons({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [landable, setLandable] = useState<GitProjectStatus[]>([]);
  useEffect(() => {
    if (!isFeatureFlagEnabled("landSheet")) return;
    let live = true;
    gitStatus(sessionId)
      .then((s) => {
        if (live) setLandable(s.projects.filter((p) => p.is_git_repo && /hermes-worktrees[\\/]/.test(p.project_path)));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sessionId]);
  return (
    <>
      {landable.map((project) => (
        <Button
          key={project.project_id}
          variant="primary"
          className="review-land-btn"
          data-project-id={project.project_id}
          onClick={() => openLandSheet(sessionId, project.project_id)}
          title={t("review.landTitle")}
        >
          {landable.length === 1 ? t("review.land") : t("review.landProject", { project: project.project_name })}
        </Button>
      ))}
    </>
  );
}

/**
 * Changes (reviewDesk flag): the git actions of the panels this desk
 * replaced, mounted from the same GitProjectSection — per-file stage,
 * unstage and discard (discard asks first), commit (the message starts from
 * a draft of the turns), push, pull and the branch switch. Log, stash and
 * conflicts stay in the Repository tab.
 */
function ChangesSection({
  sessionId,
  draft,
  fromTurns,
  onChanged,
  onSelectFile,
}: {
  sessionId: string;
  draft: string;
  /** The draft lists the turns ("drafted from the turns"); else it is only a subject. */
  fromTurns: boolean;
  onChanged: () => void;
  onSelectFile: (path: string) => void;
}) {
  const { t } = useI18n();
  const { status, error, refresh } = useGitStatus(sessionId, true, 3000);
  const [toast, setToast] = useState<GitToast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  const onRefresh = useCallback(() => {
    void refresh();
    onChanged();
  }, [refresh, onChanged]);
  const onToast = useCallback((message: string, type: GitToast["type"] = "success") => setToast({ message, type }), []);
  const projects = (status?.projects ?? []).filter((p) => p.is_git_repo);
  if (!status && !error) return null;
  return (
    <section className="review-changes" aria-label={t("review.changes")} data-projects={projects.length}>
      <div className="review-changes-title">{t("review.changes")}</div>
      {error && <div className="review-error">{error}</div>}
      {projects.map((p) => (
        <GitProjectSection
          key={p.project_id}
          sessionId={sessionId}
          projectId={p.project_id}
          project={p}
          onRefresh={onRefresh}
          onDiffFile={(_sid, _pid, file) => onSelectFile(file.path)}
          onToast={onToast}
          variant="changes"
          draftMessage={draft}
          commitLabel={t(fromTurns ? "review.commitDrafted" : "review.commitMessage")}
        />
      ))}
      {toast && (
        <div className={`review-changes-toast git-toast-${toast.type}`} role="status" data-type={toast.type}>
          {toast.message}
        </div>
      )}
    </section>
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
      {error && !isNotAGitRepository(error) && <div className="review-error">{error}</div>}
      {!projects.some((p) => p.is_git_repo) && (!error || isNotAGitRepository(error)) && (
        <div className="review-empty" data-empty="no-repository">
          {t("review.noRepository")}
        </div>
      )}
      {projects
        .filter((p) => p.is_git_repo)
        .map((p) => {
          const m = merge[p.project_id];
          return (
            <section className="review-repo-project" key={p.project_id} data-project={p.project_id}>
              <h3 className="review-repo-name">
                {p.project_name} {p.branch && <span className="review-repo-branch">{p.branch}</span>}
              </h3>
              {/* Fast worktrees (diskGuard flag): ports and cloned dependencies, as the git panel shows them. */}
              {isFeatureFlagEnabled("diskGuard") && <SessionWorktreeSetup sessionId={sessionId} projectId={p.project_id} />}
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
