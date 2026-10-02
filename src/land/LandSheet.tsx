import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useSession } from "../state/SessionContext";
import { useI18n } from "../i18n/I18nProvider";
import { useSessionEvents } from "../agent/contract/sessionEventStore";
import { lastReportedStatus } from "../agent/status/deriveStatus";
import { writeToSession } from "../api/sessions";
import { utf8ToBase64 } from "../utils/encoding";
import { getWorktreeUsage } from "../api/git";
import type { WorktreeUsage } from "../types/git";
import {
  landArchive,
  landCiLog,
  landExecute,
  landGhStatus,
  landPrChecks,
  landPreview,
  landUndo,
  type ArchivePlan,
  type GhStatus,
  type LandOutcome,
  type LandPreview,
  type LandRecord,
  type PrCheck,
  type UndoOutcome,
} from "./api";
import { loadLandTurns, type LandTurn } from "./turnSource";
import { Button, CloseButton } from "../components/ui/Button";
import { Checkbox, Radio } from "../components/ui/Choice";
import { Textarea } from "../components/ui/Input";
import { NativeSelect } from "../components/ui/Select";
import { agentDisplayName, getAgent } from "../catalog/agentCatalog";
import { parseHookRefusal } from "../utils/gitErrors";
import {
  baseBranchNote,
  baseMismatchNote,
  ciLogRequest,
  defaultLandMode,
  doneWhenCommands,
  doneWhenLabel,
  doneWhenState,
  draftMessage,
  draftPrBody,
  formatBytes,
  landAvailability,
  launchedTask,
  mergeNote,
  pickFeature,
  rebaseRequest,
} from "./draft";
import "../styles/components/LandSheet.css";

type Mode = "commit" | "pr" | "merge";

const GH_INSTALL_URL = "https://cli.github.com";
const GH_SIGN_IN_URL = "https://cli.github.com/manual/gh_auth_login";
const CHECKS_POLL_MS = 15_000;
// A shell command, not language: the same in every translation.
const GH_SIGN_IN_COMMAND = "gh auth login";

interface LandSheetProps {
  sessionId: string;
  projectId: string;
  /** `landed`: a land or an archive went through and was not undone. */
  onClose: (landed?: boolean) => void;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A translated sentence with elements (a <code> branch, a link) spliced in at their {placeholders}. */
function withNodes(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((part, i) => (i % 2 === 1 ? <Fragment key={i}>{nodes[part]}</Fragment> : part));
}

/**
 * Land sheet (F22): ship a task's worktree in one step — commit on its
 * branch, open a pull request, or squash-merge locally — and archive it,
 * with Undo for each. Rendered by LandSheetHost at the app root, so it
 * stays open after an archive closes the session.
 */
export function LandSheet({ sessionId, projectId, onClose }: LandSheetProps) {
  const { t } = useI18n();
  const { state, closeSession, createSession } = useSession();
  const events = useSessionEvents(sessionId);
  const session = state.sessions[sessionId];
  const label = useRef(session?.label ?? "");
  if (session?.label) label.current = session.label;
  const sessionAlive = !!session;

  const [preview, setPreview] = useState<LandPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [turns, setTurns] = useState<LandTurn[]>([]);
  const [usage, setUsage] = useState<WorktreeUsage | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [message, setMessage] = useState("");
  const [archiveAfter, setArchiveAfter] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<LandOutcome | null>(null);
  const [archived, setArchived] = useState<ArchivePlan | null>(null);
  const [undone, setUndone] = useState<UndoOutcome | null>(null);
  // Closing tells whoever opened the sheet whether a land or an archive went
  // through (and was not undone): the Review Desk under it closes only then.
  const doneRef = useRef(false);
  doneRef.current = (outcome?.status === "landed" || !!archived) && !undone;
  const close = useCallback(() => onClose(doneRef.current), [onClose]);
  const [checks, setChecks] = useState<PrCheck[] | null>(null);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** The branch picked in "Land into"; null: the one the task was started from. */
  const [baseChoice, setBaseChoice] = useState<string | null>(null);
  /** The task as typed in the launcher, for the drafted message. */
  const [task, setTask] = useState<{ task: string; doneWhen: string[] } | null>(null);
  /** "Archive: stop … ?" is showing. */
  const [confirmArchive, setConfirmArchive] = useState(false);

  // ── Load everything the sheet shows ────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    landGhStatus(sessionId, projectId)
      .then((g) => !cancelled && setGh(g))
      .catch((e) => !cancelled && setGh({ state: "missing", detail: errorText(e) }));
    loadLandTurns(sessionId).then((t) => !cancelled && setTurns(t));
    launchedTask(sessionId).then((t) => !cancelled && setTask(t));
    return () => {
      cancelled = true;
    };
  }, [sessionId, projectId]);

  // The preview, again for every base picked in "Land into".
  useEffect(() => {
    let cancelled = false;
    landPreview(sessionId, projectId, baseChoice)
      .then((p) => {
        if (cancelled) return;
        setLoadError(null);
        setPreview(p);
        getWorktreeUsage(p.worktreePath).then((u) => !cancelled && setUsage(u)).catch(() => {});
      })
      .catch((e) => !cancelled && setLoadError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [sessionId, projectId, baseChoice]);

  const feature = useMemo(() => (preview ? pickFeature(preview.features, preview.branch) : null), [preview]);
  const commands = useMemo(
    () => (preview ? doneWhenCommands(feature, preview.worktreeToml) : []),
    [preview, feature],
  );
  // What the checks (or the agent) last reported: the terminal's own
  // guesses (with the launchHelper flag) must not hide a failing check.
  const doneWhen = doneWhenState(commands, lastReportedStatus(events) ?? events.status);
  const turnCount = Math.max(turns.length, events.turn.completed);
  const draftInput = useMemo(
    () =>
      preview
        ? {
            branch: preview.branch,
            label: label.current,
            turns,
            feature,
            diffstat: preview.diffstat,
            task: task?.task ?? null,
            doneWhen: commands.length > 0 ? commands : task?.doneWhen ?? [],
          }
        : null,
    [preview, turns, feature, task, commands],
  );
  const prBody = useMemo(() => (draftInput ? draftPrBody(draftInput, commands) : ""), [draftInput, commands]);
  const available = preview ? landAvailability(preview, gh) : null;

  // Draft the message once the turns and the preview are in (until edited).
  const edited = useRef(false);
  useEffect(() => {
    if (draftInput && !edited.current) setMessage(draftMessage(draftInput));
  }, [draftInput]);

  // Pick the first option that can be used, once we know — never over the
  // person's own pick. The GitHub CLI status arrives late (it runs `gh`), so
  // this effect can run for a render from before a click that is already
  // queued: the functional update keeps whatever was picked meanwhile.
  const picked = useRef(false);
  const pick = useCallback((m: Mode) => {
    picked.current = true;
    setMode(m);
  }, []);
  useEffect(() => {
    if (!available || mode || picked.current) return;
    const first = defaultLandMode(available, gh);
    if (first) setMode((current) => current ?? first);
  }, [available, mode, gh]);

  const busyRef = useRef(false);
  busyRef.current = busy !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // ── Actions ─────────────────────────────────────────────────────────
  const archiveNow = useCallback(
    async (landId: string | null) => {
      const plan = await landArchive(sessionId, projectId, landId, label.current);
      // Closing the session removes its worktree folder (build output
      // included) and keeps the branch and every reference.
      await closeSession(sessionId);
      setArchived(plan);
      return plan;
    },
    [sessionId, projectId, closeSession],
  );

  const land = useCallback(
    async (chosen: Mode) => {
      setBusy("land");
      setNote(null);
      setActionError(null);
      try {
        const out = await landExecute(sessionId, projectId, {
          mode: chosen,
          message,
          prBody: chosen === "pr" ? prBody : undefined,
          label: label.current,
          base: preview?.base?.name ?? baseChoice ?? undefined,
        });
        setOutcome(out);
        if (out.status === "landed" && archiveAfter && out.record) {
          try {
            await archiveNow(out.record.id);
          } catch (e) {
            setActionError(t("land.landedNotArchived", { error: errorText(e) }));
          }
        }
      } catch (e) {
        setActionError(errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [sessionId, projectId, message, prBody, archiveAfter, archiveNow, preview, baseChoice, t],
  );

  // An agent at work in the session is stopped by archiving: ask first.
  const agentName = session ? agentDisplayName(session) ?? getAgent(session.ai_provider)?.name ?? null : null;
  const agentRunning = !!session && session.phase !== "destroyed" && (!!session.detected_agent || !!session.ai_provider);

  const archiveOnly = useCallback(async () => {
    setConfirmArchive(false);
    setBusy("archive");
    setActionError(null);
    try {
      await archiveNow(null);
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [archiveNow]);

  const undo = useCallback(
    async (rec: LandRecord) => {
      setBusy("undo");
      setActionError(null);
      try {
        const restoreId = crypto.randomUUID();
        const out = await landUndo(rec.id, restoreId);
        if (out.restored) {
          await createSession({
            sessionId: out.restored.sessionId,
            projectIds: [out.restored.projectId],
            label: out.restored.label || out.restored.branch,
          });
        }
        setUndone(out);
      } catch (e) {
        setActionError(t("land.undoStopped", { error: errorText(e) }));
      } finally {
        setBusy(null);
      }
    },
    [createSession, t],
  );

  const landedRecord = outcome?.record ?? archived?.record ?? null;
  const prUrl = outcome?.status === "landed" ? outcome.record?.prUrl ?? null : null;

  const refreshChecks = useCallback(async () => {
    if (!landedRecord?.prUrl) return;
    try {
      setChecks(await landPrChecks(landedRecord.id));
      setChecksError(null);
    } catch (e) {
      setChecksError(errorText(e));
    }
  }, [landedRecord]);

  useEffect(() => {
    if (!prUrl || undone) return;
    void refreshChecks();
    const timer = setInterval(() => void refreshChecks(), CHECKS_POLL_MS);
    return () => clearInterval(timer);
  }, [prUrl, undone, refreshChecks]);

  const sendLog = useCallback(
    async (check: PrCheck) => {
      if (!landedRecord) return;
      setBusy(`log:${check.name}`);
      setActionError(null);
      try {
        const file = await landCiLog(landedRecord.id, check.name, check.link);
        // One line, pasted and never sent: the person presses Enter.
        await writeToSession(sessionId, utf8ToBase64(ciLogRequest(check.name, file.relativePath)));
        setNote(t("land.noteLogSent", { path: file.relativePath }));
      } catch (e) {
        setActionError(errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [landedRecord, sessionId, t],
  );

  const askRebase = useCallback(
    async (files: readonly string[]) => {
      if (!preview?.base) return;
      try {
        await writeToSession(sessionId, utf8ToBase64(rebaseRequest(preview.base.name, files)));
        setNote(t("land.noteRebasePasted"));
      } catch (e) {
        setActionError(errorText(e));
      }
    },
    [preview, sessionId, t],
  );

  const routeToPr = useCallback(() => {
    setOutcome(null);
    pick("pr");
  }, [pick]);

  // ── Render ──────────────────────────────────────────────────────────
  const openLandings = preview?.landings.filter((l) => !l.undone) ?? [];
  const lastOpenLanding = openLandings.length > 0 ? openLandings[openLandings.length - 1] : null;
  const conflictFiles =
    outcome?.status === "conflict"
      ? outcome.conflictFiles
      : preview?.merge.kind === "conflict"
        ? preview.merge.files
        : null;
  const failing = doneWhen.kind === "failing";
  const baseNote = baseBranchNote(preview?.base?.name ?? null, preview?.recordedBase ?? null);
  const mismatchNote = baseMismatchNote(preview?.baseMismatch, preview?.base?.name ?? null);
  const showResult = !!(outcome && outcome.status !== "conflict") || !!archived || !!undone;
  const baseOptions = preview
    ? Array.from(new Set([...(preview.base ? [preview.base.name] : []), ...(preview.branches ?? [])]))
    : [];

  return (
    <div className="land-sheet-overlay">
      <div className="land-sheet" role="dialog" aria-modal="true" aria-labelledby="land-sheet-title">
        <div className="land-sheet-header">
          <span className="land-sheet-title" id="land-sheet-title">
            {!preview
              ? t("land.titleTask")
              : withNodes(t(preview.base ? "land.titleInto" : "land.title"), {
                  branch: <code className="land-sheet-branch">{preview.branch}</code>,
                  base: preview.base && <code className="land-sheet-branch">{preview.base.name}</code>,
                })}
          </span>
          <CloseButton className="land-sheet-x" onClick={close} disabled={busy !== null} label={t("common.close")} />
        </div>

        <div className="land-sheet-body">
          {loadError && <div className="land-sheet-error">{loadError}</div>}
          {!preview && !loadError && <div className="land-sheet-loading">{t("land.readingWorktree")}</div>}
          {preview && !showResult && baseOptions.length > 0 && (
            <label className="land-sheet-into">
              <span className="land-sheet-into-label">{t("land.landInto")}</span>
              <NativeSelect
                id="land-sheet-base"
                size="sm"
                className="land-sheet-base-select"
                value={preview.base?.name ?? ""}
                disabled={busy !== null}
                onChange={(e) => setBaseChoice(e.target.value || null)}
              >
                {baseOptions.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          {baseNote && <div className="land-sheet-note land-sheet-base-note">{baseNote}</div>}
          {mismatchNote && <div className="land-sheet-warning land-sheet-base-mismatch">{mismatchNote}</div>}

          {preview && (
            <div className="land-sheet-summary">
              <div className={`land-sheet-stat land-sheet-donewhen land-sheet-donewhen-${doneWhen.kind}`} data-state={doneWhen.kind}>
                <span className="land-sheet-stat-label">{t("land.statDoneWhen")}</span>
                <span className="land-sheet-stat-value">{doneWhenLabel(doneWhen)}</span>
              </div>
              <div className="land-sheet-stat land-sheet-turns" data-turns={turnCount}>
                <span className="land-sheet-stat-label">{t("land.statTurns")}</span>
                <span className="land-sheet-stat-value">{turnCount}</span>
              </div>
              <div
                className="land-sheet-stat land-sheet-diffstat"
                data-files={preview.diffstat.files}
                data-insertions={preview.diffstat.insertions}
                data-deletions={preview.diffstat.deletions}
              >
                <span className="land-sheet-stat-label">{t("land.statChanges")}</span>
                <span className="land-sheet-stat-value">
                  {t(preview.diffstat.files === 1 ? "land.fileCountOne" : "land.fileCount", { count: preview.diffstat.files })}{" "}
                  <span className="land-sheet-ins">+{preview.diffstat.insertions}</span>{" "}
                  <span className="land-sheet-del">-{preview.diffstat.deletions}</span>
                </span>
              </div>
              <div className="land-sheet-stat land-sheet-disk" data-total-bytes={usage?.total_bytes ?? ""}>
                <span className="land-sheet-stat-label">{t("land.statDisk")}</span>
                <span className="land-sheet-stat-value">
                  {usage
                    ? `${formatBytes(usage.total_bytes)}${usage.build_output_bytes > 0 ? ` ${t("land.buildOutput", { size: formatBytes(usage.build_output_bytes) })}` : ""}`
                    : "…"}
                </span>
              </div>
            </div>
          )}

          {preview && doneWhen.kind !== "none" && (
            <ul className="land-sheet-commands">
              {doneWhen.commands.map((c) => (
                <li key={c}>
                  <code>{c}</code>
                </li>
              ))}
            </ul>
          )}

          {preview && !showResult && lastOpenLanding && (
            <div className="land-sheet-previous">
              {t("land.landedBefore", { mode: lastOpenLanding.mode === "archive" ? t("land.modeArchived") : lastOpenLanding.mode })}
              <Button variant="link" size="sm" className="land-sheet-undo-previous" disabled={busy !== null} onClick={() => undo(lastOpenLanding)}>
                {t("land.undoThat")}
              </Button>
            </div>
          )}

          {preview && !showResult && (
            <>
              {preview.changedFiles.length > 0 && (
                <details className="land-sheet-files">
                  <summary>
                    {t(preview.changedFiles.length === 1 ? "land.changedFileOne" : "land.changedFiles", { count: preview.changedFiles.length })}
                    {preview.uncommittedFiles > 0 ? `, ${t("land.notCommittedYet", { count: preview.uncommittedFiles })}` : ""}
                  </summary>
                  <ul>
                    {preview.changedFiles.slice(0, 200).map((f) => (
                      <li key={f}>
                        <code>{f}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <fieldset className="land-sheet-options">
                <legend>{t("land.howToLand")}</legend>
                <LandOption
                  mode="commit"
                  current={mode}
                  onPick={pick}
                  title={t("land.optCommit", { branch: preview.branch })}
                  reason={available?.commit ?? null}
                />
                <LandOption
                  mode="pr"
                  current={mode}
                  onPick={pick}
                  title={preview.remote ? t("land.optPr", { remote: preview.remote }) : t("land.optPrNoRemote")}
                  reason={available?.pr ?? null}
                >
                  {/* Only when a pull request could be opened once gh is ready (never with no remote, never for another host). */}
                  {preview.remote && gh?.state === "missing" && (
                    <Button variant="link" size="sm" className="land-sheet-gh-link" onClick={() => void shellOpen(GH_INSTALL_URL)}>
                      {t("land.installGh")}
                    </Button>
                  )}
                  {preview.remote && gh?.state === "signed_out" && (
                    <Button variant="link" size="sm" className="land-sheet-gh-link" onClick={() => void shellOpen(GH_SIGN_IN_URL)}>
                      {t("land.signInGh", { command: GH_SIGN_IN_COMMAND })}
                    </Button>
                  )}
                </LandOption>
                <LandOption
                  mode="merge"
                  current={mode}
                  onPick={pick}
                  title={t("land.optMerge", { base: preview.base?.name ?? t("land.theBaseBranch") })}
                  reason={available?.merge ?? null}
                  hint={available?.merge ? null : mergeNote(preview.merge, preview.base?.name ?? null)}
                />
              </fieldset>

              {conflictFiles && (
                <div className="land-sheet-conflict">
                  <div>
                    {t("land.conflict", { files: conflictFiles.join(", ") })}
                  </div>
                  <div className="land-sheet-conflict-actions">
                    <Button size="sm" className="land-sheet-route-pr" onClick={routeToPr} disabled={!!available?.pr}>
                      {t("land.routeToPr")}
                    </Button>
                    <Button size="sm" className="land-sheet-ask-rebase" onClick={() => void askRebase(conflictFiles)} disabled={!sessionAlive}>
                      {t("land.askRebase")}
                    </Button>
                  </div>
                </div>
              )}

              <label className="land-sheet-field">
                <span>{t("land.commitMessage")}</span>
                <Textarea
                  code
                  className="land-sheet-message"
                  value={message}
                  rows={6}
                  onChange={(e) => {
                    edited.current = true;
                    setMessage(e.target.value);
                  }}
                />
              </label>

              {mode === "pr" && (
                <details className="land-sheet-prbody" open>
                  <summary>{t("land.prDescription")}</summary>
                  <pre className="land-sheet-prbody-text">{prBody}</pre>
                </details>
              )}

              <Checkbox
                className="land-sheet-check land-sheet-archive-after"
                title={available?.archive ?? undefined}
                checked={archiveAfter && !preview.shared}
                disabled={preview.shared}
                onChange={setArchiveAfter}
                label={t("land.archiveAfter")}
              />
              {failing && (
                <div className="land-sheet-warning">
                  {t("land.failingWarning")}
                </div>
              )}
            </>
          )}

          {outcome?.status === "landed" && outcome.record && (
            <div className="land-sheet-result" data-status="landed">
              <strong>{t("land.landed")}</strong> {landedText(outcome.record, t)}
            </div>
          )}
          {outcome?.status === "failed" && (
            <div className="land-sheet-result land-sheet-error" data-status="failed">
              {t("land.landingStopped", { error: readableLandError(outcome.error ?? "", t) })}
            </div>
          )}
          {archived && (
            <div className="land-sheet-result land-sheet-archived" data-freed-bytes={archived.totalBytes}>
              {withNodes(
                archived.buildOutputBytes > 0
                  ? t("land.archivedResultBuild", { size: formatBytes(archived.totalBytes), build: formatBytes(archived.buildOutputBytes) })
                  : t("land.archivedResult", { size: formatBytes(archived.totalBytes) }),
                { branch: <code>{archived.record.branch}</code> },
              )}
            </div>
          )}

          {prUrl && !undone && (
            <div className="land-sheet-checks">
              <div className="land-sheet-checks-head">
                <span>
                  {withNodes(t("land.checksOn"), {
                    url: (
                      <Button variant="link" size="sm" className="land-sheet-pr-link" onClick={() => void shellOpen(prUrl)}>
                        {prUrl}
                      </Button>
                    ),
                  })}
                </span>
                <Button variant="link" size="sm" className="land-sheet-refresh-checks" onClick={() => void refreshChecks()}>
                  {t("land.refresh")}
                </Button>
              </div>
              {checksError && <div className="land-sheet-error">{checksError}</div>}
              {checks === null && !checksError && <div className="land-sheet-loading">{t("land.readingChecks")}</div>}
              {checks?.length === 0 && <div className="land-sheet-muted">{t("land.noChecks")}</div>}
              <ul className="land-sheet-check-list">
                {checks?.map((c) => (
                  <li key={`${c.workflow}/${c.name}`} className={`land-sheet-ci land-sheet-ci-${c.bucket}`} data-bucket={c.bucket}>
                    <span className="land-sheet-ci-name">{c.name}</span>
                    <span className="land-sheet-ci-state">{c.bucket || c.state}</span>
                    {c.bucket === "fail" && (
                      <Button
                        size="sm"
                        className="land-sheet-send-log"
                        disabled={busy !== null || !sessionAlive}
                        title={sessionAlive ? undefined : t("land.sessionArchived")}
                        onClick={() => void sendLog(c)}
                      >
                        {t("land.sendLog")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {undone && (
            <div className="land-sheet-result land-sheet-undone">
              <strong>{t("land.undone")}</strong>
              <ul className="land-sheet-undo-steps">
                {undone.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
              {undone.restored && <div>{t("land.restored")}</div>}
            </div>
          )}

          {note && <div className="land-sheet-note">{note}</div>}
          {actionError && <div className="land-sheet-error land-sheet-action-error">{actionError}</div>}
        </div>

        <div className="land-sheet-footer">
          {!showResult && preview && confirmArchive && (
            <div className="land-sheet-archive-confirm" role="alertdialog" aria-labelledby="land-sheet-archive-confirm-text">
              <span id="land-sheet-archive-confirm-text" className="land-sheet-archive-confirm-text">
                {t("land.archiveConfirm", { agent: agentName || t("land.theAgent") })}
              </span>
              <span className="land-sheet-spacer" />
              <Button className="land-sheet-archive-cancel" onClick={() => setConfirmArchive(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger-solid" className="land-sheet-archive-yes" onClick={() => void archiveOnly()}>
                {t("land.archive")}
              </Button>
            </div>
          )}
          {!showResult && preview && !confirmArchive && (
            <>
              <Button
                className="land-sheet-archive"
                disabled={busy !== null || !!available?.archive}
                title={available?.archive ?? undefined}
                // Archiving stops the session's program: ask while an agent runs there.
                onClick={() => (agentRunning ? setConfirmArchive(true) : void archiveOnly())}
              >
                {t("land.archiveEllipsis")}
              </Button>
              <span className="land-sheet-spacer" />
              {/* A failing Done-When check makes Cancel the primary and Land a secondary "Land anyway". */}
              <Button variant={failing ? "primary" : "secondary"} className="land-sheet-cancel" onClick={() => onClose(false)} disabled={busy !== null}>
                {t("common.cancel")}
              </Button>
              <Button
                variant={failing ? "secondary" : "primary"}
                className="land-sheet-land"
                data-anyway={failing ? "true" : "false"}
                disabled={busy !== null || !mode || !!(mode && available?.[mode]) || !message.trim()}
                onClick={() => mode && void land(mode)}
              >
                {busy === "land" ? t("land.landing") : failing ? t("land.landAnyway") : t("land.land")}
              </Button>
            </>
          )}
          {showResult && (
            <>
              {landedRecord && !undone && (
                <Button className="land-sheet-undo" disabled={busy !== null} onClick={() => void undo(landedRecord)}>
                  {busy === "undo" ? t("land.undoing") : t("land.undo")}
                </Button>
              )}
              <span className="land-sheet-spacer" />
              <Button variant="primary" className="land-sheet-close" disabled={busy !== null} onClick={close}>
                {t("common.close")}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A refusing commit hook shown as "pre-commit refused: <what it printed>". */
function readableLandError(error: string, t: (key: string, values?: Record<string, string | number>) => string): string {
  const hook = parseHookRefusal(error);
  return hook ? t("dirty.hookRefused", { hook: hook.hook, output: hook.output }) : error;
}

function landedText(rec: LandRecord, t: (key: string, values?: Record<string, string | number>) => string): string {
  const commit = rec.branchAfter && rec.branchAfter !== rec.branchBefore ? ` (${rec.branchAfter.slice(0, 8)})` : "";
  switch (rec.mode) {
    case "commit":
      return t("land.resultCommitted", { branch: rec.branch, commit });
    case "pr":
      return t("land.resultPr", { branch: rec.branch, url: rec.prUrl ?? "" });
    case "merge":
      return t("land.resultMerged", { base: rec.base ?? t("land.theBase"), commit: (rec.mergedCommit ?? "").slice(0, 8) });
    case "archive":
      return t("land.resultArchived");
  }
}

interface LandOptionProps {
  mode: Mode;
  current: Mode | null;
  onPick: (m: Mode) => void;
  title: string;
  reason: string | null;
  hint?: string | null;
  children?: React.ReactNode;
}

function LandOption({ mode, current, onPick, title, reason, hint, children }: LandOptionProps) {
  const disabled = reason !== null;
  return (
    <div className={`land-sheet-option${disabled ? " land-sheet-option-disabled" : ""}`} data-mode={mode} aria-disabled={disabled}>
      <Radio
        name="land-mode"
        value={mode}
        checked={current === mode}
        disabled={disabled}
        onChange={() => onPick(mode)}
        label={<span className="land-sheet-option-title">{title}</span>}
      />
      {reason && <div className="land-sheet-option-reason">{reason}</div>}
      {!reason && hint && <div className="land-sheet-option-hint">{hint}</div>}
      {children}
    </div>
  );
}
