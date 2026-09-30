import "../styles/components/TaskLauncher.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../i18n/I18nProvider";
import { Button, Checkbox, Chip, CloseButton, IconButton, Input, Segmented, Select, Textarea, type SelectOption } from "./ui";
import type { ControlAttrs } from "./ui/attrs";
import { cx } from "./ui/Button";
import { CloseGlyph } from "./ui/icons";
import { customAgent, getAgent, installCommand, listAgents } from "../catalog/agentCatalog";
import { getSetting, setSetting } from "../api/settings";
import { getDiskStatus } from "../api/git";
import { getProjectsOrdered } from "../api/projects";
import { probeTaskRepo, type RepoProbe } from "../api/launcher";
import type { DiskStatus } from "../types/git";
import type { SessionMode } from "../types/session";
import type { AgentCapabilities, CheckedPreset, ChoiceIssue, LaunchChoice } from "../agent/capabilities/types";
import { reconcileChoice } from "../agent/capabilities/choice";
import { takesChannels } from "../agent/providers/launchQuirks";
import { shortcutLabel } from "../utils/keymap";
import { fmt, PLATFORM } from "../utils/platform";
import { AI_AGENT_PREFIXES_KEY, parseAgentPrefixes } from "../utils/aiProviders";
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
import { capabilityBackend, safetyDefault, validateChoice, type LauncherBackend, type SessionLaunch } from "../launcher/backend";
import {
  PRESET_SHORTCUTS,
  defaultChoice,
  effortsFor,
  rememberedForm,
  sameCombo,
  switchAgent,
  uniquePresetName,
} from "../launcher/choice";
import { clearLauncherDraft, saveLauncherDraft, setPendingSuggestion, takeLauncherDraft, takePendingSuggestion } from "../launcher/draft";
import { overlayOpened } from "../state/overlays";
import {
  TASK_LAUNCHES_KEY,
  agentTakesFirstPrompt,
  blockingRows,
  canLaunch,
  doneWhenFromToml,
  formatBytes,
  parseTaskLaunches,
  pickDefaultAgent,
  secondAgentBranch,
  taskBranch,
  taskLabel,
  type BlockingRow,
  type TaskTrack,
} from "../launcher/taskLauncher";

/** One agent session the launcher asks the app to start. */
export interface PlannedAgent {
  id: string;
  mode: SessionMode;
  /** The new worktree's branch, or the existing branch; "" for the current checkout. */
  branch: string;
  /** True when the branch is created (a new worktree). */
  createBranch: boolean;
  /** The branch a new one is cut from ("" = the repository's current branch). */
  baseBranch: string;
  /** False: the session runs in the repository's own checkout. */
  worktree: boolean;
  launch: SessionLaunch;
  choice: LaunchChoice;
}

/** What the launcher asks the app to start. */
export interface TaskLaunchRequest {
  task: string;
  /** The repository's main checkout. */
  repoRoot: string;
  /** The first entry is the main agent; a second one runs the same task on its own branch. */
  agents: PlannedAgent[];
  track: TaskTrack;
  doneWhen: string[];
  /** The full combination (the main agent's choice, with the second agent under alsoOn). */
  choice: LaunchChoice;
  /** The sheet stays open after this launch (Launch & next, or the inline launcher). */
  staysOpen?: boolean;
}

/** true: started; "queued": waits for a free slot (running-agents cap); false: failed. */
export type TaskLaunchResult = boolean | "queued";

export interface TaskLauncherProps {
  onLaunch: (req: TaskLaunchRequest) => Promise<TaskLaunchResult>;
  /** Closes the sheet. `keepDraft`: a click outside, the draft comes back on ⌘N. */
  onClose?: (opts?: { keepDraft: boolean }) => void;
  /** Opens the full creator (SSH, tmux). */
  onOpenAdvanced?: () => void;
  /** Opens a terminal running the agent, where it signs in. */
  onSignIn: (agentId: string) => void;
  /** Opens Settings > Agents (accounts and presets). */
  onManageAccounts?: () => void;
  /** The repository of the active session, when there is one. */
  defaultRepo: string | null;
  /** Rendered inside another screen (the welcome's last step) instead of as a sheet. */
  inline?: boolean;
  /** Test seam: the capability/usual/preset backend (the capability commands otherwise). */
  backend?: LauncherBackend;
}

const PROBE_DELAY_MS = 200;
const RECENT_COUNT = 3;
type Menu = null | "agent" | "project" | "where" | "approval" | "model" | "effort";
type WhereKind = LaunchChoice["where"]["kind"];
/** A part of a stored choice that is not available now; "where": a base branch this repository does not have. */
type LauncherIssue = Omit<ChoiceIssue, "field" | "code"> & { field: ChoiceIssue["field"] | "where"; code: ChoiceIssue["code"] | "baseBranchMissing" };

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let s = p.trim().replace(/[\\/]+$/, "");
    if (PLATFORM === "win") s = s.replace(/\//g, "\\").toLowerCase();
    return s;
  };
  return norm(a) === norm(b);
}

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Arrow keys move the focus between the buttons of an open menu. A control
 * that takes the arrow keys itself (a field, a Select, a segmented control)
 * keeps them, and only its tab stop is a stop here.
 */
function onMenuKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (e.defaultPrevented) return;
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input, [role='combobox']")).filter((el) => el.tabIndex >= 0);
  if (items.length === 0) return;
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.getAttribute("role") === "combobox") return;
  const i = items.indexOf(target);
  let next = i;
  if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  else if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % items.length;
  else next = (i - 1 + items.length) % items.length;
  e.preventDefault();
  items[next]?.focus();
}

export function TaskLauncher({ onLaunch, onClose, onOpenAdvanced, onSignIn, onManageAccounts, defaultRepo, inline = false, backend: backendProp }: TaskLauncherProps) {
  const { t } = useI18n();
  const doctor = useAgentDoctor();
  const byId = useMemo(() => doctorById(doctor.rows), [doctor.rows]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const defaultAgentRef = useRef<() => string>(() => "claude");
  // What each agent offers comes from the capability commands, and only from them.
  const backend: LauncherBackend = backendProp ?? capabilityBackend;
  const agents = useMemo(() => {
    const list = listAgents();
    const custom = customAgent();
    return custom ? [...list, custom] : list;
  }, []);
  const agentIds = useMemo(() => agents.map((a) => a.id), [agents]);

  // ── state ────────────────────────────────────────────────────────
  const [task, setTask] = useState("");
  const [choice, setChoice] = useState<LaunchChoice | null>(null);
  const [repoPath, setRepoPath] = useState(defaultRepo ?? "");
  const [probe, setProbe] = useState<{ path: string; result: RepoProbe } | null>(null);
  const [branch, setBranch] = useState("");
  const [branchEdited, setBranchEdited] = useState(false);
  const [checks, setChecks] = useState<string[]>([]);
  const [checksEdited, setChecksEdited] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<Menu>(null);
  const [modePrefs, setModePrefs] = useState<SessionModeByProvider>({});
  const [viewMode, setViewMode] = useState<SessionMode>("terminal");
  const [caps, setCaps] = useState<Record<string, AgentCapabilities>>({});
  const [presets, setPresets] = useState<CheckedPreset[]>([]);
  const [capsErrors, setCapsErrors] = useState<Record<string, string>>({});
  const [capsLoaded, setCapsLoaded] = useState(false);
  const [capsAttempt, setCapsAttempt] = useState(0);
  const [fallbacks, setFallbacks] = useState<{ source: string; list: LauncherIssue[]; launchable: boolean } | null>(null);
  const [previewLineState, setPreviewLine] = useState("");
  const [suggest, setSuggest] = useState<LaunchChoice | null>(null);
  const [suggestCount, setSuggestCount] = useState(0);
  const [suggestName, setSuggestName] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ path: string; name: string }[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const [prefixes, setPrefixes] = useState<Record<string, string>>({});
  const [globalSuffix, setGlobalSuffix] = useState("");
  const [defaultMode, setDefaultMode] = useState("");
  const [lastUsed, setLastUsed] = useState<string | null | undefined>(undefined);
  const [disk, setDisk] = useState<DiskStatus | null>(null);
  const [launching, setLaunching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [launched, setLaunched] = useState<{ label: string; queued: boolean }[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [ready, setReadyState] = useState(false);
  // Without an active session the most used project is the starting one; the choice waits for it.
  const [projectsLoaded, setProjectsLoaded] = useState(!!defaultRepo);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<Partial<Record<Exclude<Menu, null>, HTMLButtonElement | null>>>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const userTouched = useRef(false);
  // Where the current choice came from ("usual" or a preset's name) until the person changes it.
  const choiceSource = useRef<string | null>(null);


  // ── one-time reads ──────────────────────────────────────────────
  useEffect(() => {
    if (getDoctorState().rows) void refreshDoctor();
    else ensureDoctor();
    const read = (key: string) => getSetting(key).catch(() => "");
    void Promise.all([read(SESSION_MODE_BY_PROVIDER_KEY), read(AI_AGENT_PREFIXES_KEY), read("custom_command_suffix"), read("default_permission_mode"), read(LAST_AI_PROVIDER_KEY)]).then(
      ([modes, prefixMap, suffix, mode, last]) => {
        setModePrefs(parseSessionModeByProvider(modes));
        setPrefixes(parseAgentPrefixes(prefixMap));
        setGlobalSuffix(suffix || "");
        setDefaultMode(mode || "");
        // Set last: the starting choice waits for it (and so for all of these).
        setLastUsed(last || null);
      },
    );
    getSetting(TASK_LAUNCHES_KEY)
      .then((raw) => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const r of parseTaskLaunches(raw).reverse()) {
          const label = r.task.trim();
          if (!label || seen.has(label)) continue;
          seen.add(label);
          out.push(label);
          if (out.length >= RECENT_COUNT) break;
        }
        setRecents(out);
      })
      .catch(() => {});
    getDiskStatus().then(setDisk).catch(() => setDisk(null));
    taskRef.current?.focus();
  }, []);
  useEffect(() => {
    backend.listPresets().then(setPresets).catch(() => {});
  }, [backend]);

  // Capabilities of every agent, again when the doctor answers. An agent
  // whose capabilities cannot be read is not guessed at: the launcher says
  // so and offers to try again.
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      agentIds.map((id) =>
        backend.capabilities(id).then(
          (c) => ({ id, caps: c, error: null }),
          (err: unknown) => ({ id, caps: null, error: err instanceof Error ? err.message : String(err) }),
        ),
      ),
    ).then((list) => {
      if (cancelled) return;
      const next: Record<string, AgentCapabilities> = {};
      const errors: Record<string, string> = {};
      for (const e of list) {
        if (e.caps) next[e.id] = e.caps;
        // The Custom agent has no capabilities to read: its command is typed.
        else if (getAgent(e.id)?.custom !== true) errors[e.id] = e.error ?? "";
      }
      setCaps(next);
      setCapsErrors(errors);
      setCapsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [backend, agentIds, doctor.rows, capsAttempt]);

  // Projects, most used first (every launch is a session of its project).
  useEffect(() => {
    let cancelled = false;
    getProjectsOrdered()
      .catch(() => [])
      .then((list) => {
        if (cancelled) return;
        const sorted = list
          .filter((p) => p.path_exists !== false)
          .map((p, i) => ({ path: p.path, name: p.name || baseName(p.path), i, s: p.session_count ?? 0 }))
          .sort((a, b) => b.s - a.s || a.i - b.i);
        setProjects(sorted.map(({ path, name }) => ({ path, name })));
        if (!repoPathRef.current.trim() && sorted[0]) {
          repoPathRef.current = sorted[0].path;
          setRepoPath(sorted[0].path);
        }
        setProjectsLoaded(true);
      })
      .catch(() => setProjectsLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [backend]);
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;

  // The starting choice: the draft, else the usual combination, else the defaults.
  const initialised = useRef(false);
  useEffect(() => {
    if (initialised.current || lastUsed === undefined || !projectsLoaded || !capsLoaded) return;
    initialised.current = true;
    const pending = takePendingSuggestion();
    if (pending) {
      setSuggest(pending.choice);
      setSuggestName(pending.name);
      setSuggestCount(pending.count);
    }
    const draft = inline ? null : takeLauncherDraft();
    if (draft) {
      setTask(draft.task);
      setChoice(draft.choice);
      setRepoPath(draft.repoPath);
      setBranch(draft.branch);
      setBranchEdited(draft.branchEdited);
      setChecks(draft.checks);
      setChecksEdited(draft.checksEdited);
      setExpanded(draft.expanded);
      setReadyState(true);
      return;
    }
    defaultAgentRef.current = () => pickDefaultAgent(lastUsed, agentIds.filter((id) => id !== "custom"), byIdRef.current) ?? agentIds[0];
    void backend
      .usual(repoPathRef.current.trim() || null)
      .catch(() => null)
      .then((usual) => {
        if (userTouched.current) return;
        if (usual && usual.source !== "catalog") {
          choiceSource.current = "usual";
          setChoice(usual.choice);
          setFallbacks(usual.issues.length || !usual.launchable ? { source: "usual", list: usual.issues, launchable: usual.launchable } : null);
        } else {
          const agentId = usual?.choice.agentId ?? defaultAgentRef.current();
          setChoice(freshChoice(agentId));
        }
        setReadyState(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUsed, caps, capsLoaded, backend, projectsLoaded]);

  /** A choice for an agent nothing is remembered for: Settings defaults, else the safety default. */
  const freshChoice = useCallback(
    (agentId: string): LaunchChoice => {
      const c = caps[agentId];
      let approval = safetyDefault(agentId);
      if (defaultMode && c?.approvalModes.some((m) => m.id === defaultMode)) approval = defaultMode;
      const base = defaultChoice(agentId, c, approval);
      return { ...base, extraArgs: getAgent(agentId)?.custom ? "" : globalSuffix };
    },
    [caps, defaultMode, globalSuffix],
  );

  /** "Claude Code · opus": the agent and the model as the chips say them. */
  const defaultPresetName = useCallback(
    (c: LaunchChoice) => `${getAgent(c.agentId)?.name ?? c.agentId} · ${c.modelId === "default" ? t("launcher.modelDefault") : c.modelId}`,
    [t],
  );

  // The Settings prefix of the chosen agent(s) is part of the choice, read-only here.
  const prefixOf = useCallback((agentId: string) => (prefixes[agentId] ?? "").trim(), [prefixes]);
  const effective: LaunchChoice | null = useMemo(() => {
    if (!choice) return null;
    const next: LaunchChoice = { ...choice, prefix: prefixOf(choice.agentId) };
    if (choice.alsoOn) next.alsoOn = { ...choice.alsoOn, prefix: prefixOf(choice.alsoOn.agentId) };
    return next;
  }, [choice, prefixOf]);

  // The remembered Terminal / Agent view choice for the chosen agent.
  useEffect(() => {
    setViewMode(preferredSessionMode(modePrefs, choice?.agentId ?? null));
  }, [choice?.agentId, modePrefs]);

  // The branch follows the task until the person types their own.
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
          if (!cancelled) setProbe({ path, result: { git_root: null, branch_exists: false, local_branches: [], worktree_toml: null, current_branch: null } });
        });
    }, PROBE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [repoPath]);

  const probed = probe && probe.path === repoPath.trim() ? probe.result : null;
  const gitRoot = repoPath.trim() ? (probed ? probed.git_root : undefined) : undefined;
  const localBranches = useMemo(() => probed?.local_branches ?? [], [probed]);
  const branchSet = useMemo(() => new Set(localBranches), [localBranches]);
  const currentBranch = probed?.current_branch ?? "";
  const doneWhen = useMemo(() => doneWhenFromToml(probed?.worktree_toml), [probed]);
  useEffect(() => {
    if (!checksEdited) setChecks(doneWhen.commands);
  }, [doneWhen, checksEdited]);

  // A new worktree cut from a branch this repository does not have (a
  // preset or the usual combination from another repository, a draft, a
  // project switched afterwards) would fail to start: it is cut from the
  // current branch instead, and the launcher says so.
  useEffect(() => {
    if (!choice || choice.where.kind !== "new-worktree" || !choice.where.baseBranch || !probed || !gitRoot) return;
    if (branchSet.has(choice.where.baseBranch)) return;
    const was = choice.where.baseBranch;
    setChoice({ ...choice, where: { ...choice.where, baseBranch: "" } });
    setFallbacks((f) => ({
      source: f?.source ?? choiceSource.current ?? "repo",
      list: [...(f?.list ?? []), { field: "where", message: `${was} is not a branch of this repository; using the current branch`, was, now: null, code: "baseBranchMissing", params: { branch: was } }],
      launchable: f?.launchable ?? true,
    }));
  }, [choice, probed, gitRoot, branchSet]);

  // ── updating the choice ─────────────────────────────────────────
  // A change by the person ends the "not available now" note of a stored choice.
  const update = useCallback((patch: Partial<LaunchChoice>) => {
    userTouched.current = true;
    choiceSource.current = null;
    setFallbacks(null);
    setChoice((c) => (c ? { ...c, ...patch } : c));
  }, []);
  const updateAlso = useCallback((patch: Partial<LaunchChoice>) => {
    userTouched.current = true;
    choiceSource.current = null;
    setFallbacks(null);
    setChoice((c) => (c && c.alsoOn ? { ...c, alsoOn: { ...c.alsoOn, ...patch } } : c));
  }, []);

  // "Existing branch" chosen before the repository's branches were known:
  // the first branch other than the checked-out one, once they are.
  useEffect(() => {
    if (!choice || choice.where.kind !== "existing-branch" || choice.where.branch || localBranches.length === 0) return;
    const pick = localBranches.find((b) => b !== currentBranch) ?? localBranches[0];
    setChoice({ ...choice, where: { kind: "existing-branch", branch: pick } });
  }, [choice, localBranches, currentBranch]);

  // Switching agent: its defaults at once, then what was last launched with
  // it (model, effort, approval, extra args), if anything was.
  const pickSeq = useRef(0);
  const pickAgent = (agentId: string) => {
    if (!choice) return;
    userTouched.current = true;
    choiceSource.current = null;
    const seq = ++pickSeq.current;
    setChoice(switchAgent(choice, agentId, freshChoice(agentId)));
    setFallbacks(null);
    void backend
      .remembered(agentId)
      .catch(() => null)
      .then((last) => {
        if (!last || seq !== pickSeq.current) return;
        setChoice((cur) => (cur && cur.agentId === agentId ? switchAgent(cur, agentId, { ...last.choice, alsoOn: undefined }) : cur));
      });
  };
  const pickModel = (modelId: string) => {
    if (!choice) return;
    const efforts = effortsFor(caps[choice.agentId], modelId);
    update({ modelId, effort: choice.effort && efforts.includes(choice.effort) ? choice.effort : null });
  };

  const applyPreset = useCallback((preset: CheckedPreset) => {
    userTouched.current = true;
    // Checked again against what the agents can do now.
    const agentCaps = caps[preset.choice.agentId];
    const checked = agentCaps
      ? reconcileChoice(preset.choice, agentCaps, preset.choice.alsoOn ? caps[preset.choice.alsoOn.agentId] ?? null : null)
      : { choice: preset.effective, issues: preset.issues, launchable: preset.launchable };
    choiceSource.current = preset.name;
    setChoice(checked.choice);
    setFallbacks(checked.issues.length || !checked.launchable ? { source: preset.name, list: checked.issues, launchable: checked.launchable } : null);
    setMenu(null);
  }, [caps]);

  // ── derived ─────────────────────────────────────────────────────
  const agentCaps = choice ? caps[choice.agentId] : undefined;
  const isCustom = !!choice && getAgent(choice.agentId)?.custom === true;
  const where: LaunchChoice["where"] = useMemo(() => choice?.where ?? { kind: "new-worktree", baseBranch: "", branch: "" }, [choice?.where]);

  const plannedAgents = useMemo<PlannedAgent[]>(() => {
    if (!effective) return [];
    const mk = (c: LaunchChoice, br: string, mode: SessionMode): PlannedAgent => {
      const w = c.where;
      return {
        id: c.agentId,
        mode,
        branch: w.kind === "new-worktree" ? br : w.kind === "existing-branch" ? w.branch : "",
        createBranch: w.kind === "new-worktree",
        baseBranch: w.kind === "new-worktree" ? w.baseBranch : "",
        worktree: w.kind !== "current-checkout",
        launch: backend.sessionLaunch(c, caps[c.agentId]),
        choice: c,
      };
    };
    const mainBranch = branch.trim();
    const withBranch = (c: LaunchChoice): LaunchChoice => (c.where.kind === "new-worktree" ? { ...c, where: { ...c.where, branch: mainBranch } } : c);
    const main = withBranch(effective);
    const list = [mk(main, mainBranch, hasAgentView(effective.agentId) ? viewMode : "terminal")];
    if (effective.alsoOn) {
      // The second agent always gets its own new branch (two agents never share a checkout).
      const alsoBranch = secondAgentBranch(where.kind === "existing-branch" ? where.branch : mainBranch || taskBranch(task), effective.alsoOn.agentId);
      const also: LaunchChoice = { ...effective.alsoOn, where: { kind: "new-worktree", baseBranch: where.kind === "new-worktree" ? where.baseBranch : where.kind === "existing-branch" ? where.branch : "", branch: alsoBranch } };
      list.push(mk(also, alsoBranch, "terminal"));
    }
    return list;
  }, [effective, branch, viewMode, caps, where, task, backend]);

  const rows = useMemo(() => {
    const all = blockingRows({
      agents: plannedAgents.filter((a) => a.createBranch).map((a) => ({ id: a.id, branch: a.branch })),
      doctor: byId,
      repoPath,
      gitRoot,
      branches: localBranches,
      disk: disk ? { freeBytes: disk.free_bytes, requiredBytes: disk.required_bytes, belowThreshold: disk.below_threshold } : null,
    });
    // Agents that do not create a branch are still judged for install / sign-in.
    const extra = blockingRows({
      agents: plannedAgents.filter((a) => !a.createBranch).map((a) => ({ id: a.id, branch: "" })),
      doctor: byId,
      repoPath: "x",
      gitRoot: null,
      branches: [],
      disk: null,
    }).filter((r) => r.kind === "not-installed" || r.kind === "signed-out");
    const out: BlockingRow[] = [...all, ...extra.filter((r) => r.kind !== "not-installed" || getAgent(r.agentId)?.custom !== true)];
    if (where.kind === "existing-branch" && gitRoot && !branchSet.has(where.branch)) out.push({ kind: "bad-branch", branch: where.branch });
    // An account the capability backend knows is signed out (the doctor only sees the default profile).
    for (const a of plannedAgents) {
      const account = caps[a.id]?.accounts.find((x) => x.id === a.choice.accountId);
      if (account && !account.signedIn && !out.some((r) => r.kind === "signed-out" && r.agentId === a.id)) out.push({ kind: "signed-out", agentId: a.id });
    }
    const newWorktree = plannedAgents.some((a) => a.worktree);
    return out.filter((r) => !(r.kind === "not-installed" && getAgent(r.agentId)?.custom) && (r.kind !== "low-disk" || newWorktree));
  }, [plannedAgents, byId, repoPath, gitRoot, branchSet, localBranches, disk, where, caps]);

  const customMissing = isCustom && !choice?.extraArgs.trim();
  // A base branch the repository lacks, until the effect above has replaced it: never launched.
  const staleBase = where.kind === "new-worktree" && !!where.baseBranch && !!probed && !!gitRoot && !branchSet.has(where.baseBranch);
  // The chosen agent(s) whose capabilities could not be read: nothing to check the choice against.
  const capsError = useMemo(() => {
    for (const a of plannedAgents) if (capsErrors[a.id] !== undefined) return { agentId: a.id, error: capsErrors[a.id] };
    return null;
  }, [plannedAgents, capsErrors]);
  const validation = useMemo(() => {
    for (const a of plannedAgents) {
      const v = validateChoice(a.choice, caps[a.id]);
      if (!v.ok) return { field: v.field, value: v.message };
    }
    return null;
  }, [plannedAgents, caps]);
  // A stored choice that could not be made launchable is judged live by the
  // rows above (agent missing, account signed out), with today's answers.
  const canGo = !!choice && ready && canLaunch(task, gitRoot, rows) && plannedAgents.length > 0 && !launching && !customMissing && !validation && !capsError && !staleBase;

  useEffect(() => {
    if (!effective) return;
    let cancelled = false;
    const place =
      where.kind === "new-worktree"
        ? t("launcher.previewWorktree", { branch: branch.trim() || taskBranch(task), base: where.baseBranch || currentBranch || "HEAD" })
        : where.kind === "existing-branch"
          ? t("launcher.previewExisting", { branch: where.branch })
          : t("launcher.previewCurrent", { repo: baseName(repoPath) || "—", branch: currentBranch || "HEAD" });
    void Promise.all([
      backend.preview(effective, task).catch(() => ""),
      effective.alsoOn ? backend.preview(effective.alsoOn, task).catch(() => "") : Promise.resolve(""),
    ]).then(([main, also]) => {
      if (!cancelled) setPreviewLine(`${main}${also ? `  +  ${also}` : ""}  ·  ${place}`);
    });
    return () => {
      cancelled = true;
    };
  }, [effective, backend, task, where, branch, currentBranch, repoPath, t]);
  const previewLine = previewLineState;

  // ── actions ─────────────────────────────────────────────────────
  const close = useCallback(
    (keepDraft: boolean) => {
      if (keepDraft && choice) {
        saveLauncherDraft({ task, choice, repoPath, branch, branchEdited, checks, checksEdited, expanded });
      } else {
        clearLauncherDraft();
      }
      onClose?.({ keepDraft });
    },
    [choice, task, repoPath, branch, branchEdited, checks, checksEdited, expanded, onClose],
  );

  // One overlay at a time: the sheet closes (keeping what was typed) when the
  // inbox or the palette opens, and opening it closes them (state/overlays.ts).
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (inline) return;
    return overlayOpened("launcher", () => closeRef.current(true));
  }, [inline]);

  const launch = useCallback(
    async (next: boolean) => {
      if (!canGo || !effective || !gitRoot) return;
      setLaunching(true);
      setFailed(false);
      setMenu(null);
      const main = plannedAgents[0];
      if (hasAgentView(main.id)) {
        const nextPrefs = rememberSessionMode(modePrefs, main.id, main.mode);
        setModePrefs(nextPrefs);
        setSetting(SESSION_MODE_BY_PROVIDER_KEY, JSON.stringify(nextPrefs)).catch(() => {});
      }
      setSetting(LAST_AI_PROVIDER_KEY, main.id).catch(() => {});
      const trimmed = task.trim();
      let result: TaskLaunchResult = false;
      try {
        result = await onLaunch({
          task: trimmed,
          repoRoot: gitRoot,
          agents: plannedAgents,
          track: effective.trackAsFeature ? "Full" : "Quick",
          doneWhen: checks.map((c) => c.trim()).filter(Boolean),
          choice: plannedAgents[0].choice,
          ...(next || inline ? { staysOpen: true } : {}),
        });
      } catch (err) {
        console.error("[TaskLauncher] launch failed:", err);
      }
      setLaunching(false);
      if (!result) {
        setFailed(true);
        return;
      }
      // The combination is remembered (usual, "Save as preset?"), without the task's branch.
      const remembered = rememberedForm(effective);
      let offer = false;
      let count = 0;
      try {
        ({ suggestPreset: offer, count } = await backend.remember(remembered, gitRoot));
      } catch (err) {
        console.warn("[TaskLauncher] could not record the launch:", err);
      }
      clearLauncherDraft();
      if (offer) {
        // Offered once: recorded now, so the question never comes back for
        // this combination, whether it is answered, dismissed or ignored.
        void backend.dismissSuggestion(remembered, gitRoot).catch((err) => console.warn("[TaskLauncher] could not record the offer:", err));
        const name = uniquePresetName(defaultPresetName(remembered), presets);
        if (next || inline) {
          setSuggest(remembered);
          setSuggestName(name);
          setSuggestCount(count);
        } else {
          // Asked the next time the launcher opens.
          setPendingSuggestion({ choice: remembered, name, count });
        }
      }
      if (next) {
        setLaunched((l) => [...l, { label: taskLabel(trimmed), queued: result === "queued" }]);
        setTask("");
        setBranchEdited(false);
        requestAnimationFrame(() => taskRef.current?.focus());
        return;
      }
      onClose?.({ keepDraft: false });
    },
    [canGo, effective, gitRoot, plannedAgents, modePrefs, task, onLaunch, checks, backend, presets, inline, onClose, defaultPresetName],
  );

  const savePreset = useCallback(
    async (name: string, c: LaunchChoice) => {
      const clean = name.trim();
      if (!clean) return;
      try {
        const preset = await backend.savePreset(clean, c);
        setPresets((list) => [...list, preset]);
      } catch (err) {
        console.warn("[TaskLauncher] could not save the preset:", err);
      }
    },
    [backend],
  );

  // ── keyboard ────────────────────────────────────────────────────
  const openMenu = (m: Exclude<Menu, null>) => {
    setMenu((cur) => (cur === m ? null : m));
  };
  useEffect(() => {
    if (!menu) return;
    requestAnimationFrame(() => {
      const root = menuRef.current;
      if (!root) return;
      const target =
        root.querySelector<HTMLElement>("[aria-pressed='true'], [aria-checked='true']") ??
        root.querySelector<HTMLElement>("button:not([disabled]):not([tabindex='-1']), input, [role='combobox']");
      target?.focus();
    });
  }, [menu]);
  const closeMenu = useCallback(() => {
    const m = menu;
    setMenu(null);
    if (m) requestAnimationFrame(() => chipRefs.current[m]?.focus());
  }, [menu]);

  const onSheetKey = (e: React.KeyboardEvent) => {
    const mod = PLATFORM === "mac" ? e.metaKey : e.ctrlKey;
    const target = e.target as HTMLElement;
    const inField = target.tagName === "TEXTAREA" || target.tagName === "INPUT";
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      if (saving !== null) setSaving(null);
      else if (menu) closeMenu();
      else if (!inline) close(false);
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const preset = presets[Number(e.key) - 1];
      e.preventDefault();
      e.stopPropagation();
      if (preset && Number(e.key) <= PRESET_SHORTCUTS) applyPreset(preset);
      return;
    }
    if (mod && e.key === ".") {
      e.preventDefault();
      e.stopPropagation();
      setExpanded((x) => !x);
      setMenu(null);
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      if (mod) {
        e.preventDefault();
        e.stopPropagation();
        void launch(!inline);
        return;
      }
      if (e.shiftKey || e.altKey) return;
      if (target.tagName === "BUTTON" || target.getAttribute("role") === "radio") {
        // Enter on a chip, an option or a button presses it (the same for a
        // key from the keyboard and one sent by a script or an assistive tool).
        e.preventDefault();
        e.stopPropagation();
        target.click();
        return;
      }
      if (!inField) return;
      if (target.closest("[data-own-enter]")) return;
      e.preventDefault();
      e.stopPropagation();
      void launch(false);
    }
  };

  const chooseFolder = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string" && picked) {
      setRepoPath(picked);
      setMenu(null);
    }
  };

  const copyInstall = (id: string) => {
    const cmd = installCommand(getAgent(id));
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => setCopied(id)).catch(console.error);
  };

  const agentName = (id: string) => byId[id]?.name ?? getAgent(id)?.name ?? id;
  const accountLabel = (c: AgentCapabilities | undefined, id: string | null) => {
    const a = c?.accounts.find((x) => x.id === id);
    if (!a || a.id === "default") return t("launcher.accountDefault");
    return a.label;
  };
  const approvalLabel = (agentId: string, id: string) => {
    const key = `launcher.mode.${id}`;
    const label = t(key);
    if (label !== key) return label;
    return caps[agentId]?.approvalModes.find((m) => m.id === id)?.label ?? id;
  };
  const approvalNote = (agentId: string, id: string) => {
    const key = `launcher.modeNote.${id}`;
    const note = t(key);
    if (note !== key) return note;
    return caps[agentId]?.approvalModes.find((m) => m.id === id)?.note ?? "";
  };
  const agentNote = (id: string) => {
    if (getAgent(id)?.custom) return t("launcher.agentNoteCustom");
    const row = byId[id];
    if (!row) return t("doctor.checking");
    if (!row.installed) return t("doctor.notInstalled");
    if (row.signed_in === "no") return t("launcher.agentNoteSignedOut");
    return row.version ? t("launcher.agentNoteInstalled", { version: row.version }) : t("launcher.agentNoteInstalledNoVersion");
  };
  const fallbackText = (f: LauncherIssue) => {
    // Approval modes by their names ("Plan first"), models "default" as the chip says it.
    const name = (v: string | null) => {
      if (v === null) return f.field === "effort" ? t("launcher.effortDefault") : "—";
      if (f.field === "approval" && choice) return approvalLabel(choice.agentId, v);
      if (f.field === "model" && v === "default") return t("launcher.modelDefault");
      return v;
    };
    const text =
      f.now === null
        ? t(`launcher.fallbackGone.${f.field}`, { from: name(f.was) })
        : t(`launcher.fallback.${f.field}`, { from: name(f.was), to: name(f.now) });
    // About a preset's second agent: said so.
    return f.alsoOn ? t("agentsSettings.issue.alsoOn", { issue: text }) : text;
  };

  // ── rendering pieces ────────────────────────────────────────────
  const renderRow = (row: BlockingRow, i: number) => {
    const key = `${row.kind}-${i}`;
    switch (row.kind) {
      case "not-installed":
        return (
          <div className="task-launcher-block" data-kind={row.kind} data-agent-id={row.agentId} key={key}>
            <span>{t("launcher.block.notInstalled", { agent: agentName(row.agentId) })}</span>
            {installCommand(getAgent(row.agentId)) && (
              <Button variant="link" className="task-launcher-link" onClick={() => copyInstall(row.agentId)}>
                {copied === row.agentId ? t("launcher.copied") : t("launcher.copyInstall")}
              </Button>
            )}
          </div>
        );
      case "signed-out":
        return (
          <div className="task-launcher-block" data-kind={row.kind} data-agent-id={row.agentId} key={key}>
            <span>{t("launcher.block.signedOut", { agent: agentName(row.agentId) })}</span>
            <Button variant="link" className="task-launcher-link task-launcher-sign-in" onClick={() => onSignIn(row.agentId)}>
              {t("launcher.signIn")}
            </Button>
            <Button variant="link" className="task-launcher-link" onClick={doctor.refresh} disabled={doctor.loading}>
              {t("doctor.recheck")}
            </Button>
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
          <div className="task-launcher-block" data-kind={row.kind} data-clash={row.clash} data-existing={row.existing} key={key}>
            <span>
              {row.clash === "same"
                ? t("launcher.block.branchExists", { branch: row.branch })
                : row.clash === "case"
                  ? t("launcher.block.branchCaseClash", { branch: row.branch, existing: row.existing })
                  : t("launcher.block.branchFolderClash", { branch: row.branch, existing: row.existing })}
            </span>
            {row.branch === branch.trim() && (
              <Button
                variant="link"
                className="task-launcher-link task-launcher-use-branch"
                onClick={() => {
                  setBranch(row.suggestion);
                  setBranchEdited(true);
                }}
              >
                {t("launcher.useBranch", { branch: row.suggestion })}
              </Button>
            )}
            {row.branch === branch.trim() && row.clash !== "folder" && (
              <Button
                variant="link"
                className="task-launcher-link task-launcher-use-existing"
                onClick={() => update({ where: { kind: "existing-branch", branch: row.existing } })}
              >
                {t("launcher.useExisting", { branch: row.existing })}
              </Button>
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

  /** A chip of the row under the task: it opens its menu below the row. */
  const menuChip = (m: Exclude<Menu, null>, label: ReactNode, opts: { danger?: boolean; off?: boolean } = {}) => (
    <Chip
      expands
      selected={menu === m}
      onToggle={() => openMenu(m)}
      disabled={opts.off}
      tone={opts.danger ? "danger" : "neutral"}
      buttonRef={(el) => {
        chipRefs.current[m] = el;
      }}
      buttonAttrs={{ className: cx("task-launcher-chip", menu === m && "open", opts.danger && "danger", opts.off && "off"), "data-chip": m }}
    >
      {label}
    </Chip>
  );
  /** One value in a chip's menu: pressed when it is the current one. */
  const optionChip = (key: string, selected: boolean, onPick: () => void, label: ReactNode, attrs: ControlAttrs, opts: { note?: ReactNode; danger?: boolean; disabled?: boolean } = {}) => (
    <Chip
      key={key}
      selected={selected}
      onToggle={onPick}
      disabled={opts.disabled}
      tone={opts.danger ? "danger" : "neutral"}
      buttonAttrs={{ ...attrs, className: cx("task-launcher-option", selected && "selected", opts.danger && "danger") }}
    >
      {label}
      {opts.note ? <span className="task-launcher-option-note">{opts.note}</span> : null}
    </Chip>
  );

  const selectedMode = agentCaps?.approvalModes.find((m) => m.id === choice?.approvalModeId);
  const danger = !!selectedMode?.danger;
  const efforts = choice ? effortsFor(agentCaps, choice.modelId) : [];
  const hasEffort = efforts.length > 0;
  const whereChipText =
    where.kind === "new-worktree"
      ? t("launcher.whereChipWorktree", { branch: branch.trim() || taskBranch(task) })
      : where.kind === "existing-branch"
        ? t("launcher.whereChipExisting", { branch: where.branch || "—" })
        : t("launcher.whereChipCurrent", { branch: currentBranch || "HEAD" });

  const setWhere = (kind: WhereKind) => {
    if (kind === "new-worktree") update({ where: { kind, baseBranch: where.kind === "new-worktree" ? where.baseBranch : "", branch: "" } });
    else if (kind === "existing-branch") update({ where: { kind, branch: where.kind === "existing-branch" ? where.branch : localBranches.find((b) => b !== currentBranch) ?? localBranches[0] ?? "" } });
    else update({ where: { kind } });
  };

  const baseOptions: SelectOption[] = [
    { value: "", label: t("launcher.baseCurrent", { branch: currentBranch || "HEAD" }) },
    ...localBranches.filter((b) => b !== currentBranch).map((b) => ({ value: b, label: b })),
  ];
  const whereBlock = (
    <div className="task-launcher-where">
      <Segmented<WhereKind>
        label={t("launcher.whereLabel")}
        value={where.kind}
        onChange={setWhere}
        options={[
          { value: "new-worktree", label: t("launcher.whereWorktree"), attrs: { "data-where": "new-worktree" } },
          { value: "existing-branch", label: t("launcher.whereExisting"), attrs: { "data-where": "existing-branch" } },
          { value: "current-checkout", label: t("launcher.whereCurrent", { branch: currentBranch || "HEAD" }), attrs: { "data-where": "current-checkout" } },
        ]}
      />
      {where.kind === "new-worktree" && (
        <div className="task-launcher-where-row">
          <label className="task-launcher-inline-label" htmlFor="task-launcher-branch">{t("launcher.branchLabel")}</label>
          <Input
            id="task-launcher-branch"
            code
            className="task-launcher-branch"
            value={branch}
            spellCheck={false}
            onChange={(e) => {
              setBranch(e.target.value);
              setBranchEdited(true);
            }}
          />
          <span className="task-launcher-inline-label" aria-hidden="true">{t("launcher.baseLabel")}</span>
          <Select
            code
            className="task-launcher-base"
            aria-label={t("launcher.baseLabel")}
            value={where.baseBranch}
            options={baseOptions}
            onChange={(v) => update({ where: { kind: "new-worktree", baseBranch: v, branch: "" } })}
          />
        </div>
      )}
      {where.kind === "existing-branch" && (
        <div className="task-launcher-where-row">
          <Select
            code
            className="task-launcher-existing"
            aria-label={t("launcher.whereExisting")}
            value={where.branch}
            options={localBranches.map((b) => ({ value: b, label: b }))}
            onChange={(v) => update({ where: { kind: "existing-branch", branch: v } })}
          />
        </div>
      )}
    </div>
  );

  const approvalBlock = choice && agentCaps && (
    <div className="task-launcher-approval" data-danger={danger ? "true" : "false"}>
      <div className="task-launcher-approval-modes" role="group" aria-label={t("launcher.approvalLabel")}>
        {agentCaps.approvalModes.map((m) =>
          optionChip(m.id, m.id === choice.approvalModeId, () => update({ approvalModeId: m.id }), approvalLabel(choice.agentId, m.id), { "data-mode": m.id }, { danger: !!m.danger }),
        )}
      </div>
      <div className={`task-launcher-approval-note${danger ? " danger" : ""}`}>{approvalNote(choice.agentId, choice.approvalModeId)}</div>
      <div className="task-launcher-muted">
        {t("launcher.approvalRemembered", { agent: agentName(choice.agentId), account: accountLabel(agentCaps, choice.accountId) })}
        {" · "}
        <code>{selectedMode?.flag.length ? selectedMode.flag.join(" ") : t("launcher.noFlag")}</code>
      </div>
    </div>
  );

  const alsoSelects = (also: LaunchChoice) => {
    const c = caps[also.agentId];
    const alsoEfforts = effortsFor(c, also.modelId);
    return (
      <div className="task-launcher-also-fields">
        <Select
          className="task-launcher-also-agent"
          aria-label={t("launcher.alsoAgent")}
          value={also.agentId}
          options={agents.filter((a) => a.id !== choice?.agentId && !a.custom).map((a) => ({ value: a.id, label: a.name }))}
          onChange={(id) => {
            userTouched.current = true;
            setChoice((cur) => (cur ? { ...cur, alsoOn: { ...freshChoice(id), where: cur.where } } : cur));
          }}
        />
        <Select
          className="task-launcher-also-approval"
          aria-label={t("launcher.approvalLabel")}
          value={also.approvalModeId}
          options={(c?.approvalModes ?? []).map((m) => ({ value: m.id, label: approvalLabel(also.agentId, m.id) }))}
          onChange={(v) => updateAlso({ approvalModeId: v })}
        />
        <Select
          className="task-launcher-also-model"
          aria-label={t("launcher.modelLabel")}
          value={also.modelId}
          options={(c?.models ?? []).map((m) => ({ value: m.id, label: m.id === "default" ? t("launcher.modelDefault") : m.label, disabled: !m.available }))}
          onChange={(v) => {
            const ef = effortsFor(c, v);
            updateAlso({ modelId: v, effort: also.effort && ef.includes(also.effort) ? also.effort : null });
          }}
        />
        <Select
          className="task-launcher-also-effort"
          aria-label={t("launcher.effortLabel")}
          value={also.effort ?? ""}
          disabled={alsoEfforts.length === 0}
          options={[{ value: "", label: alsoEfforts.length === 0 ? t("launcher.effortNa") : t("launcher.effortDefault") }, ...alsoEfforts.map((ef) => ({ value: ef, label: ef }))]}
          onChange={(v) => updateAlso({ effort: v || null })}
        />
      </div>
    );
  };

  const noFirstPrompt = plannedAgents.filter((a) => a.mode === "terminal" && !agentTakesFirstPrompt(a.id));
  const presetIndex = effective ? presets.findIndex((p) => sameCombo(rememberedForm(p.choice), rememberedForm(effective))) : -1;

  const body = (
    <div className={`task-launcher${inline ? " task-launcher-inline" : ""}`} ref={sheetRef} onKeyDown={onSheetKey} data-ready={ready && choice ? "true" : "false"}>
      {!inline && (
        <div className="task-launcher-header">
          <span className="task-launcher-title">{t("launcher.title")}</span>
          <span className="task-launcher-subtitle">{t("launcher.subtitle")}</span>
          <span className="task-launcher-spacer" />
          <span className="task-launcher-keyhint">{shortcutLabel("file.new-session")}</span>
          {onClose && <CloseButton className="task-launcher-close" label={t("launcher.close")} onClick={() => close(false)} />}
        </div>
      )}

      <div className="task-launcher-presets" role="toolbar" aria-label={t("launcher.presetsLabel")}>
        {presets.map((p, i) => (
          <Chip
            key={p.id}
            selected={i === presetIndex}
            onToggle={() => applyPreset(p)}
            buttonAttrs={{
              className: cx("task-launcher-preset", i === presetIndex && "selected"),
              "data-preset-id": p.id,
              title: i < PRESET_SHORTCUTS ? fmt(`{mod}${i + 1}`) : undefined,
            }}
          >
            {i < PRESET_SHORTCUTS && <span className="task-launcher-preset-key">{fmt(`{mod}${i + 1}`)}</span>}
            {p.name}
          </Chip>
        ))}
        {saving === null ? (
          <Button
            variant="quiet"
            size="sm"
            className="task-launcher-save-preset"
            onClick={() => setSaving(choice ? uniquePresetName(defaultPresetName(choice), presets) : "")}
            disabled={!choice}
          >
            {t("launcher.saveAsPreset")}
          </Button>
        ) : (
          <span className="task-launcher-preset-form" data-own-enter="true">
            <Input
              size="sm"
              className="task-launcher-preset-name"
              aria-label={t("launcher.presetName")}
              value={saving}
              autoFocus
              onChange={(e) => setSaving(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (effective && saving.trim()) {
                    void savePreset(saving, rememberedForm(effective));
                    setSaving(null);
                    requestAnimationFrame(() => taskRef.current?.focus());
                  }
                }
              }}
            />
            <Button
              size="sm"
              className="task-launcher-preset-save"
              disabled={!saving.trim()}
              onClick={() => {
                if (effective) void savePreset(saving, rememberedForm(effective));
                setSaving(null);
              }}
            >
              {t("launcher.presetSave")}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setSaving(null)}>
              {t("launcher.cancel")}
            </Button>
          </span>
        )}
      </div>

      {suggest && (
        <div className="task-launcher-suggest" role="group" aria-label={t("launcher.suggestTitle")} data-own-enter="true">
          <span>{t("launcher.suggestTitle", { count: suggestCount })}</span>
          <Input
            size="sm"
            className="task-launcher-suggest-name"
            aria-label={t("launcher.presetName")}
            value={suggestName}
            onChange={(e) => setSuggestName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.stopPropagation();
                void savePreset(suggestName, suggest);
                setSuggest(null);
              }
            }}
          />
          <Button
            size="sm"
            className="task-launcher-suggest-save"
            disabled={!suggestName.trim()}
            onClick={() => {
              void savePreset(suggestName, suggest);
              setSuggest(null);
            }}
          >
            {t("launcher.presetSave")}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className="task-launcher-suggest-dismiss"
            onClick={() => {
              if (gitRoot) void backend.dismissSuggestion(suggest, gitRoot).catch(() => {});
              setSuggest(null);
            }}
          >
            {t("launcher.suggestDismiss")}
          </Button>
        </div>
      )}

      {fallbacks && (
        <div className="task-launcher-fallback" role="alert" data-source={fallbacks.source}>
          <span>{fallbacks.source === "usual" ? t("launcher.fallbackUsual") : fallbacks.source === "repo" ? t("launcher.fallbackRepo") : t("launcher.fallbackPreset", { name: fallbacks.source })}</span>
          {!fallbacks.launchable && <span className="task-launcher-fallback-block">{t("launcher.fallbackNotLaunchable")}</span>}
          <ul>
            {fallbacks.list.map((f, i) => (
              <li key={i} data-field={f.field}>{fallbackText(f)}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="task-launcher-sr" htmlFor="task-launcher-task">{t("launcher.taskLabel")}</label>
      <Textarea
        id="task-launcher-task"
        ref={taskRef}
        className="task-launcher-task"
        rows={3}
        value={task}
        placeholder={t("launcher.taskPlaceholder")}
        onChange={(e) => setTask(e.target.value)}
      />

      {choice && (
        <div className="task-launcher-chips" role="toolbar" aria-label={t("launcher.chipsLabel")} onKeyDown={onMenuKeys}>
          {menuChip("agent", `${agentName(choice.agentId)} · ${accountLabel(agentCaps, choice.accountId)}`)}
          {isCustom && (
            <Input
              size="sm"
              code
              className="task-launcher-custom-command"
              aria-label={t("launcher.customCommand")}
              placeholder={t("launcher.customCommandPlaceholder")}
              value={choice.extraArgs}
              spellCheck={false}
              onChange={(e) => update({ extraArgs: e.target.value })}
            />
          )}
          {menuChip("project", repoPath.trim() ? baseName(repoPath) : t("launcher.projectNone"))}
          {menuChip("where", whereChipText)}
          {!isCustom && menuChip("approval", approvalLabel(choice.agentId, choice.approvalModeId), { danger })}
          {!isCustom && menuChip("model", t("launcher.modelChip", { model: choice.modelId === "default" ? t("launcher.modelDefault") : choice.modelId }))}
          {!isCustom &&
            menuChip(
              "effort",
              hasEffort
                ? t("launcher.effortChip", { effort: choice.effort ?? t("launcher.effortDefault") })
                : t("launcher.effortNaFor", { model: choice.modelId === "default" ? t("launcher.modelDefault") : choice.modelId }),
              { off: !hasEffort },
            )}
          <Button
            variant="quiet"
            size="sm"
            className="task-launcher-expand"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((x) => !x);
              setMenu(null);
            }}
          >
            {expanded ? t("launcher.fewerOptions") : t("launcher.moreOptions", { shortcut: fmt("{mod}.") })}
          </Button>
        </div>
      )}

      {choice && menu && (
        <div className="task-launcher-menu" data-menu={menu} ref={menuRef} onKeyDown={onMenuKeys} role="group" aria-label={t(`launcher.menu.${menu}`)}>
          {menu === "agent" && (
            <>
              <div className="task-launcher-menu-items">
                {agents.map((a) => optionChip(a.id, a.id === choice.agentId, () => pickAgent(a.id), a.name, { "data-agent-id": a.id }, { note: agentNote(a.id) }))}
              </div>
              <div className="task-launcher-menu-caption">{t("launcher.accountFor", { agent: agentName(choice.agentId) })}</div>
              <div className="task-launcher-menu-items">
                {(agentCaps?.accounts ?? []).map((a) =>
                  optionChip(
                    a.id,
                    a.id === choice.accountId,
                    () => {
                      update({ accountId: a.id });
                      closeMenu();
                    },
                    a.id === "default" ? t("launcher.accountDefault") : a.label,
                    { "data-account-id": a.id },
                    { note: a.detail || (a.signedIn ? t("launcher.accountSignedIn") : t("launcher.accountSignedOut")) },
                  ),
                )}
                {onManageAccounts && (
                  <Button variant="link" className="task-launcher-link task-launcher-manage-accounts" onClick={onManageAccounts}>
                    {t("launcher.manageAccounts")}
                  </Button>
                )}
              </div>
            </>
          )}
          {menu === "project" && (
            <>
              <div className="task-launcher-menu-caption">{t("launcher.projectsCaption")}</div>
              <div className="task-launcher-menu-items task-launcher-menu-column">
                {projects.map((p) =>
                  optionChip(
                    p.path,
                    samePath(p.path, repoPath),
                    () => {
                      setRepoPath(p.path);
                      closeMenu();
                    },
                    p.name,
                    { "data-project-path": p.path, title: p.path },
                    { note: p.path },
                  ),
                )}
                <Button size="sm" className="task-launcher-browse" onClick={() => void chooseFolder()}>
                  {t("launcher.browse")}
                </Button>
              </div>
              <label className="task-launcher-inline-label" htmlFor="task-launcher-repo">{t("launcher.repoTyped")}</label>
              <Input
                id="task-launcher-repo"
                code
                className="task-launcher-repo"
                value={repoPath}
                spellCheck={false}
                placeholder={t("launcher.repoPlaceholder")}
                onChange={(e) => setRepoPath(e.target.value)}
              />
            </>
          )}
          {menu === "where" && whereBlock}
          {menu === "approval" && approvalBlock}
          {menu === "model" && agentCaps && (
            <>
              <div className="task-launcher-menu-items">
                {agentCaps.models.map((m) =>
                  optionChip(
                    m.id,
                    m.id === choice.modelId,
                    () => {
                      pickModel(m.id);
                      closeMenu();
                    },
                    m.id === "default" ? t("launcher.modelDefault") : m.label,
                    { "data-model-id": m.id, title: m.unavailableReason },
                    {
                      disabled: !m.available,
                      note: !m.available
                        ? m.unavailableReason || t("launcher.modelUnavailable")
                        : m.id === "default"
                          ? t("launcher.modelDefaultNote")
                          : m.efforts.length === 0
                            ? t("launcher.modelNoEffort")
                            : m.note || "",
                    },
                  ),
                )}
              </div>
              {agentCaps.modelSource === "free-text" && (
                <Input
                  size="sm"
                  code
                  className="task-launcher-model-text"
                  aria-label={t("launcher.modelLabel")}
                  placeholder={t("launcher.modelTyped")}
                  value={choice.modelId === "default" ? "" : choice.modelId}
                  onChange={(e) => update({ modelId: e.target.value.trim() || "default", effort: null })}
                />
              )}
              <div className="task-launcher-menu-caption">{t(`launcher.modelSource.${agentCaps.modelSource}`, { agent: agentName(choice.agentId), version: agentCaps.cliVersion ?? "" })}</div>
            </>
          )}
          {menu === "effort" && (
            <>
              <div className="task-launcher-menu-items">
                {optionChip(
                  "",
                  choice.effort === null,
                  () => {
                    update({ effort: null });
                    closeMenu();
                  },
                  t("launcher.effortDefault"),
                  { "data-effort": "" },
                )}
                {efforts.map((ef) =>
                  optionChip(
                    ef,
                    ef === choice.effort,
                    () => {
                      update({ effort: ef });
                      closeMenu();
                    },
                    ef,
                    { "data-effort": ef },
                  ),
                )}
              </div>
              <div className="task-launcher-menu-caption">{t("launcher.effortSource", { agent: agentName(choice.agentId) })}</div>
            </>
          )}
        </div>
      )}

      {choice && expanded && (
        <div className="task-launcher-options">
          <div className="task-launcher-opt-row">
            <span className="task-launcher-opt-label">{t("launcher.whereLabel")}</span>
            {whereBlock}
          </div>
          {!isCustom && (
            <div className="task-launcher-opt-row">
              <span className="task-launcher-opt-label">{t("launcher.approvalLabel")}</span>
              {approvalBlock}
            </div>
          )}
          {hasAgentView(choice.agentId) && (
            <div className="task-launcher-opt-row">
              <span className="task-launcher-opt-label">{t("launcher.viewLabel")}</span>
              <Segmented<SessionMode>
                className="task-launcher-view"
                label={t("launcher.viewLabel")}
                value={viewMode}
                onChange={setViewMode}
                options={[
                  { value: "terminal", label: t("launcher.viewTerminal"), attrs: { "data-mode": "terminal" } },
                  { value: "agent", label: t("launcher.viewAgent"), attrs: { "data-mode": "agent" } },
                ]}
              />
            </div>
          )}
          {!isCustom && (
            <div className="task-launcher-opt-row">
              <label className="task-launcher-opt-label" htmlFor="task-launcher-extra-args">{t("launcher.extraArgsLabel")}</label>
              <Input
                id="task-launcher-extra-args"
                code
                className="task-launcher-extra-args"
                value={choice.extraArgs}
                spellCheck={false}
                placeholder={t("launcher.extraArgsPlaceholder")}
                onChange={(e) => update({ extraArgs: e.target.value })}
              />
              <span className="task-launcher-muted task-launcher-prefix-note">
                {prefixOf(choice.agentId) ? t("launcher.prefixFromSettings", { prefix: prefixOf(choice.agentId) }) : t("launcher.prefixNone")}
              </span>
            </div>
          )}
          {takesChannels(choice.agentId) && (
            <div className="task-launcher-opt-row">
              <label className="task-launcher-opt-label" htmlFor="task-launcher-channels">{t("launcher.channelsLabel")}</label>
              <Input
                id="task-launcher-channels"
                code
                className="task-launcher-channels"
                value={choice.channels.join(" ")}
                spellCheck={false}
                placeholder={t("launcher.channelsPlaceholder")}
                onChange={(e) => update({ channels: e.target.value.split(/[\s,]+/).filter(Boolean) })}
              />
            </div>
          )}
          <div className="task-launcher-opt-row task-launcher-checks-row">
            <span className="task-launcher-opt-label">{t("launcher.checksLabel")}</span>
            <div className="task-launcher-checks" data-count={checks.length}>
              {doneWhen.error && <span className="task-launcher-muted">{t("launcher.doneWhenUnreadable", { reason: doneWhen.error })}</span>}
              {checks.map((c, i) => (
                <span key={i} className="task-launcher-check">
                  <Input
                    code
                    className="task-launcher-check-input"
                    aria-label={t("launcher.checkN", { n: i + 1 })}
                    value={c}
                    spellCheck={false}
                    onChange={(e) => {
                      setChecksEdited(true);
                      setChecks((list) => list.map((x, j) => (j === i ? e.target.value : x)));
                    }}
                  />
                  <IconButton
                    size="sm"
                    className="task-launcher-check-remove"
                    label={t("launcher.checkRemove", { n: i + 1 })}
                    icon={<CloseGlyph />}
                    onClick={() => {
                      setChecksEdited(true);
                      setChecks((list) => list.filter((_, j) => j !== i));
                    }}
                  />
                </span>
              ))}
              <Button
                variant="quiet"
                size="sm"
                className="task-launcher-check-add"
                onClick={() => {
                  setChecksEdited(true);
                  setChecks((list) => [...list, ""]);
                }}
              >
                {t("launcher.checkAdd")}
              </Button>
              <span className="task-launcher-muted">{checks.length ? t("launcher.checksHint") : t("launcher.doneWhenNone")}</span>
            </div>
          </div>
          <div className="task-launcher-opt-row">
            <span className="task-launcher-opt-label">{t("launcher.planningLabel")}</span>
            <Checkbox
              className="task-launcher-feature"
              inputClassName="task-launcher-feature-box"
              checked={choice.trackAsFeature}
              onChange={(on) => update({ trackAsFeature: on })}
              label={t("launcher.trackAsFeature")}
              description={t("launcher.trackAsFeatureNote", { slug: taskBranch(task).replace(/^hermes\//, "") })}
            />
          </div>
          {!isCustom && (
            <div className="task-launcher-opt-row">
              <span className="task-launcher-opt-label">{t("launcher.alsoLabel")}</span>
              <Chip
                selected={!!choice.alsoOn}
                buttonAttrs={{ className: cx("task-launcher-option", "task-launcher-also-toggle", !!choice.alsoOn && "selected") }}
                onToggle={() => {
                  userTouched.current = true;
                  setChoice((cur) => {
                    if (!cur) return cur;
                    if (cur.alsoOn) {
                      const next = { ...cur };
                      delete next.alsoOn;
                      return next;
                    }
                    const other = agents.find((a) => a.id !== cur.agentId && !a.custom && byId[a.id]?.installed) ?? agents.find((a) => a.id !== cur.agentId && !a.custom);
                    return other ? { ...cur, alsoOn: { ...freshChoice(other.id), where: cur.where } } : cur;
                  });
                }}
              >
                {choice.alsoOn ? t("launcher.alsoOn", { agent: agentName(choice.alsoOn.agentId) }) : t("launcher.alsoAdd")}
              </Chip>
              {choice.alsoOn && alsoSelects(choice.alsoOn)}
              {choice.alsoOn && <span className="task-launcher-muted">{t("launcher.alsoNote", { branch: plannedAgents[1]?.branch ?? "" })}</span>}
            </div>
          )}
        </div>
      )}

      {(rows.length > 0 || noFirstPrompt.length > 0 || failed || validation || customMissing || capsError || (doctor.loading && !doctor.rows)) && (
        <div className="task-launcher-rows">
          {doctor.loading && !doctor.rows && <div className="task-launcher-note">{t("doctor.checking")}</div>}
          {rows.map(renderRow)}
          {capsError && (
            <div className="task-launcher-block" data-kind="caps-error" data-agent-id={capsError.agentId}>
              <span>{t("launcher.block.capsError", { agent: agentName(capsError.agentId), error: capsError.error || "—" })}</span>
              <Button variant="link" className="task-launcher-link task-launcher-caps-retry" onClick={() => setCapsAttempt((n) => n + 1)}>
                {t("launcher.capsRetry")}
              </Button>
            </div>
          )}
          {validation && (
            <div className="task-launcher-block" data-kind={`invalid-${validation.field}`}>
              {t(`launcher.block.invalid.${validation.field}`, { value: validation.value })}
            </div>
          )}
          {customMissing && (
            <div className="task-launcher-block" data-kind="custom-command">
              {t("launcher.block.customCommand")}
            </div>
          )}
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

      <div className="task-launcher-preview" aria-live="polite">
        <span className="task-launcher-preview-label">{t("launcher.previewLabel")}</span>
        <code className="task-launcher-command" title={previewLine}>{previewLine}</code>
      </div>

      {recents.length > 0 && (
        <div className="task-launcher-recents">
          <span>{t("launcher.recent")}</span>
          {recents.map((r) => (
            <Button
              key={r}
              size="sm"
              className="task-launcher-recent"
              onClick={() => {
                setTask(r);
                taskRef.current?.focus();
              }}
            >
              {taskLabel(r, 32)}
            </Button>
          ))}
        </div>
      )}

      {launched.length > 0 && (
        <div className="task-launcher-launched" role="status" data-count={launched.length}>
          {t("launcher.launchedCount", { count: launched.length, last: launched[launched.length - 1].label })}
          {launched[launched.length - 1].queued && <span className="task-launcher-queued"> · {t("launcher.queued")}</span>}
        </div>
      )}

      <div className="task-launcher-footer">
        {onOpenAdvanced ? (
          <Button variant="quiet" className="task-launcher-advanced" onClick={onOpenAdvanced}>
            {t("launcher.advanced", { shortcut: shortcutLabel("file.new-session-advanced") })}
          </Button>
        ) : (
          <span />
        )}
        <div className="task-launcher-actions">
          {!inline && onClose && (
            <Button variant="quiet" className="task-launcher-cancel" onClick={() => close(false)}>
              {t("launcher.cancelEsc")}
            </Button>
          )}
          {!inline && (
            <Button className="task-launcher-launch-next" disabled={!canGo} onClick={() => void launch(true)}>
              {t("launcher.launchNext", { shortcut: fmt("{mod}⏎") })}
            </Button>
          )}
          {/* One primary per surface: in the welcome, its own Finish is the primary. */}
          <Button variant={inline ? "secondary" : "primary"} className="task-launcher-launch" disabled={!canGo} onClick={() => void launch(false)}>
            {launching ? t("launcher.launching") : t("launcher.launchEnter")}
          </Button>
        </div>
      </div>
    </div>
  );

  if (inline) return body;
  return (
    <div
      className="task-launcher-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("launcher.title")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(true);
      }}
    >
      <div className="task-launcher-sheet">{body}</div>
    </div>
  );
}
