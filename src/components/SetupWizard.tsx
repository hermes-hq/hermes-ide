import "../styles/components/SetupWizard.css";
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { useI18n } from "../i18n/I18nProvider";
import { getProjectsOrdered } from "../api/projects";
import { setSetting } from "../api/settings";
import { probeTaskRepo } from "../api/launcher";
import type { ProjectOrdered } from "../types/project";
import { setAnalyticsEnabled } from "../utils/analytics";
import { shortcutLabel } from "../utils/keymap";
import { getAgent } from "../catalog/agentCatalog";
import { refreshDoctor, useAgentDoctor } from "../launcher/doctorStore";
import { ONBOARDING_COMPLETED_SETTING } from "./startupDialogSettings";
import { AgentDoctor } from "./AgentDoctor";
import { TaskLauncher, type TaskLaunchRequest } from "./TaskLauncher";

export type SetupStep = "agents" | "repo" | "task";
export const SETUP_STEPS: readonly SetupStep[] = ["agents", "repo", "task"];

export interface SetupWizardProps {
  /** Starts the first task (the same path as ⌘N). */
  onLaunch: (req: TaskLaunchRequest) => Promise<boolean>;
  /** Opens a terminal running the agent's CLI, where it signs in. */
  onSignIn: (agentId: string) => void;
  /** Opens a plain shell. */
  onOpenShell: () => void;
  /** Called once the welcome is done, however it ended. */
  onDone?: () => void;
}

const RECENT_REPOS = 6;

/** The Privacy Policy the classic welcome asks people to accept, too. */
export const PRIVACY_POLICY_URL = "https://hermes-ide.com/legal";

/** A translated sentence with an element spliced in at its {placeholder}. */
function withNodes(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((part, i) => (i % 2 === 1 ? <Fragment key={i}>{nodes[part]}</Fragment> : part));
}

/**
 * First launch, terminal first (F16): 1 Your agents (the doctor), 2 Pick a
 * repo, 3 First task (the launcher). No step needs an agent: with none
 * installed, Continue still works and Hermes is a terminal. As in the
 * classic welcome, the Privacy Policy must be accepted first: Continue on
 * step 1 waits for it, and the welcome only completes after it, so the
 * completed welcome (onboarding_completed, the setting both welcomes write)
 * is the record that it was accepted; nobody who finished either welcome is
 * asked again. Theme lives in Settings; usage stats are off unless turned on
 * there.
 */
export function SetupWizard({ onLaunch, onSignIn, onOpenShell, onDone }: SetupWizardProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<SetupStep>("agents");
  const [visible, setVisible] = useState(true);
  // Signing in happens in a terminal behind this screen, so it steps aside.
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOrdered[]>([]);
  const [repo, setRepo] = useState("");
  const [repoState, setRepoState] = useState<{ path: string; root: string | null } | null>(null);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const doctor = useAgentDoctor();

  const idx = SETUP_STEPS.indexOf(step);

  useEffect(() => {
    if (step !== "repo") return;
    getProjectsOrdered()
      .then((list) => setProjects(list.filter((p) => p.path_exists).slice(0, RECENT_REPOS)))
      .catch(() => setProjects([]));
  }, [step]);

  useEffect(() => {
    const path = repo.trim();
    if (!path) {
      setRepoState(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      probeTaskRepo(path)
        .then((p) => !cancelled && setRepoState({ path, root: p.git_root }))
        .catch(() => !cancelled && setRepoState({ path, root: null }));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repo]);

  const finish = useCallback(async () => {
    // Usage stats stay off: this screen never turns them on (Settings does).
    await setAnalyticsEnabled(false);
    await setSetting(ONBOARDING_COMPLETED_SETTING, "true").catch(console.warn);
    setVisible(false);
    onDone?.();
  }, [onDone]);

  const signIn = useCallback(
    (agentId: string) => {
      onSignIn(agentId);
      setSigningIn(agentId);
    },
    [onSignIn],
  );

  const launch = useCallback(
    async (req: TaskLaunchRequest) => {
      const ok = await onLaunch(req);
      if (ok) await finish();
      return ok;
    },
    [onLaunch, finish],
  );

  const repoChecked = repoState && repoState.path === repo.trim() ? repoState : null;
  const repoRoot = repoChecked?.root ?? null;
  const anyInstalled = useMemo(() => (doctor.rows ?? []).some((r) => r.installed), [doctor.rows]);

  if (!visible) return null;

  if (signingIn) {
    return (
      <div className="setup-pill" role="status">
        <span>{t("onboarding.signInNote", { agent: getAgent(signingIn)?.name ?? signingIn })}</span>
        <button
          type="button"
          className="setup-btn setup-btn-primary setup-resume"
          onClick={() => {
            setSigningIn(null);
            void refreshDoctor();
          }}
        >
          {t("onboarding.resume")}
        </button>
      </div>
    );
  }

  const title = step === "agents" ? t("onboarding.agents.title") : step === "repo" ? t("onboarding.repo.title") : t("onboarding.task.title");

  return (
    <div className="setup-backdrop">
      <div className="setup-dialog" role="dialog" aria-modal="true" aria-label={title} data-step={step}>
        <div className="setup-header">
          <span className="setup-title">{title}</span>
          <span className="setup-step">{t("onboarding.step", { n: idx + 1, total: SETUP_STEPS.length })}</span>
        </div>

        <div className="setup-body">
          {step === "agents" && (
            <>
              <p className="setup-intro">{t("doctor.intro")}</p>
              <AgentDoctor onSignIn={signIn} />
              <div className="setup-policy">
                <input
                  id="setup-policy-accept"
                  type="checkbox"
                  checked={policyAccepted}
                  onChange={(e) => setPolicyAccepted(e.target.checked)}
                />
                <label htmlFor="setup-policy-accept">
                  {withNodes(t("onboarding.policyAccept"), {
                    policy: (
                      <a
                        href={PRIVACY_POLICY_URL}
                        className="setup-policy-link"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void openUrl(PRIVACY_POLICY_URL);
                        }}
                      >
                        {t("onboarding.privacyPolicy")}
                      </a>
                    ),
                  })}
                </label>
                {!policyAccepted && (
                  <span id="setup-policy-hint" className="setup-policy-hint">
                    {t("onboarding.policyRequired")}
                  </span>
                )}
              </div>
            </>
          )}

          {step === "repo" && (
            <>
              <p className="setup-intro">{t("onboarding.repo.intro")}</p>
              {projects.length > 0 && (
                <div className="setup-recent" role="radiogroup" aria-label={t("onboarding.repo.recent")}>
                  <div className="setup-section-label">{t("onboarding.repo.recent")}</div>
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={repo === p.path}
                      className={`setup-repo${repo === p.path ? " selected" : ""}`}
                      onClick={() => setRepo(p.path)}
                    >
                      <span className="setup-repo-name">{p.name}</span>
                      <span className="setup-repo-path">{p.path}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="setup-repo-row">
                <input
                  className="setup-repo-input"
                  value={repo}
                  spellCheck={false}
                  placeholder={t("launcher.repoPlaceholder")}
                  onChange={(e) => setRepo(e.target.value)}
                />
                <button
                  type="button"
                  className="setup-btn"
                  onClick={async () => {
                    const picked = await open({ directory: true, multiple: false });
                    if (typeof picked === "string" && picked) setRepo(picked);
                  }}
                >
                  {t("onboarding.repo.choose")}
                </button>
              </div>
              {repoChecked && (
                <div className={`setup-repo-state${repoRoot ? " ok" : " bad"}`} data-git={repoRoot ? "true" : "false"}>
                  {repoRoot ? t("onboarding.repo.ok") : t("onboarding.repo.notGit")}
                </div>
              )}
            </>
          )}

          {step === "task" && (
            <>
              <p className="setup-intro">{anyInstalled ? t("onboarding.task.intro") : t("onboarding.task.noAgent", { shortcut: shortcutLabel("file.new-session") })}</p>
              <TaskLauncher inline defaultRepo={repoRoot} onLaunch={launch} onSignIn={signIn} />
            </>
          )}
        </div>

        <div className="setup-footer">
          <div className="setup-footer-note">
            <span className="setup-usage" data-usage-stats="off">{t("onboarding.usageStats")}</span>
            <span className="setup-muted">{t("onboarding.moreInSettings")}</span>
          </div>
          <div className="setup-actions">
            {idx > 0 && (
              <button type="button" className="setup-btn setup-back" onClick={() => setStep(SETUP_STEPS[idx - 1])}>
                {t("onboarding.back")}
              </button>
            )}
            {step === "agents" && (
              <button
                type="button"
                className="setup-btn setup-btn-primary setup-continue"
                disabled={!policyAccepted}
                aria-describedby={policyAccepted ? undefined : "setup-policy-hint"}
                onClick={() => setStep("repo")}
              >
                {t("onboarding.continue")}
              </button>
            )}
            {step === "repo" && (
              <>
                <button type="button" className="setup-btn setup-skip" onClick={() => setStep("task")}>
                  {t("onboarding.skip")}
                </button>
                <button
                  type="button"
                  className="setup-btn setup-btn-primary setup-continue"
                  disabled={!repoRoot}
                  onClick={() => setStep("task")}
                >
                  {t("onboarding.continue")}
                </button>
              </>
            )}
            {step === "task" && (
              <>
                <button
                  type="button"
                  className="setup-btn setup-open-shell"
                  onClick={async () => {
                    await finish();
                    onOpenShell();
                  }}
                >
                  {t("onboarding.openShell")}
                </button>
                <button type="button" className="setup-btn setup-finish" onClick={() => void finish()}>
                  {t("onboarding.finish")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
