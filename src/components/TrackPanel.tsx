/**
 * Track view (F28): the right-rail panel for a Feature Track.
 *
 * Reads the worktree's `.hermes/features/<slug>/` through the track store
 * and offers the person's actions on it:
 *
 *   ⌘⏎ / Ctrl+⏎  approve the waiting gate       o   preview the phase file here
 *   ⇧O           open it in $EDITOR in a split   r   send my edits back to the writer
 *   s            skip the phase
 *
 * Keys work while the panel has focus (click it or tab to it); the same
 * actions are in the command palette. The panel never types into a terminal
 * on its own: `r` sends one tagged line because the person pressed it.
 */
import "../styles/components/TrackPanel.css";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SessionData } from "../types/session";
import { useTrack, noteOwnApproval, phaseFileOf, hasTurnHistory, type TrackFeatureState } from "../track/store";
import { trackApprove, trackFilePath, trackPromote, trackReadFile, trackSkip, trackWriteReview } from "../track/api";
import { attachedSessions, PHASE_LINE_CAP, TRACK_PHASES } from "../track/rules";
import { subscribeSessionEvents } from "../agent/contract/sessionEventStore";
import { FEATURE_TRACKS, type FeatureTrack } from "../agent/contract/featureFrontMatter";
import { useToastStore } from "../hooks/useToastStore";
import { useI18n } from "../i18n/I18nProvider";
import { fmt } from "../utils/platform";

interface TrackPanelProps {
  session: SessionData;
  sessions: SessionData[];
  /** ⇧O: open the file in the person's editor in a split next to this pane. */
  onOpenInEditorSplit: (path: string) => void;
  /** `r`: deliver one line to the writer session's terminal. */
  onSendToWriter: (writerSessionId: string, line: string) => Promise<void>;
  onClose: () => void;
}

/** A slug for "Make it a feature": the branch's, else the folder's name. */
export function slugFromBranch(branch: string | null, workingDirectory: string): string {
  const raw = branch?.startsWith("hermes/") ? branch.slice("hermes/".length) : (branch ?? workingDirectory.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "feature");
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "feature";
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

export function TrackPanel({ session, sessions, onOpenInEditorSplit, onSendToWriter, onClose }: TrackPanelProps) {
  const { t } = useI18n();
  const worktree = session.working_directory;
  const state = useTrack(worktree);
  const toast = useToastStore();
  const feature: TrackFeatureState | undefined = state.features.find((f) => f.slug === state.slug) ?? (state.features.length === 1 ? state.features[0] : undefined);
  const inWorktree = useMemo(() => attachedSessions(sessions, worktree), [sessions, worktree]);
  const withHistory = useTurnHistoryOf(useMemo(() => inWorktree.map((s) => s.id), [inWorktree]));
  const attached = useMemo(() => {
    const has = new Set(withHistory === "" ? [] : withHistory.split("\u0000"));
    return attachedSessions(inWorktree, worktree, (id) => has.has(id));
  }, [inWorktree, worktree, withHistory]);
  const writer = attached[0] ?? null;
  const role = writer ? (writer.id === session.id ? "writer" : "reader") : "none";
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null);
  const [promoteTrack, setPromoteTrack] = useState<FeatureTrack>("Light");
  const [busy, setBusy] = useState(false);

  const meta = feature?.meta ?? null;
  const phaseFile = phaseFileOf(meta);
  const phaseFileInfo = phaseFile ? feature?.files.find((f) => f.name === phaseFile) ?? null : null;
  const cap = meta ? PHASE_LINE_CAP[meta.phase] : undefined;
  const waiting = meta?.gate === "waiting";
  const slug = feature?.slug ?? null;

  useEffect(() => {
    setPreview(null);
  }, [slug, meta?.phase]);

  const say = useCallback((message: string, type: "info" | "success" | "warning" | "error" = "info") => toast.addToast({ message, type, duration: 4000 }), [toast]);

  const approve = useCallback(async () => {
    if (!slug || !waiting || busy) return;
    setBusy(true);
    try {
      noteOwnApproval(worktree, slug);
      const move = await trackApprove(worktree, slug);
      say(t("track.approvedToast", { slug, from: move.from, to: move.to }), "success");
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [slug, waiting, busy, worktree, say, t]);

  const skip = useCallback(async () => {
    if (!slug || !meta || meta.phase === "done" || busy) return;
    setBusy(true);
    try {
      const move = await trackSkip(worktree, slug);
      say(t("track.skippedToast", { slug, from: move.from, to: move.to }), "info");
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [slug, meta, busy, worktree, say, t]);

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

  const openInEditor = useCallback(async () => {
    if (!slug) return;
    const name = phaseFile && phaseFileInfo ? phaseFile : "feature.md";
    try {
      onOpenInEditorSplit(await trackFilePath(worktree, slug, name));
    } catch (e) {
      say(String(e), "error");
    }
  }, [slug, phaseFile, phaseFileInfo, worktree, onOpenInEditorSplit, say]);

  const sendEdits = useCallback(async () => {
    if (!slug || !feature || busy) return;
    const name = phaseFile && phaseFileInfo ? phaseFile : null;
    if (!name) {
      say(t("track.noFileToSend"), "warning");
      return;
    }
    if (!writer) {
      say(t("track.noWriter"), "warning");
      return;
    }
    setBusy(true);
    try {
      const review = await trackWriteReview(worktree, slug, name, feature.baseline[name] ?? null);
      await onSendToWriter(writer.id, review.line);
      say(t("track.sentEdits", { path: review.path, count: review.changedLines, writer: writer.label || t("track.theWriter") }), "success");
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [slug, feature, busy, phaseFile, phaseFileInfo, writer, worktree, onSendToWriter, say, t]);

  const promote = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const out = await trackPromote(worktree, slugFromBranch(state.branch, worktree), promoteTrack, null);
      const made = out.created ? t("track.featureCreated", { slug: out.slug, track: promoteTrack }) : t("track.quickNoFolder", { slug: out.slug });
      say(out.branch ? `${made} — ${out.branch}` : made, "success");
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [busy, worktree, state.branch, promoteTrack, say, t]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "SELECT" || target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
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
      } else if (e.key === "s" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void skip();
      }
    },
    [approve, openPreview, openInEditor, sendEdits, skip],
  );

  const phases = meta ? TRACK_PHASES[meta.track] : [];
  const doneIdx = meta ? (meta.phase === "done" ? phases.length : phases.indexOf(meta.phase)) : -1;

  return (
    <aside
      className="track-panel"
      data-testid="track-panel"
      data-slug={slug ?? ""}
      data-phase={meta?.phase ?? ""}
      data-gate={meta?.gate ?? ""}
      data-track={meta?.track ?? ""}
      data-role={role}
      data-error={feature?.error ? "true" : "false"}
      aria-label={t("track.ariaLabel")}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <header className="track-head">
        <span className="track-title">{t("track.title")}</span>
        {slug && <span className="track-slug mono">{slug}</span>}
        {meta && <span className="track-kind">{meta.track}</span>}
        <span className={`track-role track-role-${role}`}>{role === "writer" ? t("track.roleWriter") : role === "reader" ? t("track.roleReader", { writer: writer?.label || t("track.theWriter") }) : t("track.roleNone")}</span>
        <button type="button" className="track-close" onClick={onClose} aria-label={t("track.close")} title={t("track.close")}>
          ✕
        </button>
      </header>

      {state.branch && <div className="track-branch mono">{state.branch}</div>}

      {!feature && (
        <section className="track-empty" data-testid="track-empty">
          <p>{t("track.empty")}</p>
          <p className="text-muted">{t("track.emptyHint")}</p>
          <div className="track-promote">
            <select className="track-select" value={promoteTrack} onChange={(e) => setPromoteTrack(e.target.value as FeatureTrack)} aria-label={t("app.track")}>
              {FEATURE_TRACKS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind} {kind === "Quick" ? t("track.quickHint") : kind === "Light" ? t("track.lightHint") : t("track.fullHint")}
                </option>
              ))}
            </select>
            <button type="button" className="track-btn track-btn-primary track-make-feature" onClick={() => void promote()} disabled={busy}>
              {t("track.makeFeature")}
            </button>
          </div>
          <p className="text-muted mono">{`hermes/${slugFromBranch(state.branch, worktree)}`}</p>
        </section>
      )}

      {feature?.error && (
        <section className="track-error" data-testid="track-error" role="alert">
          <p>{t("track.unreadable", { line: feature.error.line })}</p>
          <p className="text-muted">{feature.error.message}</p>
          <button type="button" className="track-btn track-open-error" onClick={() => void openInEditor()}>
            {t("track.open")}
          </button>
        </section>
      )}

      {feature && meta && (
        <>
          <ol className="track-phases" aria-label={t("track.phases")}>
            {phases.map((p, i) => {
              const cls = i < doneIdx ? "done" : i === doneIdx ? (waiting ? "waiting" : "current") : "upcoming";
              return (
                <li key={p} className={`track-phase track-phase-${cls}`} data-phase={p} data-state={cls}>
                  <span className="track-phase-mark" aria-hidden="true">
                    {cls === "done" ? "✓" : cls === "waiting" ? "◆" : cls === "current" ? "›" : "·"}
                  </span>
                  <span className="track-phase-name">{p}</span>
                  {p === meta.phase && phaseFileInfo && (
                    <span className="track-phase-lines mono">
                      {phaseFileInfo.lines}
                      {cap ? `/${cap}` : ""}
                    </span>
                  )}
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

          <div className={`track-gate track-gate-${meta.gate}`} data-testid="track-gate">
            {waiting && (
              <>
                <span className="track-gate-text">{t("track.gateWaiting", { phase: meta.phase })}</span>
                <button type="button" className="track-btn track-btn-primary track-approve" onClick={() => void approve()} disabled={busy}>
                  {t("track.approve")} {fmt("{mod}⏎")}
                </button>
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
            <button type="button" className="track-btn track-open" onClick={() => void openPreview()} disabled={!phaseFileInfo && !feature}>
              {preview ? t("track.hide") : t("track.open")} <kbd>o</kbd>
            </button>
            <button type="button" className="track-btn track-open-editor" onClick={() => void openInEditor()}>
              {t("track.editorSplit")} <kbd>⇧O</kbd>
            </button>
            <button type="button" className="track-btn track-send-edits" onClick={() => void sendEdits()} disabled={!phaseFileInfo || busy}>
              {t("track.sendEdits")} <kbd>r</kbd>
            </button>
            <button type="button" className="track-btn track-skip" onClick={() => void skip()} disabled={meta.phase === "done" || busy}>
              {t("track.skip")} <kbd>s</kbd>
            </button>
          </div>

          {preview && (
            <pre className="track-preview mono" data-testid="track-preview" data-file={preview.name}>
              {preview.text}
            </pre>
          )}

          {!preview && feature.body && <div className="track-body text-muted">{feature.body.trim().split("\n").slice(0, 6).join("\n")}</div>}
        </>
      )}

      <footer className="track-foot text-muted">{t("track.footer", { shortcut: fmt("{mod}⏎") })}</footer>
    </aside>
  );
}
