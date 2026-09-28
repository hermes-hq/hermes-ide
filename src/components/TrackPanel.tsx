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
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionData } from "../types/session";
import { useTrack, noteOwnApproval, phaseFileOf, type TrackFeatureState } from "../track/store";
import { trackApprove, trackFilePath, trackPromote, trackReadFile, trackSkip, trackWriteReview } from "../track/api";
import { attachedSessions, PHASE_LINE_CAP, TRACK_PHASES } from "../track/rules";
import { FEATURE_TRACKS, type FeatureTrack } from "../agent/contract/featureFrontMatter";
import { useToastStore } from "../hooks/useToastStore";
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

export function TrackPanel({ session, sessions, onOpenInEditorSplit, onSendToWriter, onClose }: TrackPanelProps) {
  const worktree = session.working_directory;
  const state = useTrack(worktree);
  const toast = useToastStore();
  const feature: TrackFeatureState | undefined = state.features.find((f) => f.slug === state.slug) ?? (state.features.length === 1 ? state.features[0] : undefined);
  const attached = useMemo(() => attachedSessions(sessions, worktree), [sessions, worktree]);
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
      say(`${slug}: approved ${move.from}; next phase ${move.to}`, "success");
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [slug, waiting, busy, worktree, say]);

  const skip = useCallback(async () => {
    if (!slug || !meta || meta.phase === "done" || busy) return;
    setBusy(true);
    try {
      const move = await trackSkip(worktree, slug);
      say(`${slug}: skipped ${move.from}; now at ${move.to}`, "info");
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [slug, meta, busy, worktree, say]);

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
      say("This phase has no file to send back", "warning");
      return;
    }
    if (!writer) {
      say("No session is attached to this worktree", "warning");
      return;
    }
    setBusy(true);
    try {
      const review = await trackWriteReview(worktree, slug, name, feature.baseline[name] ?? null);
      await onSendToWriter(writer.id, review.line);
      say(`Sent ${review.path} (${review.changedLines} changed line${review.changedLines === 1 ? "" : "s"}) to ${writer.label || "the writer"}`, "success");
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [slug, feature, busy, phaseFile, phaseFileInfo, writer, worktree, onSendToWriter, say]);

  const promote = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const out = await trackPromote(worktree, slugFromBranch(state.branch, worktree), promoteTrack, null);
      say(out.created ? `Feature ${out.slug} created (${promoteTrack} track)` : `Quick track: no feature folder for ${out.slug}`, "success");
    } catch (e) {
      say(String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [busy, worktree, state.branch, promoteTrack, say]);

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
      aria-label="Feature track"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <header className="track-head">
        <span className="track-title">Track</span>
        {slug && <span className="track-slug mono">{slug}</span>}
        {meta && <span className="track-kind">{meta.track}</span>}
        <span className={`track-role track-role-${role}`}>{role === "writer" ? "writer" : role === "reader" ? `reader of ${writer?.label || "writer"}` : "no writer"}</span>
        <button type="button" className="track-close" onClick={onClose} aria-label="Close track panel" title="Close">
          ✕
        </button>
      </header>

      {state.branch && <div className="track-branch mono">{state.branch}</div>}

      {!feature && (
        <section className="track-empty" data-testid="track-empty">
          <p>No feature track in this worktree.</p>
          <p className="text-muted">Guided work keeps its questions, plan and gates as short files under .hermes/features/. Any agent drives it with `hi phase`.</p>
          <div className="track-promote">
            <select className="track-select" value={promoteTrack} onChange={(e) => setPromoteTrack(e.target.value as FeatureTrack)} aria-label="Track">
              {FEATURE_TRACKS.map((t) => (
                <option key={t} value={t}>
                  {t} {t === "Quick" ? "(no files)" : t === "Light" ? "(questions, plan, implement)" : "(every phase)"}
                </option>
              ))}
            </select>
            <button type="button" className="track-btn track-btn-primary track-make-feature" onClick={() => void promote()} disabled={busy}>
              Make it a feature
            </button>
          </div>
          <p className="text-muted mono">hermes/{slugFromBranch(state.branch, worktree)}</p>
        </section>
      )}

      {feature?.error && (
        <section className="track-error" data-testid="track-error" role="alert">
          <p>
            feature.md can't be read (line {feature.error.line})
          </p>
          <p className="text-muted">{feature.error.message}</p>
          <button type="button" className="track-btn track-open-error" onClick={() => void openInEditor()}>
            Open
          </button>
        </section>
      )}

      {feature && meta && (
        <>
          <ol className="track-phases" aria-label="Phases">
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
                <span className="track-phase-name">done</span>
              </li>
            )}
          </ol>

          <div className={`track-gate track-gate-${meta.gate}`} data-testid="track-gate">
            {waiting && (
              <>
                <span className="track-gate-text">
                  ◆ {meta.phase} is ready for your review
                </span>
                <button type="button" className="track-btn track-btn-primary track-approve" onClick={() => void approve()} disabled={busy}>
                  Approve {fmt("{mod}⏎")}
                </button>
              </>
            )}
            {meta.gate === "approved" && <span className="track-gate-text">approved — the agent starts {meta.phase} with `hi phase`</span>}
            {meta.gate === "none" && meta.phase !== "done" && <span className="track-gate-text text-muted">{meta.phase} in progress</span>}
            {meta.phase === "done" && <span className="track-gate-text">done — land it from the Land sheet or `hi land`</span>}
          </div>

          {feature.questions.length > 0 && (
            <section className="track-questions" aria-label="Questions">
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
              {preview ? "Hide" : "Open"} <kbd>o</kbd>
            </button>
            <button type="button" className="track-btn track-open-editor" onClick={() => void openInEditor()}>
              $EDITOR split <kbd>⇧O</kbd>
            </button>
            <button type="button" className="track-btn track-send-edits" onClick={() => void sendEdits()} disabled={!phaseFileInfo || busy}>
              Send my edits <kbd>r</kbd>
            </button>
            <button type="button" className="track-btn track-skip" onClick={() => void skip()} disabled={meta.phase === "done" || busy}>
              Skip <kbd>s</kbd>
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

      <footer className="track-foot text-muted">
        {fmt("{mod}⏎")} approve · o open · ⇧O editor · r send edits · s skip
      </footer>
    </aside>
  );
}
