import "../styles/components/SetupWizard.css";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { useI18n } from "../i18n/I18nProvider";
import { createProject, getProjectsOrdered } from "../api/projects";
import { setSetting } from "../api/settings";
import { probeTaskRepo } from "../api/launcher";
import { getAgentCapabilities } from "../agent/capabilities";
import type { ProjectOrdered } from "../types/project";
import { setAnalyticsEnabled } from "../utils/analytics";
import { shortcutLabel } from "../utils/keymap";
import { getAgent } from "../catalog/agentCatalog";
import { refreshDoctor, useAgentDoctor } from "../launcher/doctorStore";
import { allowedBehindWelcome, setMenuGate } from "../hooks/nativeMenuBridge";
import { useModalTabTrap } from "../hooks/useFocusTrap";
import { ONBOARDING_COMPLETED_SETTING } from "./startupDialogSettings";
import { AgentDoctor } from "./AgentDoctor";
import { TaskLauncher, type TaskLaunchRequest, type TaskLaunchResult, type TaskLauncherControl } from "./TaskLauncher";
import { Button, Checkbox, Input, RadioGroup } from "./ui";

export type SetupStep = "agents" | "repo" | "task";
export const SETUP_STEPS: readonly SetupStep[] = ["agents", "repo", "task"];

export interface SetupWizardProps {
  /** Starts the first task (the same path as ⌘N). */
  onLaunch: (req: TaskLaunchRequest) => Promise<TaskLaunchResult>;
  /** Opens a terminal running the agent's CLI, where it signs in (in an added account's profile when one is given). */
  onSignIn: (agentId: string, accountId?: string | null) => void;
  /** Opens a plain shell. */
  onOpenShell: () => void;
  /** Called once the welcome is done, however it ended. */
  onDone?: () => void;
}

const RECENT_REPOS = 6;
/** How long the welcome says "Finish setup first" after a menu key it does not allow. */
const NUDGE_MS = 2200;

/** The Privacy Policy the classic welcome asks people to accept, too. */
export const PRIVACY_POLICY_URL = "https://hermes-ide.com/legal";

/** A translated sentence with an element spliced in at its {placeholder}. */
function withNodes(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/\{(\w+)\}/).map((part, i) => (i % 2 === 1 ? <Fragment key={i}>{nodes[part]}</Fragment> : part));
}

/** What step 2's path check found. */
type RepoState = { path: string; root: string | null; exists: boolean; isDir: boolean; resolved: string | null };

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
 *
 * The welcome is modal for the keyboard too: each step puts the keyboard
 * where it starts, Tab stays inside, and the menu bar does nothing behind
 * it but Help (it says "Finish setup first"). The first task typed on step
 * 3 survives Back, and is never thrown away without asking.
 */
export function SetupWizard({ onLaunch, onSignIn, onOpenShell, onDone }: SetupWizardProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<SetupStep>("agents");
  const [visible, setVisible] = useState(true);
  // Signing in happens in a terminal behind this screen, so it steps aside.
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [projects, setProjects] = useState<ProjectOrdered[]>([]);
  const [repo, setRepo] = useState("");
  const [repoState, setRepoState] = useState<RepoState | null>(null);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  // Step 3's task, kept across Back and Continue (the launcher starts with it).
  const [taskText, setTaskText] = useState("");
  const [canStart, setCanStart] = useState(false);
  // Finish with a task typed: "Start it now?"
  const [asking, setAsking] = useState(false);
  // A menu key pressed behind the welcome: it says why nothing happened.
  const [nudge, setNudge] = useState(false);
  const doctor = useAgentDoctor();
  const dialogRef = useRef<HTMLDivElement>(null);
  const launcher = useRef<TaskLauncherControl | null>(null);

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
        .then(
          (p) =>
            !cancelled &&
            setRepoState({ path, root: p.git_root, exists: p.exists !== false, isDir: p.is_dir !== false, resolved: p.resolved && p.resolved !== path ? p.resolved : null }),
        )
        .catch(() => !cancelled && setRepoState({ path, root: null, exists: true, isDir: true, resolved: null }));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repo]);

  // The menu bar and the app chords stand back while the welcome is up (not
  // while it steps aside for a sign-in terminal).
  const showing = visible && !signingIn;
  useEffect(() => {
    if (!showing) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = setMenuGate((actionId) => {
      if (allowedBehindWelcome(actionId)) return true;
      setNudge(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setNudge(false), NUDGE_MS);
      return false;
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [showing]);

  useModalTabTrap(dialogRef, showing);

  // Each step puts the keyboard where it starts.
  useEffect(() => {
    if (!showing || asking) return;
    const root = dialogRef.current;
    if (!root) return;
    const at =
      step === "agents"
        ? (root.querySelector<HTMLElement>(policyAccepted ? ".setup-continue" : "#setup-policy-accept") ?? root.querySelector<HTMLElement>(".setup-continue"))
        : step === "repo"
          ? root.querySelector<HTMLElement>(".setup-repo-input")
          : root.querySelector<HTMLElement>(".task-launcher-task");
    const raf = requestAnimationFrame(() => at?.focus());
    return () => cancelAnimationFrame(raf);
    // policyAccepted: read once per step, not when the box is ticked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, showing, asking]);

  const repoChecked = repoState && repoState.path === repo.trim() ? repoState : null;
  const repoRoot = repoChecked?.root ?? null;
  // Any folder will do: a git repository's main checkout, or a plain folder
  // (the agent then works directly in it, with no worktree).
  const repoFolder = repoRoot ?? (repoChecked && repoChecked.exists && repoChecked.isDir ? repoChecked.resolved ?? repoChecked.path : null);
  const anyInstalled = useMemo(() => (doctor.rows ?? []).some((r) => r.installed), [doctor.rows]);

  const finish = useCallback(async () => {
    // Usage stats stay off: this screen never turns them on (Settings does).
    await setAnalyticsEnabled(false);
    // The repository picked on step 2 is a project from now on (⌘N starts there).
    if (repoFolder) {
      try {
        const known = await getProjectsOrdered().catch(() => [] as ProjectOrdered[]);
        if (!known.some((p) => p.path === repoFolder)) await createProject(repoFolder, null);
      } catch (err) {
        console.warn("[SetupWizard] could not add the repository as a project:", err);
      }
    }
    await setSetting(ONBOARDING_COMPLETED_SETTING, "true").catch(console.warn);
    setVisible(false);
    onDone?.();
  }, [onDone, repoFolder]);

  const signIn = useCallback(
    (agentId: string, accountId?: string | null) => {
      if (accountId) onSignIn(agentId, accountId);
      else onSignIn(agentId);
      setSigningIn(agentId);
    },
    [onSignIn],
  );

  /** Back from the sign-in terminal: the doctor and the agent's sign-in state read afresh (not from a cache). */
  const resume = useCallback(async () => {
    const agentId = signingIn;
    setResuming(true);
    try {
      await Promise.all([refreshDoctor(), agentId ? getAgentCapabilities(agentId, null, true).catch(() => null) : Promise.resolve(null)]);
    } finally {
      setResuming(false);
      setSigningIn(null);
    }
  }, [signingIn]);

  const launch = useCallback(
    async (req: TaskLaunchRequest) => {
      const ok = await onLaunch(req);
      if (ok) await finish();
      return ok;
    },
    [onLaunch, finish],
  );

  const onTaskState = useCallback((s: { task: string; canLaunch: boolean }) => {
    setTaskText(s.task);
    setCanStart(s.canLaunch);
  }, []);

  const startTask = useCallback(() => {
    setAsking(false);
    void launcher.current?.launch();
  }, []);

  /** "Finish" / "Skip for now": with a task typed, ask what to do with it first. */
  const onFinish = useCallback(() => {
    if (step === "task" && taskText.trim()) {
      setAsking(true);
      return;
    }
    void finish();
  }, [step, taskText, finish]);

  if (!visible) return null;

  if (signingIn) {
    return (
      <div className="setup-pill" role="status">
        <span>{t("onboarding.signInNote", { agent: getAgent(signingIn)?.name ?? signingIn })}</span>
        <Button variant="primary" className="setup-resume" disabled={resuming} onClick={() => void resume()}>
          {resuming ? t("launcher.checkingSignIn") : t("onboarding.resume")}
        </Button>
      </div>
    );
  }

  const title = step === "agents" ? t("onboarding.agents.title") : step === "repo" ? t("onboarding.repo.title") : t("onboarding.task.title");
  const repoMessage = !repoChecked
    ? null
    : repoRoot
      ? t("onboarding.repo.okAt", { root: repoRoot })
      : !repoChecked.exists
        ? t("onboarding.repo.missing")
        : !repoChecked.isDir
          ? t("onboarding.repo.notAFolder")
          : t("folder.notGitHint");
  const hasTask = step === "task" && taskText.trim().length > 0;

  return (
    <div className="setup-backdrop">
      <div
        ref={dialogRef}
        className={`setup-dialog${nudge ? " setup-dialog--nudge" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-title"
        data-step={step}
      >
        <div className="setup-header">
          <span className="setup-title" id="setup-title">
            {title}
          </span>
          {nudge && (
            <span className="setup-nudge" role="status">
              {t("onboarding.finishFirst")}
            </span>
          )}
          <span className="setup-step">{t("onboarding.step", { n: idx + 1, total: SETUP_STEPS.length })}</span>
        </div>

        <div className="setup-body">
          {step === "agents" && (
            <>
              <p className="setup-intro">{t("doctor.intro")}</p>
              <AgentDoctor onSignIn={signIn} />
              <div className="setup-policy">
                <Checkbox
                  id="setup-policy-accept"
                  checked={policyAccepted}
                  onChange={setPolicyAccepted}
                  label={withNodes(t("onboarding.policyAccept"), {
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
                />
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
                <div className="setup-recent">
                  <div className="setup-section-label" aria-hidden="true">{t("onboarding.repo.recent")}</div>
                  <RadioGroup
                    label={t("onboarding.repo.recent")}
                    value={projects.some((p) => p.path === repo) ? repo : null}
                    onChange={setRepo}
                    options={projects.map((p) => ({
                      value: p.path,
                      label: p.name,
                      description: <span className="setup-repo-path">{p.path}</span>,
                      attrs: { className: "setup-repo" },
                    }))}
                  />
                </div>
              )}
              <div className="setup-repo-row">
                <Input
                  code
                  className="setup-repo-input"
                  aria-label={t("launcher.repoPlaceholder")}
                  aria-describedby={repoChecked ? "setup-repo-state" : undefined}
                  value={repo}
                  spellCheck={false}
                  placeholder={t("launcher.repoPlaceholder")}
                  onChange={(e) => setRepo(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter on a repository moves on, as Continue does.
                    if (e.key === "Enter" && !e.nativeEvent.isComposing && repoFolder) {
                      e.preventDefault();
                      setStep("task");
                    }
                  }}
                />
                <Button
                  className="setup-choose"
                  onClick={async () => {
                    const picked = await open({ directory: true, multiple: false });
                    if (typeof picked === "string" && picked) setRepo(picked);
                  }}
                >
                  {t("onboarding.repo.choose")}
                </Button>
              </div>
              {/* Always in the page, so a screen reader hears each new answer. */}
              <div id="setup-repo-state" className="setup-repo-live" role="status" aria-live="polite">
                {repoChecked && (
                  <div className={`setup-repo-state${repoFolder ? " ok" : " bad"}`} data-git={repoRoot ? "true" : "false"} data-missing={!repoChecked.exists ? "true" : undefined}>
                    {repoChecked.resolved && <span className="setup-repo-resolved">{t("launcher.repoResolved", { path: repoChecked.resolved })} </span>}
                    {repoMessage}
                  </div>
                )}
              </div>
            </>
          )}

          {step === "task" && (
            <>
              <p className="setup-intro">{anyInstalled ? t("onboarding.task.intro") : t("onboarding.task.noAgent", { shortcut: shortcutLabel("file.new-session") })}</p>
              <TaskLauncher
                inline
                defaultRepo={repoFolder}
                initialTask={taskText}
                controlRef={launcher}
                onStateChange={onTaskState}
                onLaunch={launch}
                onSignIn={signIn}
              />
              {asking && (
                <div className="setup-ask" role="alertdialog" aria-labelledby="setup-ask-text">
                  <span id="setup-ask-text">{t("onboarding.task.askStart", { task: taskText.trim().split(/\r?\n/)[0] })}</span>
                  <span className="setup-ask-actions">
                    <Button variant="primary" className="setup-ask-start" disabled={!canStart} onClick={startTask} autoFocus>
                      {t("onboarding.task.start")}
                    </Button>
                    <Button
                      className="setup-ask-keep"
                      onClick={() => {
                        launcher.current?.keepAsDraft();
                        setAsking(false);
                        void finish();
                      }}
                    >
                      {t("onboarding.task.keepDraft")}
                    </Button>
                    <Button
                      variant="quiet"
                      className="setup-ask-discard"
                      onClick={() => {
                        setAsking(false);
                        void finish();
                      }}
                    >
                      {t("onboarding.task.discard")}
                    </Button>
                  </span>
                </div>
              )}
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
              <Button variant="quiet" className="setup-back" onClick={() => setStep(SETUP_STEPS[idx - 1])}>
                {t("onboarding.back")}
              </Button>
            )}
            {step === "agents" && (
              <Button
                variant="primary"
                className="setup-continue"
                disabled={!policyAccepted}
                aria-describedby={policyAccepted ? undefined : "setup-policy-hint"}
                onClick={() => setStep("repo")}
              >
                {t("onboarding.continue")}
              </Button>
            )}
            {step === "repo" && (
              <>
                <Button className="setup-skip" onClick={() => setStep("task")}>
                  {t("onboarding.skip")}
                </Button>
                <Button
                  variant="primary"
                  className="setup-continue"
                  disabled={!repoFolder}
                  aria-describedby={repoChecked ? "setup-repo-state" : undefined}
                  onClick={() => setStep("task")}
                >
                  {t("onboarding.continue")}
                </Button>
              </>
            )}
            {step === "task" && (
              <>
                <Button
                  className="setup-open-shell"
                  onClick={async () => {
                    await finish();
                    onOpenShell();
                  }}
                >
                  {t("onboarding.openShell")}
                </Button>
                {/* One primary: Start task once a task is typed, else Finish. */}
                {hasTask ? (
                  <>
                    <Button className="setup-finish" onClick={onFinish}>
                      {t("onboarding.skipForNow")}
                    </Button>
                    <Button
                      variant="primary"
                      className="setup-start-task"
                      disabled={!canStart}
                      aria-describedby={!canStart ? "task-launcher-blocks" : undefined}
                      onClick={startTask}
                    >
                      {t("onboarding.task.startEnter")}
                    </Button>
                  </>
                ) : (
                  <Button variant="primary" className="setup-finish" onClick={onFinish}>
                    {t("onboarding.finish")}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
