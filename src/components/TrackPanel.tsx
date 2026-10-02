/**
 * Track view (F28): the right-rail panel for a Feature Track.
 *
 * Reads the worktree's `.hermes/features/<slug>/` through the track store
 * and offers the person's actions on it:
 *
 *   ⌘⏎ / Ctrl+⏎  approve the waiting gate       o   preview the phase file here
 *   ⇧O           open it in $EDITOR in a split   r   send my edits back to the agent
 *   ⇧S           skip the phase (asks first)
 *
 * Keys work while the panel has focus (click it or tab to it); the same
 * actions are in the command palette. The panel types into the writer's
 * terminal only because the person pressed something, and only ever to a
 * session that runs an agent (a plain shell would run it): `r` sends one
 * tagged line with their edits, and an approval (or a skip) tells the agent,
 * which stopped at the gate, to run `hi phase` for the next phase.
 *
 * It says in plain words what is happening and what the person does next,
 * shows how far each phase file got, and warns when the writer runs in
 * Skip all (nothing then stops it at a gate but itself).
 */
import "../styles/components/TrackPanel.css";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SessionData } from "../types/session";
import { useTrack, noteOwnApproval, phaseFileOf, hasTurnHistory, type TrackFeatureState } from "../track/store";
import { trackApprove, trackFilePath, trackPromotePlan, trackReadFile, trackSkip, trackWriteReview } from "../track/api";
import { attachedSessions, gateMovedLine, isAgentSession, PHASE_FILE, PHASE_LINE_CAP, skippedPhases, skipsAllApprovals, slugFromBranch, TRACK_PHASES } from "../track/rules";
import { promoteWithUndo } from "../track/promote";
import { subscribeSessionEvents, useSessionEvents } from "../agent/contract/sessionEventStore";
import { FEATURE_TRACKS, type FeatureTrack } from "../agent/contract/featureFrontMatter";
import { agentDisplayName, getAgent } from "../catalog/agentCatalog";
import { useToastStore } from "../hooks/useToastStore";
import { useI18n } from "../i18n/I18nProvider";
import { translatePlural } from "../i18n/plural";
import { fmt } from "../utils/platform";
import { formatBytes } from "../utils/jsonSummary";
import { Button, CloseButton, Select } from "./ui";

interface TrackPanelProps {
  session: SessionData;
  sessions: SessionData[];
  /** ⇧O: open the file in the person's editor in a split next to this pane. */
  onOpenInEditorSplit: (path: string) => void;
  /** `r`: deliver one line to the writer session's terminal. */
  onSendToWriter: (writerSessionId: string, line: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Which of these sessions have a turn history, as one comparable string, so
 * the writer is re-chosen the moment a session turns out to be an agent.
 */
function useTurnHistoryOf(sessionIds: readonly string[]): string {
  const key = sessionIds.join("\u0000");
  const subscribe = useCallback(
    (listener: () => void) => {
      const offs = key === "" ? [] : key.split("\u0000").map((id) => subscribeSessionEvents(id, listener));
      return () => offs.forEach((off) => off());
    },
    [key],
  );
  const snapshot = useCallback(() => (key === "" ? "" : key.split("\u0000").filter(hasTurnHistory).join("\u0000")), [key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The agent's name as people know it ("Claude Code"), never the task text. */
function agentNameOf(s: SessionData | null): string | null {
  if (!s) return null;
  return agentDisplayName(s) ?? getAgent(s.ai_provider)?.name ?? s.ai_provider ?? null;
}

export function TrackPanel({ session, sessions, onOpenInEditorSplit, onSendToWriter, onClose }: TrackPanelProps) {
  const { t } = useI18n();
  const worktree = session.working_directory;
  const state = useTrack(worktree);
  const toast = useToastStore();
  const feature: TrackFeatureState | undefined = state.features.find((f) => f.slug === state.slug) ?? (state.features.length === 1 ? state.features[0] : undefined);
  const inWorktree = useMemo(() => attachedSessions(sessions, worktree), [sessions, worktree]);
  const withHistory = useTurnHistoryOf(useMemo(() => inWorktree.map((s) => s.id), [inWorktree]));
  const hasHistory = useMemo(() => {
    const has = new Set(withHistory === "" ? [] : withHistory.split("\u0000"));
    return (id: string) => has.has(id);
  }, [withHistory]);
  const attached = useMemo(() => attachedSessions(inWorktree, worktree, hasHistory), [inWorktree, worktree, hasHistory]);
  // The writer is the agent driving the feature; a plain shell never is.
  const writer = attached[0] && isAgentSession(attached[0], hasHistory) ? attached[0] : null;
  const writerName = agentNameOf(writer) ?? t("track.theAgent");
  const writerEvents = useSessionEvents(writer?.id ?? "");
  // Only an agent is told that a gate moved (a plain shell would run the line).
  const writerIsAgent = !!writer;
  const role = writer ? (writer.id === session.id ? "writer" : "reader") : "none";
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [promoteTrack, setPromoteTrack] = useState<FeatureTrack>("Light");
  const [promotePlan, setPromotePlan] = useState<readonly string[] | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [busy, setBusy] = useState(false);

  const meta = feature?.meta ?? null;
  const phaseFile = phaseFileOf(meta);
  const phaseFileInfo = phaseFile ? feature?.files.find((f) => f.name === phaseFile) ?? null : null;
  const cap = meta ? PHASE_LINE_CAP[meta.phase] : undefined;
  const waiting = meta?.gate === "waiting";
  const slug = feature?.slug ?? null;
  const phases = meta ? TRACK_PHASES[meta.track] : [];
  const doneIdx = meta ? (meta.phase === "done" ? phases.length : phases.indexOf(meta.phase)) : -1;
  const nextPhase = meta && doneIdx >= 0 && doneIdx < phases.length - 1 ? phases[doneIdx + 1] : "done";
  const skipped = useMemo(() => new Map(skippedPhases(feature?.featureText ?? "").map((s) => [s.phase, s.when])), [feature?.featureText]);

  useEffect(() => {
    setPreview(null);
    setConfirmSkip(false);
  }, [slug, meta?.phase]);

  const say = useCallback((message: string, type: "info" | "success" | "warning" | "error" = "info") => toast.addToast({ message, type, duration: 4000 }), [toast]);

  /** The agent stopped at the gate: tell it the gate moved (the person just pressed approve or skip). */
  const tellWriter = useCallback(
    async (move: { from: string; to: string }, how: "approved" | "skipped"): Promise<boolean> => {
      if (!slug || !writer || !writerIsAgent) return false;
      try {
        await onSendToWriter(writer.id, gateMovedLine(slug, move, how));
        return true;
      } catch (e) {
        console.warn("[TrackPanel] could not tell the writer:", e);
        return false;
      }
    },
    [slug, writer, writerIsAgent, onSendToWriter],
  );

  const approve = useCallback(async () => {
    if (!slug || !waiting || busy) return;
    setBusy(true);
    try {
      noteOwnApproval(worktree, slug);
      const move = await trackApprove(worktree, slug);
      const told = await tellWriter(move, "approved");
      say(told ? t("track.approvedToldToast", { slug, from: move.from, to: move.to, writer: writerName }) : t("track.approvedToast", { slug, from: move.from, to: move.to }), "success");
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [slug, waiting, busy, worktree, say, t, tellWriter, writerName]);

  /** ⇧S / Skip: ask first; a skip is never one stray key away. */
  const askSkip = useCallback(() => {
    if (!slug || !meta || meta.phase === "done" || busy) return;
    setConfirmSkip(true);
  }, [slug, meta, busy]);

  const skip = useCallback(async () => {
    setConfirmSkip(false);
    if (!slug || !meta || meta.phase === "done" || busy) return;
    setBusy(true);
    try {
      const move = await trackSkip(worktree, slug);
      await tellWriter(move, "skipped");
      say(t("track.skippedToast", { slug, from: move.from, to: move.to }), "info");
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [slug, meta, busy, worktree, say, t, tellWriter]);

  const openPreview = useCallback(async () => {
    if (!slug) return;
    const name = phaseFile && phaseFileInfo ? phaseFile : "feature.md";
    if (preview?.name === name) {
      setPreview(null);
      return;
    }
    try {
      setPreview({ name, text: await trackReadFile(worktree, slug, name) });
    } catch (e) {
      say(String(e), "error");
    }
  }, [slug, phaseFile, phaseFileInfo, preview, worktree, say]);

  const openInEditor = useCallback(
    async (fileName?: string) => {
      if (!slug) return;
      const name = fileName ?? (phaseFile && phaseFileInfo ? phaseFile : "feature.md");
      try {
        onOpenInEditorSplit(await trackFilePath(worktree, slug, name));
      } catch (e) {
        say(String(e), "error");
      }
    },
    [slug, phaseFile, phaseFileInfo, worktree, onOpenInEditorSplit, say],
  );

  const sendEdits = useCallback(async () => {
    if (!slug || !feature || busy) return;
    const name = phaseFile && phaseFileInfo ? phaseFile : null;
    if (!name) {
      say(t("track.noFileToSend"), "warning");
      return;
    }
    if (!writer) {
      say(t("track.noAgent"), "warning");
      return;
    }
    setBusy(true);
    try {
      const review = await trackWriteReview(worktree, slug, name, feature.baseline[name] ?? null);
      await onSendToWriter(writer.id, review.line);
      say(t("track.sentEdits", { path: review.path, count: review.changedLines, writer: writerName }), "success");
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [slug, feature, busy, phaseFile, phaseFileInfo, writer, writerName, worktree, onSendToWriter, say, t]);

  const promoteSlug = slugFromBranch(state.branch, worktree);

  /** "Make it a feature": say what it writes first. */
  const askPromote = useCallback(async () => {
    if (busy) return;
    if (promoteTrack === "Quick") {
      say(t("track.quickNoFolder", { slug: promoteSlug }), "info");
      return;
    }
    try {
      setPromotePlan(await trackPromotePlan(worktree, promoteSlug, promoteTrack));
    } catch (e) {
      say(String(e), "error");
    }
  }, [busy, promoteTrack, promoteSlug, worktree, say, t]);

  const promote = useCallback(async () => {
    setPromotePlan(null);
    if (busy) return;
    setBusy(true);
    try {
      await promoteWithUndo(worktree, promoteSlug, promoteTrack, toast, t);
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [busy, worktree, promoteSlug, promoteTrack, toast, say, t]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "SELECT" || target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      // The track picker (a combobox) takes letters for type-ahead.
      if (target.getAttribute("role") === "combobox") return;
      if (e.key === "Escape" && (confirmSkip || promotePlan)) {
        e.preventDefault();
        setConfirmSkip(false);
        setPromotePlan(null);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void approve();
      } else if (e.key === "o" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void openPreview();
      } else if (e.key === "O" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void openInEditor();
      } else if (e.key === "r" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void sendEdits();
      } else if (e.key === "S" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        askSkip();
      }
    },
    [approve, openPreview, openInEditor, sendEdits, askSkip, confirmSkip, promotePlan],
  );

  // The writer's permission mode, as the agent reports it, else as it was launched.
  const writerMode = writerIsAgent && writer ? writerEvents.identity.permissionMode ?? writer.permission_mode : null;
  const explain = !meta
    ? null
    : meta.phase === "done"
      ? t("track.explainDone")
      : waiting
        ? t("track.explainWaiting", { phase: meta.phase, file: phaseFile ?? "feature.md", next: nextPhase, shortcut: fmt("{mod}⏎") })
        : meta.gate === "approved"
          ? t(writerIsAgent ? "track.explainApproved" : "track.explainApprovedNoWriter", { phase: meta.phase })
          : phaseFile
            ? t(phaseFileInfo ? "track.explainWorking" : "track.explainNotStarted", { phase: meta.phase, file: phaseFile, lines: String(phaseFileInfo?.lines ?? 0), cap: String(cap ?? "") })
            : t("track.explainImplementing", { phase: meta.phase });

  const roleText = role === "writer" ? t("track.roleAgent", { agent: writerName }) : role === "reader" ? t("track.roleViewing", { agent: writerName }) : t("track.roleNoAgent");

  return (
    <aside
      className="track-panel"
      data-testid="track-panel"
      data-slug={slug ?? ""}
      data-phase={meta?.phase ?? ""}
      data-gate={meta?.gate ?? ""}
      data-track={meta?.track ?? ""}
      data-role={role}
      data-writer={writer?.id ?? ""}
      data-error={feature?.error ? "true" : "false"}
      aria-label={t("track.ariaLabel")}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <header className="track-head">
        <span className="track-title">{t("track.title")}</span>
        {slug && <span className="track-slug mono">{slug}</span>}
        {meta && <span className="track-kind">{meta.track}</span>}
        <span className={`track-role track-role-${role}`} title={roleText}>
          {roleText}
        </span>
        <CloseButton className="track-close" onClick={onClose} label={t("track.close")} />
      </header>

      {state.branch && <div className="track-branch mono">{state.branch}</div>}

      {!feature && (
        <section className="track-empty" data-testid="track-empty">
          <p>{t("track.noPlanYet")}</p>
          <p className="text-muted">{t("track.emptyHint")}</p>
          <div className="track-promote">
            <span className="track-promote-label">{t("track.planSize")}</span>
            <Select<FeatureTrack>
              size="sm"
              className="track-select"
              value={promoteTrack}
              onChange={(v) => {
                setPromoteTrack(v);
                setPromotePlan(null);
              }}
              aria-label={t("track.planSize")}
              options={FEATURE_TRACKS.map((kind) => ({
                value: kind,
                label: kind,
                detail: kind === "Quick" ? t("track.quickHint") : kind === "Light" ? t("track.lightHint") : t("track.fullHint"),
              }))}
            />
          </div>
          {!promotePlan && (
            <Button size="sm" variant="primary" className="track-make-feature" onClick={() => void askPromote()} disabled={busy}>
              {t("track.makeFeature")}
            </Button>
          )}
          {promotePlan && (
            <div className="track-confirm" role="alertdialog" aria-label={t("track.makeFeature")} data-testid="track-promote-confirm">
              <p>{translatePlural("track.promoteConfirm", promotePlan.length)}</p>
              <ul className="track-confirm-files mono">
                {promotePlan.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <div className="track-confirm-actions">
                <Button size="sm" variant="quiet" className="track-promote-cancel" onClick={() => setPromotePlan(null)}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" variant="primary" className="track-promote-create" onClick={() => void promote()} disabled={busy} autoFocus>
                  {t("track.create")}
                </Button>
              </div>
            </div>
          )}
          <p className="text-muted mono">{`hermes/${promoteSlug}`}</p>
        </section>
      )}

      {feature && feature.tooLarge !== null && (
        <section className="track-error" data-testid="track-too-large" role="alert">
          <p>{t("track.tooLarge", { size: formatBytes(feature.tooLarge) })}</p>
          <Button size="sm" className="track-open-error" onClick={() => void openInEditor("feature.md")}>
            {t("track.openInEditor")}
          </Button>
        </section>
      )}

      {feature?.error && feature.tooLarge === null && (
        <section className="track-error" data-testid="track-error" role="alert">
          <p>{t("track.unreadable", { line: feature.error.line })}</p>
          <p className="text-muted">{feature.error.message}</p>
          <Button size="sm" className="track-open-error" onClick={() => void openInEditor("feature.md")}>
            {t("track.open")}
          </Button>
        </section>
      )}

      {feature && meta && (
        <>
          <ol className="track-phases" aria-label={t("track.phases")}>
            {phases.map((p, i) => {
              const wasSkipped = i < doneIdx && skipped.has(p);
              const cls = wasSkipped ? "skipped" : i < doneIdx ? "done" : i === doneIdx ? (waiting ? "waiting" : "current") : "upcoming";
              const when = skipped.get(p) ?? null;
              const title = wasSkipped ? (when ? t("track.skippedTitle", { when }) : t("track.skippedTitleNoTime")) : undefined;
              return (
                <li key={p} className={`track-phase track-phase-${cls}`} data-phase={p} data-state={cls} title={title} aria-label={wasSkipped ? `${t("track.phaseSkipped", { phase: p })} — ${title}` : undefined}>
                  <span className="track-phase-mark" aria-hidden="true">
                    {cls === "skipped" ? "–" : cls === "done" ? "✓" : cls === "waiting" ? "◆" : cls === "current" ? "›" : "·"}
                  </span>
                  <span className="track-phase-name">{wasSkipped ? t("track.phaseSkipped", { phase: p }) : p}</span>
                  {(() => {
                    // How far each phase's file got (what the agent wrote so far).
                    const name = PHASE_FILE[p];
                    const info = name ? feature.files.find((f) => f.name === name) : undefined;
                    if (!info) return null;
                    const pc = PHASE_LINE_CAP[p];
                    return (
                      <span className="track-phase-lines mono" data-file={name}>
                        {info.lines}
                        {pc ? `/${pc}` : ""}
                      </span>
                    );
                  })()}
                </li>
              );
            })}
            {meta.phase === "done" && (
              <li className="track-phase track-phase-done" data-phase="done" data-state="done">
                <span className="track-phase-mark">✓</span>
                <span className="track-phase-name">{meta.phase}</span>
              </li>
            )}
          </ol>

          {explain && (
            <p className="track-explain" data-testid="track-explain">
              {explain}
            </p>
          )}
          {skipsAllApprovals(writerMode) && meta.phase !== "done" && (
            <p className="track-skip-all" role="note" data-testid="track-skip-all">
              {t("track.skipAllWarning")}
            </p>
          )}

          <div className={`track-gate track-gate-${meta.gate}`} data-testid="track-gate">
            {waiting && (
              <>
                <span className="track-gate-text">{t("track.gateWaiting", { phase: meta.phase })}</span>
                <Button size="sm" variant="primary" className="track-approve" onClick={() => void approve()} disabled={busy}>
                  {t("track.approve")} {fmt("{mod}⏎")}
                </Button>
              </>
            )}
            {meta.gate === "approved" && <span className="track-gate-text">{t("track.gateApproved", { phase: meta.phase })}</span>}
            {meta.gate === "none" && meta.phase !== "done" && <span className="track-gate-text text-muted">{t("track.inProgress", { phase: meta.phase })}</span>}
            {meta.phase === "done" && <span className="track-gate-text">{t("track.done")}</span>}
          </div>

          {feature.questions.length > 0 && (
            <section className="track-questions" aria-label={t("track.questions")}>
              {feature.questions.map((q) => (
                <div key={q.line} className={`track-question ${q.open ? "open" : "answered"} ${q.blocking ? "blocking" : ""}`} data-blocking={q.blocking} data-open={q.open}>
                  <span className="track-question-mark mono">{q.open ? (q.blocking ? "◆" : "○") : "✓"}</span>
                  <span className="track-question-text">{q.text}</span>
                </div>
              ))}
            </section>
          )}

          <div className="track-actions">
            <Button size="sm" variant="quiet" className="track-open" onClick={() => void openPreview()} disabled={!phaseFileInfo && !feature}>
              {preview ? t("track.hide") : t("track.open")} <kbd>o</kbd>
            </Button>
            <Button size="sm" variant="quiet" className="track-open-editor" onClick={() => void openInEditor()}>
              {t("track.editorSplit")} <kbd>⇧O</kbd>
            </Button>
            <Button size="sm" variant="quiet" className="track-send-edits" onClick={() => void sendEdits()} disabled={!phaseFileInfo || busy} title={writer ? undefined : t("track.noAgent")}>
              {t("track.sendEdits")} <kbd>r</kbd>
            </Button>
            <Button size="sm" variant="quiet" className="track-skip" onClick={askSkip} disabled={meta.phase === "done" || busy}>
              {t("track.skip")} <kbd>⇧S</kbd>
            </Button>
          </div>

          {confirmSkip && meta.phase !== "done" && (
            <div className="track-confirm" role="alertdialog" aria-label={t("track.skip")} data-testid="track-skip-confirm">
              <p>{t("track.skipConfirm", { phase: meta.phase, next: nextPhase })}</p>
              <div className="track-confirm-actions">
                <Button size="sm" variant="quiet" className="track-skip-cancel" onClick={() => setConfirmSkip(false)}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" variant="danger-solid" className="track-skip-confirm" onClick={() => void skip()} disabled={busy} autoFocus>
                  {t("track.skipPhase", { phase: meta.phase })}
                </Button>
              </div>
            </div>
          )}

          {preview && (
            <pre className="track-preview mono" data-testid="track-preview" data-file={preview.name}>
              {preview.text}
            </pre>
          )}

          {!preview && feature.body && <div className="track-body text-muted">{feature.body.trim().split("\n").slice(0, 6).join("\n")}</div>}
        </>
      )}

      {feature && <footer className="track-foot text-muted">{t("track.footer", { shortcut: fmt("{mod}⏎") })}</footer>}
    </aside>
  );
}
