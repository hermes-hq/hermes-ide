import "../styles/components/TurnBar.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { translate } from "../i18n/registry";
import { Button, CloseButton } from "./ui/Button";
import { getTurnDiff, listTurns, type Turn, type TurnChecks } from "../agent/contract/turns";
import { getSessionEventSnapshot } from "../agent/contract/sessionEventStore";
import { withTurnChecks } from "../agent/turns/turnChecks";
import { useDoneWhen } from "../doneWhen/store";
import {
  previewRestoreTurn,
  restoreTurn,
  TURN_LEDGER_EVENT,
  type RestorePreview,
  type TurnLedgerEvent,
} from "../agent/turns/turnLedgerApi";

/**
 * F20 — the turn bar under a terminal session (feature flag `turnLedger`).
 *
 * One chip per recorded turn (T1, T2, ...) with its diffstat. A chip opens
 * the turn's diff; from there "Restore to Tn" previews what restoring would
 * change and only restores after a confirmation. Turns arrive from the
 * backend ledger (`hermes:turn-ledger`); the bar renders nothing while a
 * session has no turn. A turn whose Done-When checks ran (F27) carries
 * their result (`Turn.checks`): a mark on the chip and a line in its title.
 */

interface TurnBarProps {
  sessionId: string;
}

type Sheet =
  | { kind: "diff"; turn: Turn; patch: string | null; error: string | null }
  | { kind: "restore"; turn: Turn; preview: RestorePreview | null; error: string | null; busy: boolean };

const NOTICE_MS = 4000;

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

export function TurnBar({ sessionId }: TurnBarProps) {
  const [ledgerTurns, setTurns] = useState<Turn[]>([]);
  const doneWhen = useDoneWhen(sessionId);
  // Turn.checks (F20 x F27): the Done-When result of each recorded turn.
  const turns = useMemo(
    () => withTurnChecks(ledgerTurns, getSessionEventSnapshot(sessionId).events, (n) => doneWhen.byTurn[n] ?? null),
    [ledgerTurns, doneWhen, sessionId],
  );
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
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
      if (typeof event.payload.restoredTo === "number") {
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
      restoreTurn(sessionId, turn.n)
        .then(() => {
          setSheet(null);
          showNotice(translate("turnBar.restored", { n: turn.n }));
          reload();
        })
        .catch((e) => {
          setSheet((cur) => (cur?.kind === "restore" ? { ...cur, busy: false, error: String(e) } : cur));
        });
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

  if (turns.length === 0 && !notice) return null;

  return (
    <>
      <div className="turn-bar" role="toolbar" aria-label={translate("turnBar.title")} data-session-id={sessionId}>
        <span className="turn-bar-title">{translate("turnBar.title")}</span>
        <div className="turn-bar-turns">
          {turns.map((turn) => {
            const { files, insertions, deletions } = turn.diffstat;
            const base = turn.degraded
              ? translate("turnBar.summaryOnly", { n: turn.n })
              : translate("turnBar.turnTitle", { n: turn.n, files, insertions, deletions });
            const title = turn.checks ? `${base} · ${checksText(turn.checks)}` : base;
            return (
              <button
                key={turn.n}
                type="button"
                className={`turn-bar-turn${turn.degraded ? " turn-bar-turn-degraded" : ""}`}
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
              </button>
            );
          })}
        </div>
        {notice && (
          <span className="turn-bar-notice" role="status">
            {notice}
          </span>
        )}
      </div>

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
              <span className="turn-sheet-stat">
                <span className="turn-bar-add">+{sheet.turn.diffstat.insertions}</span>
                <span className="turn-bar-del">−{sheet.turn.diffstat.deletions}</span>
              </span>
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
                          : translate("turnBar.restorePreview", { n: sheet.turn.n, files: sheet.preview.diffstat.files })}
                      </p>
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
