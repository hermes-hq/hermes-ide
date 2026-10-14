import "../styles/components/TurnBar.css";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { translate } from "../i18n/registry";
import { translatePlural } from "../i18n/plural";
import { Button, CloseButton, cx } from "./ui/Button";
import { Chip } from "./ui/Chip";
import { getTurnDiff, listTurns, type Turn, type TurnChecks } from "../agent/contract/turns";
import { getSessionEventSnapshot } from "../agent/contract/sessionEventStore";
import { withTurnChecks } from "../agent/turns/turnChecks";
import { useDoneWhen } from "../doneWhen/store";
import { basename } from "../utils/paths";
import {
  previewRestoreTurn,
  restoreTurn,
  undoRestoreTurn,
  TURN_LEDGER_EVENT,
  type RestorePreview,
  type TurnLedgerEvent,
} from "../agent/turns/turnLedgerApi";

/**
 * F20 — the turn bar under a terminal session (feature flag `turnLedger`).
 *
 * Labelled "Agent replies", with an (i) that says what the chips are. One
 * chip per recorded turn (T1, T2, ...) with its diffstat, as many of the
 * newest as fit (a ResizeObserver measures); the rest sit behind a leading
 * "+N earlier" chip that opens a list of every turn. A chip opens
 * the turn's diff; from there "Restore to Tn" previews what restoring would
 * change and only restores after a confirmation; what was there before (the
 * person's own edits included) is set aside, and the notice that follows
 * offers Undo, which brings it back. Turns arrive from the
 * backend ledger (`hermes:turn-ledger`); the bar renders nothing while a
 * session has no turn. A turn whose Done-When checks ran (F27) carries
 * their result (`Turn.checks`): a mark on the chip and a line in its title.
 */

interface TurnBarProps {
  sessionId: string;
  /** The session's working directory: the only folder the ledger snapshots. */
  workingDirectory?: string;
  /** The session's other folders (extra folders, attached projects); the
   *  ones outside the working directory are not tracked, and the bar says so. */
  folders?: readonly string[];
  /** A short pane: one "Replies · N" chip in the pane header that opens the list of every reply. */
  compact?: boolean;
}

const TurnList = lazy(() => import("./TurnList"));

/** Whether a folder lies outside `cwd` (one inside it is in the snapshot). */
function anyOutside(cwd: string, folders: readonly string[]): boolean {
  const root = cwd.replace(/[\\/]+$/, "");
  return folders.some((f) => {
    const p = f.replace(/[\\/]+$/, "");
    return !!p && p !== root && !p.startsWith(`${root}/`) && !p.startsWith(`${root}\\`);
  });
}

/**
 * How many of the newest chips fit in `avail` px: all of them, or as many
 * as fit beside the "+N earlier" chip (at least one). An unmeasured chip
 * counts as the widest measured one; nothing laid out (avail 0) shows all.
 */
function fitCount(ns: readonly number[], widths: ReadonlyMap<number, number>, avail: number, gap: number, more: number): number {
  if (avail <= 0) return ns.length;
  const guess = Math.max(0, ...widths.values());
  const w = (n: number) => widths.get(n) ?? guess;
  const all = ns.reduce((sum, n) => sum + w(n), 0) + gap * Math.max(0, ns.length - 1);
  if (all <= avail) return ns.length;
  let used = more;
  let k = 0;
  for (let i = ns.length - 1; i >= 0; i--) {
    const next = used + gap + w(ns[i]);
    if (next > avail) break;
    used = next;
    k++;
  }
  return Math.max(1, k);
}

type Sheet =
  | { kind: "diff"; turn: Turn; patch: string | null; error: string | null }
  | { kind: "restore"; turn: Turn; preview: RestorePreview | null; error: string | null; busy: boolean };

const NOTICE_MS = 4000;
/** A restore's notice carries Undo; it stays long enough to use it. */
const UNDO_NOTICE_MS = 15_000;

interface Notice {
  readonly text: string;
  /** The set-aside state Undo goes back to (a restore's notice). */
  readonly undo?: number;
}

/** The Done-When result of a turn, for its chip's title. */
function checksText(checks: TurnChecks): string {
  if (checks.state === "passed") return translate("doneWhen.chip.passed");
  if (checks.state === "error") return translate("doneWhen.chip.error");
  return translate("doneWhen.inboxFailed", { commands: checks.failed.join(", ") });
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "turn-diff-line turn-diff-line-hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "turn-diff-line turn-diff-line-header";
  if (line.startsWith("diff --git")) return "turn-diff-line turn-diff-line-file";
  if (line.startsWith("+")) return "turn-diff-line turn-diff-line-add";
  if (line.startsWith("-")) return "turn-diff-line turn-diff-line-del";
  return "turn-diff-line";
}

function Patch({ patch }: { patch: string }) {
  if (patch.trim() === "") return <div className="turn-diff-empty">{translate("turnBar.noChanges")}</div>;
  return (
    <pre className="turn-diff-text">
      {patch.split("\n").map((line, i) => (
        <div key={i} className={diffLineClass(line)}>
          {line}
        </div>
      ))}
    </pre>
  );
}

export function TurnBar({ sessionId, workingDirectory, folders, compact = false }: TurnBarProps) {
  const [ledgerTurns, setTurns] = useState<Turn[]>([]);
  const doneWhen = useDoneWhen(sessionId);
  // Turn.checks (F20 x F27): the Done-When result of each recorded turn.
  const turns = useMemo(
    () => withTurnChecks(ledgerTurns, getSessionEventSnapshot(sessionId).events, (n) => doneWhen.byTurn[n] ?? null),
    [ledgerTurns, doneWhen, sessionId],
  );
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The restore this bar asked for: its own notice (with Undo) stands. */
  const ownRestore = useRef<number | null>(null);
  const turnsRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const chipWidths = useRef(new Map<number, number>());
  const moreWidth = useRef(0);
  const [avail, setAvail] = useState(0);
  const [fit, setFit] = useState(Number.POSITIVE_INFINITY);
  const [listOpen, setListOpen] = useState(false);

  const scopeNote =
    workingDirectory && anyOutside(workingDirectory, folders ?? []) ? translate("turnBar.onlyProject", { project: basename(workingDirectory) }) : null;
  // What the chips are (the label's tooltip), and which folder they cover.
  const help = translate("turnBar.help") + (scopeNote ? `\n\n${scopeNote}` : "");

  const showNotice = useCallback((text: string, undo?: number) => {
    setNotice({ text, undo });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), undo === undefined ? NOTICE_MS : UNDO_NOTICE_MS);
  }, []);

  const reload = useCallback(() => {
    listTurns(sessionId)
      .then(setTurns)
      .catch((e) => console.warn("[turn-bar] could not list turns:", e));
  }, [sessionId]);

  useEffect(() => {
    reload();
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<TurnLedgerEvent>(TURN_LEDGER_EVENT, (event) => {
      if (cancelled || event.payload.sessionId !== sessionId) return;
      reload();
      if (typeof event.payload.restoredTo === "number" && event.payload.restoredTo !== ownRestore.current) {
        showNotice(translate("turnBar.restored", { n: event.payload.restoredTo }));
      }
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch((e) => console.warn("[turn-bar] could not listen for turns:", e));
    return () => {
      cancelled = true;
      unlisten?.();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [sessionId, reload, showNotice]);

  const openDiff = useCallback(
    (turn: Turn) => {
      setSheet({ kind: "diff", turn, patch: null, error: null });
      getTurnDiff(sessionId, turn.n)
        .then((d) => {
          setSheet((cur) =>
            cur?.kind === "diff" && cur.turn.n === turn.n ? { ...cur, patch: d?.patch ?? "" } : cur,
          );
        })
        .catch((e) => {
          setSheet((cur) =>
            cur?.kind === "diff" && cur.turn.n === turn.n ? { ...cur, error: String(e) } : cur,
          );
        });
    },
    [sessionId],
  );

  const openRestore = useCallback(
    (turn: Turn) => {
      setSheet({ kind: "restore", turn, preview: null, error: null, busy: false });
      previewRestoreTurn(sessionId, turn.n)
        .then((preview) => {
          setSheet((cur) =>
            cur?.kind === "restore" && cur.turn.n === turn.n
              ? { ...cur, preview: preview ?? { turn, patch: "", diffstat: { files: 0, insertions: 0, deletions: 0 } } }
              : cur,
          );
        })
        .catch((e) => {
          setSheet((cur) =>
            cur?.kind === "restore" && cur.turn.n === turn.n ? { ...cur, error: String(e) } : cur,
          );
        });
    },
    [sessionId],
  );

  const confirmRestore = useCallback(
    (turn: Turn) => {
      setSheet((cur) => (cur?.kind === "restore" ? { ...cur, busy: true, error: null } : cur));
      ownRestore.current = turn.n;
      restoreTurn(sessionId, turn.n)
        .then((result) => {
          setSheet(null);
          showNotice(translate("turnBar.restored", { n: turn.n }), result?.setAside ?? undefined);
          reload();
        })
        .catch((e) => {
          setSheet((cur) => (cur?.kind === "restore" ? { ...cur, busy: false, error: String(e) } : cur));
        });
    },
    [sessionId, reload, showNotice],
  );

  const undoRestore = useCallback(
    (k: number) => {
      setNotice(null);
      undoRestoreTurn(sessionId, k)
        .then(() => {
          ownRestore.current = null;
          showNotice(translate("turnBar.undoneRestore"));
          reload();
        })
        .catch((e) => showNotice(translate("turnBar.failed", { error: String(e) })));
    },
    [sessionId, reload, showNotice],
  );

  const close = useCallback(() => setSheet(null), []);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, close]);

  const visible = turns.length > 0 || !!notice;
  // The space the chips have, followed as the pane is resized.
  useEffect(() => {
    const el = turnsRef.current;
    if (!visible || !el) return;
    setAvail(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  // Measure the chips on screen and keep the newest that fit (before paint).
  useLayoutEffect(() => {
    const el = turnsRef.current;
    if (!el) return;
    for (const chip of el.querySelectorAll<HTMLElement>(".turn-bar-turn")) chipWidths.current.set(Number(chip.dataset.turnN), chip.offsetWidth);
    if (moreRef.current) moreWidth.current = moreRef.current.offsetWidth;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    setFit(fitCount(turns.map((t) => t.n), chipWidths.current, avail, gap, moreWidth.current));
  }, [turns, avail, fit]);

  const titleOf = useCallback((turn: Turn) => {
    const { files, insertions, deletions } = turn.diffstat;
    const base = turn.degraded
      ? translate("turnBar.summaryOnly", { n: turn.n })
      : translatePlural("turnBar.turnChanged", files, { n: turn.n, insertions, deletions });
    return turn.checks ? `${base} · ${checksText(turn.checks)}` : base;
  }, []);

  const closeList = useCallback((focusAnchor: boolean) => {
    setListOpen(false);
    if (focusAnchor) moreRef.current?.focus();
  }, []);

  if (!visible) return null;

  const shown = compact ? [] : turns.slice(Math.max(0, turns.length - fit));
  const hidden = turns.length - shown.length;
  const allLabel = translate("turnBar.allReplies", { count: turns.length });

  const noticeNode = notice && (
    <span className={`turn-bar-notice${notice.undo !== undefined ? " turn-bar-notice-undo" : ""}`} role="status" title={notice.text}>
      <span className="turn-bar-notice-text">{notice.text}</span>
      {notice.undo !== undefined && (
        <Button size="sm" variant="quiet" className="turn-bar-undo" onClick={() => undoRestore(notice.undo as number)}>
          {translate("turnBar.undo")}
        </Button>
      )}
    </span>
  );

  return (
    <>
      {compact ? (
        <span className="turn-bar-compact" data-session-turns={sessionId} data-scope={scopeNote ? "main-only" : undefined}>
          {turns.length > 0 && (
            <Chip
              size="sm"
              className="turn-bar-more"
              buttonRef={moreRef}
              title={`${allLabel}\n\n${help}`}
              aria-label={allLabel}
              haspopup="listbox"
              expanded={listOpen}
              onClick={() => setListOpen((o) => !o)}
            >
              {translate("turnBar.compact", { count: turns.length })}
            </Chip>
          )}
          {noticeNode}
        </span>
      ) : (
      <div
        className="turn-bar"
        role="toolbar"
        aria-label={translate("turnBar.title")}
        aria-description={help}
        data-session-id={sessionId}
        data-scope={scopeNote ? "main-only" : undefined}
      >
        <span className="turn-bar-title" title={help}>
          <span className="turn-bar-title-text">{translate("turnBar.title")}</span>
          <span className="turn-bar-help" aria-hidden="true">
            i
          </span>
        </span>
        <div className="turn-bar-turns" ref={turnsRef}>
          {hidden > 0 && (
            <Chip
              size="sm"
              className="turn-bar-more"
              buttonRef={moreRef}
              title={allLabel}
              aria-label={allLabel}
              haspopup="listbox"
              expanded={listOpen}
              onClick={() => setListOpen((o) => !o)}
            >
              {translatePlural("turnBar.earlier", hidden)}
            </Chip>
          )}
          {shown.map((turn) => {
            const { files, insertions, deletions } = turn.diffstat;
            const title = titleOf(turn);
            return (
              <Chip
                key={turn.n}
                size="sm"
                className={cx("turn-bar-turn", turn.degraded && "turn-bar-turn-degraded")}
                data-turn-n={turn.n}
                data-files={files}
                data-checks={turn.checks?.state}
                title={title}
                aria-label={title}
                disabled={turn.degraded}
                onClick={() => openDiff(turn)}
              >
                <span className="turn-bar-turn-label">{translate("turnBar.turn", { n: turn.n })}</span>
                <span className="turn-bar-turn-stat">
                  <span className="turn-bar-add">+{insertions}</span>
                  <span className="turn-bar-del">−{deletions}</span>
                </span>
                {turn.checks && (
                  <span className={`turn-bar-checks turn-bar-checks-${turn.checks.state}`} aria-hidden="true">
                    {turn.checks.state === "passed" ? "✓" : "✗"}
                  </span>
                )}
              </Chip>
            );
          })}
        </div>
        {noticeNode}
      </div>
      )}

      {listOpen && hidden > 0 && (
        <Suspense fallback={null}>
          <TurnList turns={turns} anchorRef={moreRef} titleOf={titleOf} scopeNote={scopeNote} onChoose={openDiff} onClose={closeList} />
        </Suspense>
      )}

      {sheet && (
        <div className="turn-sheet-overlay" onClick={close}>
          <div
            className="turn-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={
              sheet.kind === "diff"
                ? translate("turnBar.diffOf", { n: sheet.turn.n })
                : translate("turnBar.restoreTo", { n: sheet.turn.n })
            }
            data-turn-n={sheet.turn.n}
            data-sheet={sheet.kind}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="turn-sheet-header">
              <span className="turn-sheet-title">
                {sheet.kind === "diff"
                  ? translate("turnBar.diffOf", { n: sheet.turn.n })
                  : translate("turnBar.restoreTo", { n: sheet.turn.n })}
              </span>
              {/* A restore sheet counts what the restore changes, not what the turn did. */}
              {(() => {
                const stat = sheet.kind === "restore" ? sheet.preview?.diffstat ?? null : sheet.turn.diffstat;
                return stat ? (
                  <span className="turn-sheet-stat">
                    <span className="turn-bar-add">+{stat.insertions}</span>
                    <span className="turn-bar-del">−{stat.deletions}</span>
                  </span>
                ) : null;
              })()}
              <CloseButton className="turn-sheet-close" onClick={close} label={translate("turnBar.close")} />
            </div>

            {sheet.kind === "diff" && (
              <>
                <div className="turn-sheet-body">
                  {sheet.error && <div className="turn-sheet-error">{translate("turnBar.failed", { error: sheet.error })}</div>}
                  {!sheet.error && sheet.patch === null && <div className="turn-sheet-loading">{translate("turnBar.loading")}</div>}
                  {sheet.patch !== null && <Patch patch={sheet.patch} />}
                </div>
                <div className="turn-sheet-actions">
                  <Button onClick={close}>{translate("turnBar.close")}</Button>
                  <Button variant="primary" className="turn-sheet-restore" onClick={() => openRestore(sheet.turn)}>
                    {translate("turnBar.restoreTo", { n: sheet.turn.n })}
                  </Button>
                </div>
              </>
            )}

            {sheet.kind === "restore" && (
              <>
                <div className="turn-sheet-body">
                  {sheet.error && <div className="turn-sheet-error">{translate("turnBar.failed", { error: sheet.error })}</div>}
                  {!sheet.error && sheet.preview === null && <div className="turn-sheet-loading">{translate("turnBar.loading")}</div>}
                  {sheet.preview && (
                    <>
                      <p className="turn-sheet-hint" data-preview-files={sheet.preview.diffstat.files}>
                        {sheet.preview.diffstat.files === 0
                          ? translate("turnBar.restoreNothing", { n: sheet.turn.n })
                          : translatePlural("turnBar.restoreChanges", sheet.preview.diffstat.files, { n: sheet.turn.n })}
                      </p>
                      {(sheet.preview.setAside?.length ?? 0) > 0 && (
                        <p className="turn-sheet-set-aside" data-set-aside={sheet.preview.setAside?.join(" ")}>
                          {translatePlural("turnBar.setAside", sheet.preview.setAside?.length ?? 0, { files: (sheet.preview.setAside ?? []).join(", ") })}
                        </p>
                      )}
                      <Patch patch={sheet.preview.patch} />
                    </>
                  )}
                </div>
                <div className="turn-sheet-actions">
                  <Button onClick={close} disabled={sheet.busy}>
                    {translate("turnBar.cancel")}
                  </Button>
                  <Button
                    variant="danger-solid"
                    className="turn-sheet-confirm"
                    disabled={sheet.busy || !sheet.preview || sheet.preview.diffstat.files === 0}
                    onClick={() => confirmRestore(sheet.turn)}
                  >
                    {translate("turnBar.confirmRestore")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
