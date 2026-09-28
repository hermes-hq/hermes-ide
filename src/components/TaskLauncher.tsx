import "../styles/components/TaskLauncher.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../i18n/I18nProvider";
import { getAgent, installCommand, listAgents } from "../catalog/agentCatalog";
import { getSetting, setSetting } from "../api/settings";
import { getDiskStatus } from "../api/git";
import { probeTaskRepo, type RepoProbe } from "../api/launcher";
import type { DiskStatus } from "../types/git";
import type { SessionMode } from "../types/session";
import { shortcutLabel } from "../utils/keymap";
import { LAST_AI_PROVIDER_KEY } from "../utils/lastAiProvider";
import {
  SESSION_MODE_BY_PROVIDER_KEY,
  hasAgentView,
  parseSessionModeByProvider,
  preferredSessionMode,
  rememberSessionMode,
  type SessionModeByProvider,
} from "../utils/sessionModePref";
import { doctorById, ensureDoctor, getDoctorState, refreshDoctor, useAgentDoctor } from "../launcher/doctorStore";
import {
  TASK_TRACKS,
  agentTakesFirstPrompt,
  blockingRows,
  canLaunch,
  doneWhenFromToml,
  formatBytes,
  pickDefaultAgent,
  secondAgentBranch,
  taskBranch,
  type BlockingRow,
  type TaskTrack,
} from "../launcher/taskLauncher";

/** What the launcher asks the app to start. */
export interface TaskLaunchRequest {
  task: string;
  /** The repository's main checkout. */
  repoRoot: string;
  /** The first entry is the main agent; a second one runs the same task on its own branch. */
  agents: { id: string; mode: SessionMode; branch: string }[];
  track: TaskTrack;
  doneWhen: string[];
}

export interface TaskLauncherProps {
  /** Starts the task; resolves true when the first agent started. */
  onLaunch: (req: TaskLaunchRequest) => Promise<boolean>;
  onClose?: () => void;
  /** Opens the full creator (SSH, tmux, an existing branch). */
  onOpenAdvanced?: () => void;
  /** Opens a terminal running the agent, where it signs in. */
  onSignIn: (agentId: string) => void;
  /** The repository of the active session, when there is one. */
  defaultRepo: string | null;
  /** Rendered inside another screen (the welcome's last step) instead of as a sheet. */
  inline?: boolean;
}

const PROBE_DELAY_MS = 200;

export function TaskLauncher({ onLaunch, onClose, onOpenAdvanced, onSignIn, defaultRepo, inline = false }: TaskLauncherProps) {
  const { t } = useI18n();
  const doctor = useAgentDoctor();
  const byId = useMemo(() => doctorById(doctor.rows), [doctor.rows]);
  const agents = useMemo(() => listAgents(), []);
  const agentIds = useMemo(() => agents.map((a) => a.id), [agents]);

  const [task, setTask] = useState("");
  // undefined until the setting has been read.
  const [lastUsed, setLastUsed] = useState<string | null | undefined>(undefined);
  const [agentId, setAgentId] = useState<string | null>(null);
  // Once the person picks an agent, the doctor's answer no longer changes it.
  const [agentPicked, setAgentPicked] = useState(false);
  const [modePrefs, setModePrefs] = useState<SessionModeByProvider>({});
  const [mode, setMode] = useState<SessionMode>("terminal");
  const [repoPath, setRepoPath] = useState(defaultRepo ?? "");
  const [probe, setProbe] = useState<{ path: string; result: RepoProbe } | null>(null);
  const [branch, setBranch] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [track, setTrack] = useState<TaskTrack>("Quick");
  const [secondOn, setSecondOn] = useState(false);
  const [secondId, setSecondId] = useState<string | null>(null);
  const [disk, setDisk] = useState<DiskStatus | null>(null);
  const [launching, setLaunching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);

  // One-time reads: the doctor (shared, cached), the remembered agent and
  // view, and the disk.
  useEffect(() => {
    // Show what the doctor last said at once, and ask again in the
    // background: a sign-in done since then must unblock Launch.
    if (getDoctorState().rows) void refreshDoctor();
    else ensureDoctor();
    getSetting(LAST_AI_PROVIDER_KEY).then((v) => setLastUsed(v || null)).catch(() => setLastUsed(null));
    getSetting(SESSION_MODE_BY_PROVIDER_KEY)
      .then((raw) => setModePrefs(parseSessionModeByProvider(raw)))
      .catch(() => {});
    getDiskStatus().then(setDisk).catch(() => setDisk(null));
    taskRef.current?.focus();
  }, []);

  // Preselect an agent from what is known (the one used last), and again
  // when the doctor answers, until the person picks one.
  useEffect(() => {
    if (agentPicked || lastUsed === undefined) return;
    const pick = pickDefaultAgent(lastUsed, agentIds, byId);
    if (pick !== agentId) setAgentId(pick);
  }, [agentPicked, agentId, lastUsed, agentIds, byId]);

  // The remembered Terminal / Agent view choice for the chosen agent.
  useEffect(() => {
    setMode(preferredSessionMode(modePrefs, agentId));
  }, [agentId, modePrefs]);

  // The branch follows the task until the user types their own.
  useEffect(() => {
    if (!branchEdited) setBranch(taskBranch(task));
  }, [task, branchEdited]);

  // Is the folder a repository, which branches exist, what is "done"?
  useEffect(() => {
    const path = repoPath.trim();
    if (!path) {
      setProbe(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      probeTaskRepo(path)
        .then((result) => {
          if (!cancelled) setProbe({ path, result });
        })
        .catch(() => {
          if (!cancelled) setProbe({ path, result: { git_root: null, branch_exists: false, local_branches: [], worktree_toml: null } });
        });
    }, PROBE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repoPath]);

  const probed = probe && probe.path === repoPath.trim() ? probe.result : null;
  const gitRoot = repoPath.trim() ? (probed ? probed.git_root : undefined) : undefined;
  const branches = useMemo(() => new Set(probed?.local_branches ?? []), [probed]);
  const doneWhen = useMemo(() => doneWhenFromToml(probed?.worktree_toml), [probed]);

  const secondChoices = useMemo(() => agents.filter((a) => a.id !== agentId), [agents, agentId]);
  useEffect(() => {
    if (!secondOn) return;
    if (secondId && secondChoices.some((a) => a.id === secondId)) return;
    const installed = secondChoices.find((a) => byId[a.id]?.installed);
    setSecondId((installed ?? secondChoices[0])?.id ?? null);
  }, [secondOn, secondId, secondChoices, byId]);

  const plannedAgents = useMemo(() => {
    const list: { id: string; mode: SessionMode; branch: string }[] = [];
    if (agentId) list.push({ id: agentId, mode: hasAgentView(agentId) ? mode : "terminal", branch: branch.trim() });
    if (agentId && secondOn && secondId) {
      list.push({ id: secondId, mode: "terminal", branch: secondAgentBranch(branch.trim(), secondId) });
    }
    return list;
  }, [agentId, mode, branch, secondOn, secondId]);

  const rows = useMemo(
    () =>
      blockingRows({
        agents: plannedAgents,
        doctor: byId,
        repoPath,
        gitRoot,
        branchExists: (b) => branches.has(b),
        disk: disk ? { freeBytes: disk.free_bytes, requiredBytes: disk.required_bytes, belowThreshold: disk.below_threshold } : null,
      }),
    [plannedAgents, byId, repoPath, gitRoot, branches, disk],
  );
  const ready = canLaunch(task, gitRoot, rows) && plannedAgents.length > 0 && !launching;

  const launch = useCallback(async () => {
    if (!ready || !agentId || !gitRoot) return;
    setLaunching(true);
    setFailed(false);
    const nextPrefs = rememberSessionMode(modePrefs, agentId, plannedAgents[0].mode);
    setSetting(SESSION_MODE_BY_PROVIDER_KEY, JSON.stringify(nextPrefs)).catch(() => {});
    setSetting(LAST_AI_PROVIDER_KEY, agentId).catch(() => {});
    let ok = false;
    try {
      ok = await onLaunch({ task: task.trim(), repoRoot: gitRoot, agents: plannedAgents, track, doneWhen: doneWhen.commands });
    } catch (err) {
      console.error("[TaskLauncher] launch failed:", err);
    }
    setLaunching(false);
    if (!ok) setFailed(true);
  }, [ready, agentId, gitRoot, modePrefs, plannedAgents, onLaunch, task, track, doneWhen.commands]);

  const onTaskKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void launch();
    }
  };
  const onSheetKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && onClose) {
      e.stopPropagation();
      onClose();
    }
  };

  const chooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string" && picked) setRepoPath(picked);
  };

  const copyInstall = (id: string) => {
    const cmd = installCommand(getAgent(id));
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => setCopied(id)).catch(console.error);
  };

  const agentName = (id: string) => byId[id]?.name ?? getAgent(id)?.name ?? id;

  const renderRow = (row: BlockingRow, i: number) => {
    const key = `${row.kind}-${i}`;
    switch (row.kind) {
      case "not-installed":
        return (
          <div className="task-launcher-block" data-kind={row.kind} data-agent-id={row.agentId} key={key}>
            <span>{t("launcher.block.notInstalled", { agent: agentName(row.agentId) })}</span>
            {installCommand(getAgent(row.agentId)) && (
              <button type="button" className="task-launcher-link" onClick={() => copyInstall(row.agentId)}>
                {copied === row.agentId ? t("launcher.copied") : t("launcher.copyInstall")}
              </button>
            )}
          </div>
        );
      case "signed-out":
        return (
          <div className="task-launcher-block" data-kind={row.kind} data-agent-id={row.agentId} key={key}>
            <span>{t("launcher.block.signedOut", { agent: agentName(row.agentId) })}</span>
            <button type="button" className="task-launcher-link task-launcher-sign-in" onClick={() => onSignIn(row.agentId)}>
              {t("launcher.signIn")}
            </button>
            <button type="button" className="task-launcher-link" onClick={doctor.refresh} disabled={doctor.loading}>
              {t("doctor.recheck")}
            </button>
          </div>
        );
      case "no-repo":
        return (
          <div className="task-launcher-block" data-kind={row.kind} key={key}>
            {t("launcher.block.noRepo")}
          </div>
        );
      case "not-git":
        return (
          <div className="task-launcher-block" data-kind={row.kind} key={key}>
            {t("launcher.block.notGit")}
          </div>
        );
      case "branch-exists":
        return (
          <div className="task-launcher-block" data-kind={row.kind} key={key}>
            <span>{t("launcher.block.branchExists", { branch: row.branch })}</span>
            {row.branch === branch.trim() && (
              <button
                type="button"
                className="task-launcher-link task-launcher-use-branch"
                onClick={() => {
                  setBranch(row.suggestion);
                  setBranchEdited(true);
                }}
              >
                {t("launcher.useBranch", { branch: row.suggestion })}
              </button>
            )}
          </div>
        );
      case "bad-branch":
        return (
          <div className="task-launcher-block" data-kind={row.kind} key={key}>
            {t("launcher.block.badBranch", { branch: row.branch || "—" })}
          </div>
        );
      case "low-disk":
        return (
          <div className="task-launcher-block" data-kind={row.kind} key={key}>
            {t("launcher.block.lowDisk", { free: formatBytes(row.freeBytes), required: formatBytes(row.requiredBytes) })}
          </div>
        );
    }
  };

  const agentStatus = (id: string) => {
    const row = byId[id];
    if (!row) return "";
    if (!row.installed) return ` — ${t("doctor.notInstalled")}`;
    return row.version ? ` ${row.version}` : "";
  };

  const noFirstPrompt = plannedAgents.filter((a) => a.mode === "terminal" && !agentTakesFirstPrompt(a.id));

  const body = (
    <div className={`task-launcher${inline ? " task-launcher-inline" : ""}`} onKeyDown={onSheetKey}>
      {!inline && (
        <div className="task-launcher-header">
          <span className="task-launcher-title">{t("launcher.title")}</span>
          {onClose && (
            <button type="button" className="task-launcher-close" aria-label={t("launcher.close")} onClick={onClose}>
              ×
            </button>
          )}
        </div>
      )}
      <div className="task-launcher-body">
        <label className="task-launcher-label" htmlFor="task-launcher-task">{t("launcher.taskLabel")}</label>
        <textarea
          id="task-launcher-task"
          ref={taskRef}
          className="task-launcher-task"
          rows={3}
          value={task}
          placeholder={t("launcher.taskPlaceholder")}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={onTaskKey}
        />

        <div className="task-launcher-grid">
          <label className="task-launcher-label" htmlFor="task-launcher-agent">{t("launcher.agentLabel")}</label>
          <div className="task-launcher-field">
            <select
              id="task-launcher-agent"
              className="task-launcher-agent"
              value={agentId ?? ""}
              onChange={(e) => {
                setAgentPicked(true);
                setAgentId(e.target.value);
              }}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {agentStatus(a.id)}
                </option>
              ))}
            </select>
            {hasAgentView(agentId) && (
              <div className="task-launcher-view" role="radiogroup" aria-label={t("launcher.viewLabel")}>
                {(["terminal", "agent"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    data-mode={m}
                    className={`task-launcher-seg${mode === m ? " selected" : ""}`}
                    onClick={() => setMode(m)}
                  >
                    {m === "terminal" ? t("launcher.viewTerminal") : t("launcher.viewAgent")}
                  </button>
                ))}
              </div>
            )}
          </div>

          <label className="task-launcher-label" htmlFor="task-launcher-repo">{t("launcher.repoLabel")}</label>
          <div className="task-launcher-field">
            <input
              id="task-launcher-repo"
              className="task-launcher-repo"
              value={repoPath}
              spellCheck={false}
              placeholder={t("launcher.repoPlaceholder")}
              onChange={(e) => setRepoPath(e.target.value)}
            />
            <button type="button" className="task-launcher-btn" onClick={() => void chooseFolder()}>
              {t("launcher.repoChoose")}
            </button>
          </div>

          <label className="task-launcher-label" htmlFor="task-launcher-branch">{t("launcher.branchLabel")}</label>
          <div className="task-launcher-field">
            <input
              id="task-launcher-branch"
              className="task-launcher-branch"
              value={branch}
              spellCheck={false}
              onChange={(e) => {
                setBranch(e.target.value);
                setBranchEdited(true);
              }}
            />
          </div>

          <span className="task-launcher-label">{t("launcher.doneWhenLabel")}</span>
          <div className="task-launcher-done-when" data-count={doneWhen.commands.length}>
            {doneWhen.error
              ? t("launcher.doneWhenUnreadable", { reason: doneWhen.error })
              : doneWhen.commands.length > 0
                ? doneWhen.commands.map((c) => <code key={c}>{c}</code>)
                : <span className="task-launcher-muted">{t("launcher.doneWhenNone")}</span>}
          </div>

          <span className="task-launcher-label">{t("launcher.trackLabel")}</span>
          <div className="task-launcher-track" role="radiogroup" aria-label={t("launcher.trackLabel")}>
            {TASK_TRACKS.map((tr) => (
              <button
                key={tr}
                type="button"
                role="radio"
                aria-checked={track === tr}
                data-track={tr}
                title={t(`launcher.trackHint.${tr}`)}
                className={`task-launcher-seg${track === tr ? " selected" : ""}`}
                onClick={() => setTrack(tr)}
              >
                {t(`launcher.track.${tr}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="task-launcher-second">
          <label className="task-launcher-check">
            <input type="checkbox" checked={secondOn} onChange={(e) => setSecondOn(e.target.checked)} />
            <span>{t("launcher.secondAgent")}</span>
          </label>
          {secondOn && (
            <select
              className="task-launcher-second-agent"
              aria-label={t("launcher.secondAgentLabel")}
              value={secondId ?? ""}
              onChange={(e) => setSecondId(e.target.value)}
            >
              {secondChoices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {agentStatus(a.id)}
                </option>
              ))}
            </select>
          )}
        </div>

        {(rows.length > 0 || noFirstPrompt.length > 0 || failed || (doctor.loading && !doctor.rows)) && (
          <div className="task-launcher-rows">
            {doctor.loading && !doctor.rows && <div className="task-launcher-note">{t("doctor.checking")}</div>}
            {rows.map(renderRow)}
            {noFirstPrompt.map((a) => (
              <div className="task-launcher-note" data-kind="no-first-prompt" key={`nfp-${a.id}`}>
                {t("launcher.noFirstPrompt", { agent: agentName(a.id) })}
              </div>
            ))}
            {failed && (
              <div className="task-launcher-block" data-kind="failed">
                {t("launcher.failed")}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="task-launcher-footer">
        {onOpenAdvanced ? (
          <button type="button" className="task-launcher-link task-launcher-advanced" onClick={onOpenAdvanced}>
            {t("launcher.advanced", { shortcut: shortcutLabel("file.new-session-advanced") })}
          </button>
        ) : (
          <span />
        )}
        <div className="task-launcher-actions">
          <span className="task-launcher-keys">{t("launcher.keys")}</span>
          <button type="button" className="task-launcher-btn task-launcher-launch" disabled={!ready} onClick={() => void launch()}>
            {launching ? t("launcher.launching") : t("launcher.launch")}
          </button>
        </div>
      </div>
    </div>
  );

  if (inline) return body;
  return (
    <div className="task-launcher-overlay" role="dialog" aria-modal="true" aria-label={t("launcher.title")} onClick={onClose}>
      <div className="task-launcher-sheet" onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  );
}
