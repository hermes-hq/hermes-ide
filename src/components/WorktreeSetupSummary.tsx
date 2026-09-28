import { useEffect, useState } from "react";
import { getSessionWorktreeInfo } from "../api/git";
import { useI18n } from "../i18n/I18nProvider";
import type { DependencySetup, WorktreeSetup } from "../types/git";
import "../styles/components/WorktreeSetupSummary.css";

/** Last folder of a path, for either separator. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** One line per cloned (or not cloned) folder, in plain words. */
export function describeDependency(d: DependencySetup): string {
  switch (d.status) {
    case "cloned":
      return `${d.folder}: cloned from ${folderName(d.source ?? "")} in ${seconds(d.millis)}, sharing disk space until changed`;
    case "already_there":
      return `${d.folder}: already in this worktree`;
    case "lockfile_changed":
      return `${d.folder}: ${d.lockfiles.join(", ")} differs from every other checkout. Install ${d.kind} as usual`;
    case "not_installed_elsewhere":
      return `${d.folder}: not installed in any other checkout yet. Install ${d.kind} as usual`;
    case "copy_on_write_unavailable":
      return `${d.folder}: not cloned, ${d.detail ?? "this disk cannot share files"}. Install ${d.kind} as usual`;
    case "failed":
      return `${d.folder}: could not be cloned (${d.detail ?? "unknown error"}). Install ${d.kind} as usual`;
  }
}

/**
 * What preparing a session's worktree did: its ports and, per lockfile, the
 * folder cloned copy-on-write or why it was not (fast worktrees, N17).
 */
function WorktreeSetupSummary({ setup }: { setup: WorktreeSetup }) {
  const { t } = useI18n();
  const ports = setup.ports;
  return (
    <div className="worktree-setup" data-port-base={ports?.base}>
      {ports ? (
        <div className="worktree-setup-ports" title={t("worktreeSetup.portsTitle")}>
          {t("worktreeSetup.ports", { first: ports.base, last: ports.base + ports.count - 1, port: ports.base })}
        </div>
      ) : (
        <div className="worktree-setup-ports worktree-setup-warn">{t("worktreeSetup.noPorts")}</div>
      )}
      {setup.dependencies.map((d) => (
        <div
          key={d.folder}
          className={`worktree-setup-dep${d.status === "cloned" || d.status === "already_there" ? "" : " worktree-setup-warn"}`}
          data-folder={d.folder}
          data-status={d.status}
          data-method={d.method}
          data-millis={d.millis}
        >
          {describeDependency(d)}
        </div>
      ))}
    </div>
  );
}

/** The setup of one session's worktree in one project, once it was prepared. */
export function SessionWorktreeSetup({ sessionId, projectId }: { sessionId: string; projectId: string }) {
  const [setup, setSetup] = useState<WorktreeSetup | null>(null);
  useEffect(() => {
    let live = true;
    setSetup(null);
    getSessionWorktreeInfo(sessionId, projectId)
      .then((info) => {
        if (live) setSetup(info?.setup ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sessionId, projectId]);
  return setup ? <WorktreeSetupSummary setup={setup} /> : null;
}
