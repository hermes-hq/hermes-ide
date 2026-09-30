// ─── Hand off a task to another agent (N19) ───────────────────────────
//
// Two ways, one dialog: continue the task in another agent on the same
// checkout, or duplicate it to another agent on a child branch. The task
// (editable) and the files changed so far become the new agent's first
// prompt, passed as a launch argument — never typed into a terminal. The
// dialog shows exactly what the new agent is told.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/components/HandoffDialog.css";
import { useI18n } from "../i18n/I18nProvider";
import { useSession } from "../state/SessionContext";
import { useSessionEvents } from "../agent/contract/sessionEventStore";
import { listAgents } from "../catalog/agentCatalog";
import { checkAiProviders, updateSessionGroup } from "../api/sessions";
import { getSessionProjects } from "../api/projects";
import {
  gitStatus,
  getSessionWorktreeInfo,
  gitListBranchesForProject,
  createWorktree,
  attachWorktree,
  removeWorktree,
  detachWorktree,
} from "../api/git";
import {
  buildHandoffSeed,
  changedFilesOf,
  defaultTask,
  handoffTargets,
  type ChangedFile,
  type HandoffKind,
  type HandoffTarget,
} from "../limits/handoff";
import { HandoffError, runHandoff } from "../limits/runHandoff";
import { isLimited } from "../limits/limitStatus";
import type { SessionData } from "../types/session";
import { Button, CloseButton, RadioGroup, Textarea } from "./ui";

interface HandoffDialogProps {
  session: SessionData;
  initialKind: HandoffKind;
  onClose: () => void;
}

export function HandoffDialog({ session, initialKind, onClose }: HandoffDialogProps) {
  const { t } = useI18n();
  const { createSession } = useSession();
  const events = useSessionEvents(session.id);
  const [kind, setKind] = useState<HandoffKind>(initialKind);
  const [task, setTask] = useState(() => defaultTask(session));
  const [installed, setInstalled] = useState<Record<string, boolean> | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    checkAiProviders()
      .then((r) => live && setInstalled(r))
      .catch(() => live && setInstalled({}));
    gitStatus(session.id)
      .then((s) => {
        if (!live) return;
        setFiles(changedFilesOf(s.projects));
        setBranch(s.projects.find((p) => p.is_git_repo && p.branch)?.branch ?? null);
      })
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, [session.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, busy]);

  const targets: HandoffTarget[] = useMemo(
    () => (installed ? handoffTargets(listAgents(), session.ai_provider, installed) : []),
    [installed, session.ai_provider],
  );

  // Pick the first ready agent once the list is known.
  useEffect(() => {
    if (agentId === null) {
      const first = targets.find((x) => x.state === "ready");
      if (first) setAgentId(first.agent.id);
    }
  }, [targets, agentId]);

  const limited = isLimited(events);
  const seed = useMemo(
    () =>
      buildHandoffSeed({
        kind,
        task,
        limited,
        branch: kind === "continue" ? branch : null,
        changedFiles: files ?? [],
        parentBranch: branch,
      }),
    [kind, task, limited, branch, files],
  );

  const start = useCallback(async () => {
    if (!agentId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runHandoff(
        { kind, parent: session, agentId, seed },
        {
          newSessionId: () => crypto.randomUUID(),
          sessionProjects: getSessionProjects,
          worktreeInfo: getSessionWorktreeInfo,
          branchNames: async (projectId) => (await gitListBranchesForProject(projectId)).map((b) => b.name),
          createWorktree,
          attachWorktree,
          removeWorktree,
          detachWorktree,
          createSession,
          setGroup: updateSessionGroup,
        },
      );
      onClose();
    } catch (e) {
      const message = e instanceof HandoffError && e.code === "no_branch"
        ? t("handoff.error.noBranch")
        : t("handoff.error.failed", { reason: e instanceof Error ? e.message : String(e) });
      setError(message);
      setBusy(false);
    }
  }, [agentId, busy, kind, session, seed, createSession, onClose, t]);

  const stateLabel = (x: HandoffTarget) =>
    x.state === "not_installed" ? t("handoff.agent.notInstalled") : x.state === "no_prompt" ? t("handoff.agent.noPrompt") : "";

  return createPortal(
    <div className="handoff-overlay">
      <div
        className="handoff-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-title"
        data-session-id={session.id}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="handoff-header">
          <span className="handoff-title" id="handoff-title">{t("handoff.title")}</span>
          <CloseButton className="handoff-close" onClick={onClose} label={t("handoff.cancel")} disabled={busy} />
        </div>
        <div className="handoff-body">
          <RadioGroup<HandoffKind>
            className="handoff-kinds"
            name="handoff-kind"
            label={t("handoff.title")}
            value={kind}
            onChange={setKind}
            options={(["continue", "duplicate"] as const).map((k) => ({
              value: k,
              label: t(k === "continue" ? "handoff.continue" : "handoff.duplicate"),
              description: t(k === "continue" ? "handoff.continueHint" : "handoff.duplicateHint"),
              disabled: busy,
            }))}
          />

          <div className="handoff-section-label">{t("handoff.agent")}</div>
          {installed === null && <div className="handoff-muted">{t("handoff.loading")}</div>}
          <RadioGroup
            className="handoff-agents"
            name="handoff-agent"
            label={t("handoff.agent")}
            value={agentId}
            onChange={setAgentId}
            options={targets.map((x) => ({
              value: x.agent.id,
              label: x.agent.name,
              description: x.state !== "ready" ? stateLabel(x) : undefined,
              disabled: x.state !== "ready" || busy,
            }))}
          />

          <label className="handoff-section-label" htmlFor="handoff-task">{t("handoff.task")}</label>
          <Textarea
            id="handoff-task"
            className="handoff-task"
            value={task}
            rows={3}
            onChange={(e) => setTask(e.target.value)}
            disabled={busy}
          />

          {kind === "continue" && (
            <div className="handoff-files">
              <div className="handoff-section-label">
                {files === null ? t("handoff.loading") : t("handoff.files", { count: files.length })}
              </div>
              {files && files.length > 0 && (
                <ul className="handoff-file-list">
                  {files.slice(0, 12).map((f) => (
                    <li key={f.path} className="handoff-file" data-status={f.status}>{f.path}</li>
                  ))}
                  {files.length > 12 && <li className="handoff-file handoff-muted">{t("handoff.moreFiles", { count: files.length - 12 })}</li>}
                </ul>
              )}
            </div>
          )}

          <details className="handoff-seed">
            <summary>{t("handoff.seedPreview")}</summary>
            <pre className="handoff-seed-text">{seed}</pre>
          </details>
          <p className="handoff-note">{t("handoff.note")}</p>

          {error && <div className="handoff-error" role="alert">{error}</div>}
        </div>
        <div className="handoff-actions">
          <Button className="handoff-btn-cancel" onClick={onClose} disabled={busy}>{t("handoff.cancel")}</Button>
          <Button
            variant="primary"
            className="handoff-btn-start"
            onClick={() => void start()}
            disabled={!agentId || files === null}
            loading={busy}
          >
            {busy ? t("handoff.starting") : t("handoff.start")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
