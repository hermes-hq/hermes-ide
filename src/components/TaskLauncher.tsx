import "../styles/components/TaskLauncher.css";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { fmt, isActionMod, PLATFORM } from "../utils/platform";
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
  historyForm,
  presetNamed,
  rememberedForm,
  sameCombo,
  switchAgent,
  uniquePresetName,
  withoutDanger,
} from "../launcher/choice";
import {
  clearLauncherDraft,
  isDraftWorthKeeping,
  markOfferedThisSession,
  saveLauncherDraft,
  setPendingSuggestion,
  takeLauncherDraft,
  takePendingSuggestion,
  wasOfferedThisSession,
} from "../launcher/draft";
import { overlayOpened } from "../state/overlays";
import { clearLauncherSeed, peekLauncherSeed } from "../library/launcherSeed";
import { personaDelivery, systemPromptFlag, type LibraryLaunchPersona, type LibraryLaunchPick } from "../library/delivery";
import { useLibraryMessages } from "../library/messages";
import { worksTarget } from "../library/targets";
import { lazyView } from "../utils/lazyView";
import { useModalTabTrap } from "../hooks/useFocusTrap";
import {
  TASK_LAUNCHES_KEY,
  agentTakesFirstPrompt,
  autoTaskBranch,
  blockingRows,
  canLaunch,
  launchRoot,
  doneWhenFromToml,
  formatBytes,
  isAddedAccount,
  parseTaskLaunches,
  pickDefaultAgent,
  secondAgentBranch,
  shortTaskId,
  taskBranch,
  taskLabel,
  type BlockingRow,
  type TaskTrack,
} from "../launcher/taskLauncher";

/** Prompts (⌘J) in the launcher: loaded the first time it opens. */
const PromptPicker = lazyView("PromptPicker", () => import("./library/PromptPicker").then((m) => m.PromptPicker));

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
  /**
   * Library picks: the prompt the task text came from, and a persona every
   * agent gets (its system prompt where the CLI has a proven flag, else the
   * start of its first prompt; see src/library/delivery.ts).
   */
  library?: { prompt?: LibraryLaunchPick | null; persona?: LibraryLaunchPersona | null };
}

/** true: started; "queued": waits for a free slot (running-agents cap); false: failed. */
export type TaskLaunchResult = boolean | "queued";

export interface TaskLauncherProps {
  onLaunch: (req: TaskLaunchRequest) => Promise<TaskLaunchResult>;
  /**
   * Closes the sheet. `keepDraft`: closed without launching (Esc, Cancel, a
   * click outside); the draft comes back on ⌘N. False after a launch.
   */
  onClose?: (opts?: { keepDraft: boolean }) => void;
  /** "Start over": the restored draft is dropped and a fresh sheet opens. */
  onStartOver?: () => void;
  /** Opens the full creator (SSH, tmux). */
  onOpenAdvanced?: () => void;
  /**
   * Opens a terminal where the agent signs in: in the profile of `accountId`
   * when it is an account Hermes added, else the CLI's own default profile.
   */
  onSignIn: (agentId: string, accountId?: string | null) => void;
  /** Opens Settings > Agents (accounts and presets). */
  onManageAccounts?: () => void;
  /** The repository of the active session, when there is one. */
  defaultRepo: string | null;
  /** Rendered inside another screen (the welcome's last step) instead of as a sheet. */
  inline?: boolean;
  /** Test seam: the capability/usual/preset backend (the capability commands otherwise). */
  backend?: LauncherBackend;
  /** Changes when ⌘N is pressed again on the open sheet: the task field takes the keyboard back. */
  focusNonce?: number;
  /** Inline: the task text to start with (the welcome keeps it across its steps). */
  initialTask?: string;
  /** Inline: what the launcher can do now, for the screen around it. */
  controlRef?: React.MutableRefObject<TaskLauncherControl | null>;
  /** Inline: told each time the task text or whether Launch is possible changes. */
  onStateChange?: (state: { task: string; canLaunch: boolean }) => void;
}

/** What a screen embedding the inline launcher can ask of it. */
export interface TaskLauncherControl {
  /** Launches what is in the launcher now (as its Launch button). */
  launch(): Promise<void>;
  /** Keeps what is in the launcher as the ⌘N sheet's draft. */
  keepAsDraft(): void;
}

const PROBE_DELAY_MS = 200;
/** A model id to show as an example in the "type a model id" field, per agent. */
const MODEL_EXAMPLE: Record<string, string> = { claude: "claude-sonnet-4-5" };
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

export function TaskLauncher({
  onLaunch,
  onClose,
  onStartOver,
  onOpenAdvanced,
  onSignIn,
  onManageAccounts,
  defaultRepo,
  inline = false,
  backend: backendProp,
  focusNonce,
  initialTask,
  controlRef,
  onStateChange,
}: TaskLauncherProps) {
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
  // "Start a task with this" from the Library: read at mount, used up once the sheet is on screen.
  const [librarySeed] = useState(() => (inline ? null : peekLauncherSeed()));
  useEffect(() => {
    if (librarySeed) clearLauncherSeed(librarySeed);
  }, [librarySeed]);
  const [task, setTask] = useState(librarySeed?.task ?? initialTask ?? "");
  const [libPrompt, setLibPrompt] = useState<LibraryLaunchPick | null>(librarySeed?.prompt ?? null);
  const [libPersona, setLibPersona] = useState<LibraryLaunchPersona | null>(librarySeed?.persona ?? null);
  const [libPickerOpen, setLibPickerOpen] = useState(false);
  // ⌘J can arrive twice for one press (the menu key and the field's own keydown): one toggle per press.
  const lastPromptsToggle = useRef(0);
  const togglePrompts = useCallback(() => {
    const now = Date.now();
    if (now - lastPromptsToggle.current < 300) return;
    lastPromptsToggle.current = now;
    setLibPickerOpen((o) => !o);
  }, []);
  useEffect(() => {
    // ⌘J reaches the app as a menu key: with the launcher in front it opens (or closes) the launcher's Prompts.
    window.addEventListener("hermes:launcher-prompts", togglePrompts);
    return () => window.removeEventListener("hermes:launcher-prompts", togglePrompts);
  }, [togglePrompts]);
  const libraryReady = useLibraryMessages();
  const [choice, setChoice] = useState<LaunchChoice | null>(null);
  const [repoPath, setRepoPath] = useState(defaultRepo ?? "");
  const [probe, setProbe] = useState<{ path: string; result: RepoProbe } | null>(null);
  const [branch, setBranch] = useState("");
  const [branchEdited, setBranchEditedState] = useState(false);
  // Also read by the branch effect, which can run in the same flush as a
  // draft coming back (its closure would still see "not edited").
  const branchEditedRef = useRef(false);
  const setBranchEdited = useCallback((v: boolean) => {
    branchEditedRef.current = v;
    setBranchEditedState(v);
  }, []);
  const [checks, setChecks] = useState<string[]>([]);
  const [checksEdited, setChecksEditedState] = useState(false);
  // Also read by the checks effect: the repository's probe can land just
  // before a click on "+ add check", and that render's effect (its closure
  // still "not edited") would then replace the new check with the file's.
  const checksEditedRef = useRef(false);
  const setChecksEdited = useCallback((v: boolean) => {
    checksEditedRef.current = v;
    setChecksEditedState(v);
  }, []);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<Menu>(null);
  const [modePrefs, setModePrefs] = useState<SessionModeByProvider>({});
  const [viewMode, setViewMode] = useState<SessionMode>("terminal");
  const [caps, setCaps] = useState<Record<string, AgentCapabilities>>({});
  // An added account's own capabilities (its models, its refusals), by "agent\naccount".
  const [accountCaps, setAccountCaps] = useState<Record<string, AgentCapabilities>>({});
  // An agent whose sign-in is being checked again (Check again, back from a sign-in).
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [presets, setPresets] = useState<CheckedPreset[]>([]);
  // The preset form's answer when its name cannot be used (taken).
  const [presetError, setPresetError] = useState<string | null>(null);
  // A stored choice (a preset, the usual combination) on an account that is
  // signed out or gone: kept on that account, and Launch waits for a sign-in
  // or for "Use the default profile this time" (never swapped on its own).
  const [accountHold, setAccountHold] = useState<{ source: string; agentId: string; was: string; now: string | null; gone: boolean } | null>(null);
  // The project switched to usually runs another combination (the person had already changed this one).
  const [otherUsual, setOtherUsual] = useState<{ repo: string; choice: LaunchChoice } | null>(null);
  const [probeAgain, setProbeAgain] = useState(0);
  // The preset the person applied and the choice it gave: its chip stays the
  // selected one while the choice is that one, also after a fallback made it
  // equal to another preset. Any other change of the choice ends it.
  const [applied, setApplied] = useState<{ id: string; choice: LaunchChoice } | null>(null);
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
  // The sheet came back with the draft of an earlier one (it offers Start over).
  const [restored, setRestored] = useState(false);
  // The starting choice had Skip all (usual combination, last launch): replaced by the safety default.
  const [dangerDropped, setDangerDropped] = useState(false);
  // Without an active session the most used project is the starting one; the choice waits for it.
  const [projectsLoaded, setProjectsLoaded] = useState(!!defaultRepo);
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  // The modal overlay (the sheet and its backdrop): Tab stays inside it.
  const sheetWrapRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<Partial<Record<Exclude<Menu, null>, HTMLButtonElement | null>>>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const userTouched = useRef(false);
  // A launch (or Start over) ends the draft: closing then keeps nothing.
  const forgetDraft = useRef(false);
  // The Terminal / Agent view the draft had, kept while its agent is the chosen one.
  const viewFromDraft = useRef<{ agentId: string; mode: SessionMode } | null>(null);
  // Where the current choice came from ("usual" or a preset's name) until the person changes it.
  const choiceSource = useRef<string | null>(null);
  // The repository the usual combination was read for (a project switch reads the new one's).
  const usualFor = useRef<string | null>(null);
  const usualSeq = useRef(0);
  // An account picked by the person: its own models are checked once they are read.
  const accountPicked = useRef<string | null>(null);
  // The branch of a task with nothing to name it after: hermes/task-<id>, one id per sheet.
  const [fallbackId] = useState(() => shortTaskId());
  const latestTask = useRef(task);
  latestTask.current = task;

  /** The task field takes the keyboard (after the focused control went away). */
  const focusTask = useCallback(() => {
    requestAnimationFrame(() => taskRef.current?.focus());
  }, []);

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
  // When each agent's capabilities were last read afresh (Check again): an
  // answer from the cache that started before that never replaces them.
  const freshAt = useRef<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
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
      setCaps((prev) => {
        const out = { ...next };
        for (const [id, at] of Object.entries(freshAt.current)) if (at >= startedAt && prev[id]) out[id] = prev[id];
        return out;
      });
      setCapsErrors(errors);
      setCapsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [backend, agentIds, doctor.rows, capsAttempt]);

  /** The capabilities for an agent on an account: an added account's own once read, else the agent's. */
  const capsOf = useCallback(
    (agentId: string, accountId: string | null | undefined): AgentCapabilities | undefined =>
      (isAddedAccount(accountId) ? accountCaps[`${agentId}\n${accountId}`] : undefined) ?? caps[agentId],
    [caps, accountCaps],
  );

  /**
   * Check again: the doctor and the agent's capabilities read afresh (not
   * from the cache), so a sign-in that just happened in a terminal shows at
   * once. Also when the welcome comes back from a sign-in.
   */
  const recheck = useCallback(
    async (agentId: string, accountId?: string | null) => {
      setRechecking(agentId);
      try {
        const [, fresh, ofAccount] = await Promise.all([
          refreshDoctor(),
          backend.capabilities(agentId, null, true).catch(() => null),
          isAddedAccount(accountId) ? backend.capabilities(agentId, accountId, true).catch(() => null) : Promise.resolve(null),
        ]);
        if (fresh) {
          freshAt.current[agentId] = Date.now();
          setCaps((c) => ({ ...c, [agentId]: fresh }));
        }
        if (ofAccount && isAddedAccount(accountId)) setAccountCaps((c) => ({ ...c, [`${agentId}\n${accountId}`]: ofAccount }));
      } finally {
        setRechecking((cur) => (cur === agentId ? null : cur));
      }
    },
    [backend],
  );

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
    // A task started from the Library is a new intent: the old draft waits.
    const draft = inline || librarySeed ? null : takeLauncherDraft();
    if (draft) {
      setTask(draft.task);
      setChoice(draft.choice);
      repoPathRef.current = draft.repoPath;
      setRepoPath(draft.repoPath);
      setBranch(draft.branch);
      setBranchEdited(draft.branchEdited);
      setChecks(draft.checks);
      setChecksEdited(draft.checksEdited);
      setExpanded(draft.expanded);
      if (draft.viewMode) viewFromDraft.current = { agentId: draft.choice.agentId, mode: draft.viewMode };
      // The draft's choice is the person's own: a project switch only offers that project's usual.
      userTouched.current = true;
      usualFor.current = draft.repoPath.trim() || null;
      setRestored(true);
      setReadyState(true);
      return;
    }
    defaultAgentRef.current = () => pickDefaultAgent(lastUsed, agentIds.filter((id) => id !== "custom"), byIdRef.current) ?? agentIds[0];
    usualFor.current = repoPathRef.current.trim() || null;
    void backend
      .usual(usualFor.current)
      .catch(() => null)
      .then((usual) => {
        if (userTouched.current) return;
        if (usual && usual.source !== "catalog") {
          applyStored(usual, "usual", true);
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
      // The Settings default applies unless it is a dangerous mode (Skip all
      // needs the person's own choice, every time).
      if (defaultMode && c?.approvalModes.some((m) => m.id === defaultMode && !m.danger)) approval = defaultMode;
      const base = defaultChoice(agentId, c, approval);
      return { ...base, extraArgs: getAgent(agentId)?.custom ? "" : globalSuffix };
    },
    [caps, defaultMode, globalSuffix],
  );

  /**
   * A stored choice (the usual combination of a repository, a preset)
   * checked against what the agents can do now, as the launcher's choice.
   * `fromHistory`: the usual combination, which never starts in Skip all and
   * never on the current checkout (only a preset or a click does). An
   * account that is signed out or gone is not swapped for another: the
   * choice stays on it and Launch waits (accountHold).
   */
  const applyStored = (checked: { choice: LaunchChoice; issues: LauncherIssue[]; launchable: boolean }, source: string, fromHistory: boolean) => {
    let next = checked.choice;
    let dropped = false;
    if (fromHistory) {
      // Skip all is never picked for the person, not even as their usual.
      const safe = withoutDanger(historyForm(next), caps, (id) => freshChoice(id).approvalModeId);
      next = safe.choice;
      dropped = safe.dropped;
    }
    // An added account only: the CLI's own profile signed out is the usual "signed out" row.
    const held = checked.issues.find(
      (i) => i.field === "account" && !i.alsoOn && isAddedAccount(i.was) && (i.code.startsWith("accountSignedOut") || i.code.startsWith("accountGone")),
    );
    let issues = checked.issues;
    if (held?.was) {
      next = { ...next, accountId: held.was };
      issues = issues.filter((i) => i !== held);
      setAccountHold({ source, agentId: next.agentId, was: held.was, now: held.now, gone: held.code.startsWith("accountGone") });
    } else {
      setAccountHold(null);
    }
    choiceSource.current = source;
    setChoice(next);
    setDangerDropped(dropped);
    const launchable = checked.launchable || (!!held && !checked.issues.some((i) => i.field === "agent"));
    setFallbacks(issues.length || !launchable ? { source, list: issues, launchable } : null);
    return next;
  };

  /** "Claude Code · opus", "Claude Code · Work · opus": the agent, the account when it is an added one, and the model, as the chips say them. */
  const defaultPresetName = useCallback(
    (c: LaunchChoice) => {
      const agent = getAgent(c.agentId)?.name ?? c.agentId;
      const model = c.modelId === "default" ? t("launcher.modelDefault") : c.modelId;
      const account = isAddedAccount(c.accountId) ? (caps[c.agentId]?.accounts.find((a) => a.id === c.accountId)?.label ?? c.accountId) : null;
      return account ? `${agent} · ${account} · ${model}` : `${agent} · ${model}`;
    },
    [t, caps],
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
    const fromDraft = viewFromDraft.current;
    if (fromDraft && fromDraft.agentId === choice?.agentId) {
      setViewMode(fromDraft.mode);
      return;
    }
    viewFromDraft.current = null;
    setViewMode(preferredSessionMode(modePrefs, choice?.agentId ?? null));
  }, [choice?.agentId, modePrefs]);

  // The branch follows the task until the person types their own, skipping
  // names the repository already has (the same task again gets -2, -3…).
  // Set below, once the repository's branches are known.

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
    // probeAgain: after a launch that stays open, the branch it made is taken now.
  }, [repoPath, probeAgain]);

  const probed = probe && probe.path === repoPath.trim() ? probe.result : null;
  const gitRoot = repoPath.trim() ? (probed ? probed.git_root : undefined) : undefined;
  const localBranches = useMemo(() => probed?.local_branches ?? [], [probed]);
  const branchSet = useMemo(() => new Set(localBranches), [localBranches]);
  const currentBranch = probed?.current_branch ?? "";
  const doneWhen = useMemo(() => doneWhenFromToml(probed?.worktree_toml), [probed]);
  // What is at the path: missing, a file, a repository without a commit (older backends say nothing).
  const folder = useMemo(
    () => (probed ? { exists: probed.exists !== false, isDir: probed.is_dir !== false, hasCommits: probed.has_commits !== false } : null),
    [probed],
  );
  // "~/code/app" read as the folder it names, shown under the typed path.
  const resolvedPath = probed?.resolved && probed.resolved !== repoPath.trim() ? probed.resolved : null;
  // A folder that is not a git repository: the agent works directly in it
  // (no worktree, no branch). Where the launch runs: the repository's main
  // checkout, or that folder.
  const plainFolder = gitRoot === null && !!folder && folder.exists && folder.isDir;
  const root = launchRoot(gitRoot, folder, probed?.resolved || repoPath.trim());
  useEffect(() => {
    if (!checksEditedRef.current) setChecks(doneWhen.commands);
  }, [doneWhen, checksEdited]);

  useEffect(() => {
    if (branchEdited || branchEditedRef.current) return;
    // A library prompt's text opens with markup ("<context>"): its title names the branch.
    const auto = autoTaskBranch(libPrompt?.title || task, localBranches, fallbackId);
    setBranch((cur) => (branchEditedRef.current ? cur : auto));
  }, [task, libPrompt, branchEdited, localBranches, fallbackId]);

  // Another project: its usual combination, when the person has not made
  // this one their own; when they have, the launcher only says what the
  // project usually runs, with a way to use that.
  const choiceRef = useRef(choice);
  choiceRef.current = choice;
  useEffect(() => {
    if (!ready || !gitRoot) return;
    if (usualFor.current && samePath(usualFor.current, gitRoot)) return;
    usualFor.current = gitRoot;
    const seq = ++usualSeq.current;
    setOtherUsual(null);
    void backend
      .usual(gitRoot)
      .catch(() => null)
      .then((usual) => {
        if (seq !== usualSeq.current || !usual || usual.source !== "repo") return;
        const current = choiceRef.current;
        if (!userTouched.current) {
          applyStored(usual, "usual", true);
          return;
        }
        if (current && !sameCombo(historyForm(usual.choice), historyForm(current))) setOtherUsual({ repo: baseName(gitRoot), choice: usual.choice });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitRoot, ready, backend]);

  // An added account's own capabilities (its models can differ from the
  // default profile's: a model refused on one account works on another).
  const accountKeys = useMemo(() => {
    const keys: string[] = [];
    if (choice && isAddedAccount(choice.accountId)) keys.push(`${choice.agentId}\n${choice.accountId}`);
    if (choice?.alsoOn && isAddedAccount(choice.alsoOn.accountId)) keys.push(`${choice.alsoOn.agentId}\n${choice.alsoOn.accountId}`);
    return keys;
  }, [choice]);
  useEffect(() => {
    let cancelled = false;
    for (const key of accountKeys) {
      if (accountCaps[key]) continue;
      const [agentId, accountId] = key.split("\n");
      void backend
        .capabilities(agentId, accountId)
        .then((c) => {
          if (!cancelled) setAccountCaps((cur) => ({ ...cur, [key]: c }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [accountKeys, accountCaps, backend]);

  // The person picked an account: its own models, checked as soon as they are known.
  useEffect(() => {
    const key = accountPicked.current;
    if (!key || !choice || `${choice.agentId}\n${choice.accountId}` !== key) return;
    const c = accountCaps[key];
    if (!c) return;
    accountPicked.current = null;
    const checked = reconcileChoice({ ...choice, alsoOn: undefined }, c, null);
    const changed = checked.issues.filter((i) => i.field === "model" || i.field === "effort");
    if (changed.length === 0) return;
    setChoice((cur) => (cur ? { ...cur, modelId: checked.choice.modelId, effort: checked.choice.effort } : cur));
    setFallbacks({ source: "account", list: changed, launchable: true });
  }, [accountCaps, choice]);

  // A new worktree cut from a branch this repository does not have (a
  // preset or the usual combination from another repository, a draft, a
  // project switched afterwards) would fail to start: it is cut from the
  // current branch instead, and the launcher says so.
  useEffect(() => {
    if (!choice || choice.where.kind !== "new-worktree" || !choice.where.baseBranch || !probed || !gitRoot) return;
    if (branchSet.has(choice.where.baseBranch)) return;
    const was = choice.where.baseBranch;
    const next: LaunchChoice = { ...choice, where: { ...choice.where, baseBranch: "" } };
    setChoice(next);
    setApplied((a) => (a && a.choice === choice ? { ...a, choice: next } : a));
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
    if (patch.approvalModeId !== undefined) setDangerDropped(false);
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
        // What was last launched with it, but never Skip all by itself.
        const safe = withoutDanger({ ...last.choice, alsoOn: undefined }, caps, (id) => freshChoice(id).approvalModeId);
        if (safe.dropped) setDangerDropped(true);
        setChoice((cur) => (cur && cur.agentId === agentId ? switchAgent(cur, agentId, safe.choice) : cur));
      });
  };
  const pickModel = (modelId: string) => {
    if (!choice) return;
    const efforts = effortsFor(capsOf(choice.agentId, choice.accountId), modelId);
    update({ modelId, effort: choice.effort && efforts.includes(choice.effort) ? choice.effort : null });
  };
  const pickAccount = (accountId: string) => {
    if (!choice) return;
    update({ accountId });
    setAccountHold(null);
    accountPicked.current = isAddedAccount(accountId) ? `${choice.agentId}\n${accountId}` : null;
  };

  const applyPreset = (preset: CheckedPreset) => {
    userTouched.current = true;
    setOtherUsual(null);
    // Checked again against what the agents can do now.
    const presetCaps = caps[preset.choice.agentId];
    const checked = presetCaps
      ? reconcileChoice(preset.choice, presetCaps, preset.choice.alsoOn ? caps[preset.choice.alsoOn.agentId] ?? null : null)
      : { choice: preset.effective, issues: preset.issues, launchable: preset.launchable };
    const next = applyStored(checked, preset.name, false);
    setApplied({ id: preset.id, choice: next });
    setMenu(null);
    focusTask();
  };

  // ── derived ─────────────────────────────────────────────────────
  const agentCaps = choice ? capsOf(choice.agentId, choice.accountId) : undefined;
  const isCustom = !!choice && getAgent(choice.agentId)?.custom === true;
  const where: LaunchChoice["where"] = useMemo(() => choice?.where ?? { kind: "new-worktree", baseBranch: "", branch: "" }, [choice?.where]);

  const plannedAgents = useMemo<PlannedAgent[]>(() => {
    if (!effective) return [];
    const mk = (c: LaunchChoice, br: string, mode: SessionMode): PlannedAgent => {
      // Not a git repository: no worktree and no branch, the folder itself.
      const w: LaunchChoice["where"] = plainFolder ? { kind: "current-checkout" } : c.where;
      return {
        id: c.agentId,
        mode,
        branch: w.kind === "new-worktree" ? br : w.kind === "existing-branch" ? w.branch : "",
        createBranch: w.kind === "new-worktree",
        baseBranch: w.kind === "new-worktree" ? w.baseBranch : "",
        worktree: w.kind !== "current-checkout",
        launch: backend.sessionLaunch(c, capsOf(c.agentId, c.accountId)),
        choice: c,
      };
    };
    const mainBranch = branch.trim();
    const withBranch = (c: LaunchChoice): LaunchChoice => (c.where.kind === "new-worktree" ? { ...c, where: { ...c.where, branch: mainBranch } } : c);
    const main = withBranch(effective);
    const list = [mk(main, mainBranch, hasAgentView(effective.agentId) ? viewMode : "terminal")];
    if (effective.alsoOn) {
      // The second agent always gets its own new branch (two agents never share a checkout).
      const alsoBranch = secondAgentBranch(where.kind === "existing-branch" ? where.branch : mainBranch || taskBranch(task, fallbackId), effective.alsoOn.agentId);
      const also: LaunchChoice = { ...effective.alsoOn, where: { kind: "new-worktree", baseBranch: where.kind === "new-worktree" ? where.baseBranch : where.kind === "existing-branch" ? where.branch : "", branch: alsoBranch } };
      list.push(mk(also, alsoBranch, "terminal"));
    }
    return list;
  }, [effective, branch, viewMode, capsOf, where, task, backend, fallbackId, plainFolder]);

  /** Whether the account an agent runs on is signed in, as the capability backend says (undefined: not known). */
  const accountSignedIn = useCallback(
    (agentId: string, accountId: string | null | undefined): boolean | undefined => capsOf(agentId, accountId)?.accounts.find((x) => x.id === accountId)?.signedIn,
    [capsOf],
  );
  // A held account (see accountHold) that still cannot run: its own row says so and Launch waits.
  const holdActive =
    !!accountHold &&
    !!choice &&
    choice.agentId === accountHold.agentId &&
    choice.accountId === accountHold.was &&
    (accountHold.gone || accountSignedIn(choice.agentId, choice.accountId) === false || !capsOf(choice.agentId, choice.accountId)?.accounts.some((x) => x.id === accountHold.was));

  const rows = useMemo(() => {
    const judged = (a: PlannedAgent) => ({ id: a.id, branch: a.branch, accountId: a.choice.accountId, accountSignedIn: accountSignedIn(a.id, a.choice.accountId) });
    const all = blockingRows({
      agents: plannedAgents.filter((a) => a.createBranch).map(judged),
      doctor: byId,
      repoPath,
      gitRoot,
      branches: localBranches,
      disk: disk ? { freeBytes: disk.free_bytes, requiredBytes: disk.required_bytes, belowThreshold: disk.below_threshold } : null,
      folder,
    });
    // Agents that do not create a branch are still judged for install / sign-in.
    const extra = blockingRows({
      agents: plannedAgents.filter((a) => !a.createBranch).map((a) => ({ ...judged(a), branch: "" })),
      doctor: byId,
      repoPath: "x",
      gitRoot: null,
      branches: [],
      disk: null,
    }).filter((r) => r.kind === "not-installed" || r.kind === "signed-out");
    const out: BlockingRow[] = [...all, ...extra.filter((r) => r.kind !== "not-installed" || getAgent(r.agentId)?.custom !== true)];
    if (where.kind === "existing-branch" && gitRoot && !branchSet.has(where.branch)) out.push({ kind: "bad-branch", branch: where.branch });
    const newWorktree = plannedAgents.some((a) => a.worktree);
    return out.filter(
      (r) =>
        !(r.kind === "not-installed" && getAgent(r.agentId)?.custom) &&
        (r.kind !== "low-disk" || newWorktree) &&
        // The held account's own row (below) says it, with what to do.
        !(holdActive && r.kind === "signed-out" && r.agentId === accountHold?.agentId && r.accountId === accountHold?.was),
    );
  }, [plannedAgents, byId, repoPath, gitRoot, branchSet, localBranches, disk, where, folder, accountSignedIn, holdActive, accountHold]);

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
      const v = validateChoice(a.choice, capsOf(a.id, a.choice.accountId));
      // A held account that is gone has its own row.
      if (!v.ok && holdActive && v.field === "account" && a.id === accountHold?.agentId) continue;
      if (!v.ok) return { field: v.field, value: v.message };
    }
    return null;
  }, [plannedAgents, capsOf, holdActive, accountHold]);
  // A stored choice that could not be made launchable is judged live by the
  // rows above (agent missing, account signed out), with today's answers.
  const canGo =
    !!choice && ready && canLaunch(task.trim() || (libPersona?.title ?? ""), root, rows) && plannedAgents.length > 0 && !launching && !customMissing && !validation && !capsError && !staleBase && !holdActive;
  // Why Launch is not possible, for the Launch button's description.
  const blocked = rows.length > 0 || holdActive || !!validation || customMissing || !!capsError || failed;

  useEffect(() => {
    if (!effective) return;
    let cancelled = false;
    const place = plainFolder
      ? t("launcher.previewFolder", { folder: baseName(root ?? repoPath) || "—" })
      : where.kind === "new-worktree"
        ? t("launcher.previewWorktree", { branch: branch.trim() || taskBranch(task, fallbackId), base: where.baseBranch || currentBranch || "HEAD" })
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
  }, [effective, backend, task, where, branch, currentBranch, repoPath, t, fallbackId, plainFolder, root]);
  const previewLine = previewLineState;
  // The launch adds a pointer to the session's project context after the
  // task (an agent that takes the task on its command line): said, not hidden.
  const contextNote = !!task.trim() && plannedAgents.some((a) => a.mode === "terminal" && agentTakesFirstPrompt(a.id));

  // ── actions ─────────────────────────────────────────────────────
  // The draft is kept whenever the sheet goes away without a launch: Esc,
  // Cancel, a click outside, another overlay, or the app closing it because
  // Settings or a sign-in opened from here. Read when the sheet unmounts.
  const draftNow = useRef<() => void>(() => {});
  draftNow.current = () => {
    if (inline || forgetDraft.current || !choice) return;
    if (!isDraftWorthKeeping({ task, touched: userTouched.current, expanded, branchEdited, checksEdited, restored })) return;
    saveLauncherDraft({ task, choice, repoPath, branch, branchEdited, checks, checksEdited, expanded, viewMode });
  };
  useEffect(() => () => draftNow.current(), []);

  const close = useCallback(() => onClose?.({ keepDraft: true }), [onClose]);

  const startOver = useCallback(() => {
    forgetDraft.current = true;
    clearLauncherDraft();
    onStartOver?.();
  }, [onStartOver]);

  // One overlay at a time: the sheet closes (keeping what was typed) when the
  // inbox or the palette opens, and opening it closes them (state/overlays.ts).
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (inline) return;
    return overlayOpened("launcher", () => closeRef.current());
  }, [inline]);

  const launch = useCallback(
    async (next: boolean) => {
      if (!canGo || !effective || !root) return;
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
          repoRoot: root,
          agents: plannedAgents,
          track: effective.trackAsFeature ? "Full" : "Quick",
          doneWhen: checks.map((c) => c.trim()).filter(Boolean),
          choice: plannedAgents[0].choice,
          ...(next || inline ? { staysOpen: true } : {}),
          ...(libPrompt || libPersona ? { library: { prompt: libPrompt, persona: libPersona } } : {}),
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
        ({ suggestPreset: offer, count } = await backend.remember(remembered, root));
      } catch (err) {
        console.warn("[TaskLauncher] could not record the launch:", err);
      }
      clearLauncherDraft();
      // Launched: closing the sheet now keeps no draft (Launch & next starts
      // a new one with the next task).
      forgetDraft.current = !next;
      setRestored(false);
      // Asked once per app session; never again only after "No, don't ask again" (or once it is a preset).
      if (offer && !wasOfferedThisSession(remembered)) {
        markOfferedThisSession(remembered);
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
        setLaunched((l) => [...l, { label: taskLabel(libPrompt?.title || trimmed), queued: result === "queued" }]);
        // What was typed while the launch ran is the next task: only the launched text is cleared.
        if (latestTask.current.trim() === trimmed) {
          setTask((cur) => (cur.trim() === trimmed ? "" : cur));
          setBranchEdited(false);
        }
        // The branch it made is taken now: the next one is named past it.
        setProbeAgain((n) => n + 1);
        focusTask();
        return;
      }
      onClose?.({ keepDraft: false });
    },
    [canGo, effective, root, plannedAgents, modePrefs, task, onLaunch, checks, backend, presets, inline, onClose, defaultPresetName, focusTask, setBranchEdited, libPrompt, libPersona],
  );

  /**
   * Saves a preset. A name another preset already has (letter case ignored)
   * is refused with a message; true when it was saved.
   */
  const savePreset = useCallback(
    async (name: string, c: LaunchChoice): Promise<boolean> => {
      const clean = name.trim();
      if (!clean) return false;
      const taken = presetNamed(clean, presets);
      if (taken) {
        setPresetError(t("launcher.presetNameTaken", { name: taken.name }));
        return false;
      }
      try {
        const preset = await backend.savePreset(clean, c);
        setPresets((list) => [...list, preset]);
        setPresetError(null);
        return true;
      } catch (err) {
        console.warn("[TaskLauncher] could not save the preset:", err);
        setPresetError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [backend, presets, t],
  );

  /** The "Save as preset…" form: saved, it closes and the task field takes the keyboard back. */
  const submitPresetForm = async () => {
    if (saving === null || !effective || !saving.trim()) return;
    if (await savePreset(saving, rememberedForm(effective))) {
      setSaving(null);
      focusTask();
    }
  };
  const cancelPresetForm = () => {
    setSaving(null);
    setPresetError(null);
    focusTask();
  };
  /** "Save it as a preset?": saved under the name typed (nothing happens without one). */
  const submitSuggestion = async () => {
    if (!suggest || !suggestName.trim()) return;
    if (await savePreset(suggestName, suggest)) {
      setSuggest(null);
      focusTask();
    }
  };
  /** "No, don't ask again": the one answer that stops the offer for good. */
  const dismissSuggestion = () => {
    if (suggest && gitRoot) void backend.dismissSuggestion(suggest, gitRoot).catch(() => {});
    setSuggest(null);
    setPresetError(null);
    focusTask();
  };

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
  /** Esc in a menu: it closes and its chip has the keyboard again. */
  const closeMenu = useCallback(() => {
    const m = menu;
    setMenu(null);
    if (m) requestAnimationFrame(() => chipRefs.current[m]?.focus());
  }, [menu]);
  /** A value picked in a menu: it closes and the task field has the keyboard (the next Enter launches). */
  const pickDone = useCallback(() => {
    setMenu(null);
    focusTask();
  }, [focusTask]);

  const onSheetKey = (e: React.KeyboardEvent) => {
    const mod = PLATFORM === "mac" ? e.metaKey : e.ctrlKey;
    const target = e.target as HTMLElement;
    const inField = target.tagName === "TEXTAREA" || target.tagName === "INPUT";
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      if (saving !== null) cancelPresetForm();
      else if (menu) closeMenu();
      else if (!inline) close();
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
      pickDone();
    }
  };

  // While the sheet is open, a key that reaches the page itself (the
  // focused control went away) still works: Esc closes the sheet, any other
  // key gives the task field the keyboard back. ⌘N on the open sheet does too.
  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (e.defaultPrevented || (active && active !== document.body && active !== document.documentElement)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key === "Shift" || e.key === "Meta" || e.key === "Control" || e.key === "Alt") return;
      if (e.key === "Tab") e.preventDefault();
      taskRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inline]);
  useEffect(() => {
    if (focusNonce) focusTask();
  }, [focusNonce, focusTask]);

  useModalTabTrap(sheetWrapRef, !inline);

  // The screen around an inline launcher (the welcome) has its own Launch.
  if (controlRef) {
    controlRef.current = {
      launch: () => launch(false),
      keepAsDraft: () => {
        if (choice) saveLauncherDraft({ task, choice, repoPath, branch, branchEdited, checks, checksEdited, expanded, viewMode });
      },
    };
  }
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    onStateChangeRef.current?.({ task, canLaunch: canGo });
  }, [task, canGo]);

  const copyInstall = (id: string) => {
    const cmd = installCommand(getAgent(id));
    if (!cmd) return;
    navigator.clipboard.writeText(cmd).then(() => setCopied(id)).catch(console.error);
  };

  const agentName = (id: string) => byId[id]?.name ?? getAgent(id)?.name ?? id;
  /**
   * An account as people know it: its label; the CLI's own profile is
   * "default profile", or what it signs in with when that is the only
   * account it can have ("Google account").
   */
  const accountLabel = (c: AgentCapabilities | undefined, id: string | null) => {
    const a = c?.accounts.find((x) => x.id === id);
    if (!a && isAddedAccount(id)) return id;
    if (!a || a.id === "default") {
      if (a && c && !c.canAddAccount && a.detail && a.signedIn) return a.detail;
      return t("launcher.accountDefault");
    }
    return a.label;
  };
  /** The label of an account of an agent, by id (an added account that is gone: its id). */
  const accountName = (agentId: string, id: string | null) => accountLabel(capsOf(agentId, id) ?? caps[agentId], id);
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
    if (row.signed_in === "no") {
      // The doctor checks the default profile only: an added account may be signed in.
      const signedIn = (caps[id]?.accounts ?? []).filter((a) => isAddedAccount(a.id) && a.signedIn).map((a) => a.label);
      if (signedIn.length > 0) return t("launcher.agentNoteDefaultOut", { accounts: signedIn.join(", ") });
      return t("launcher.agentNoteSignedOut");
    }
    return row.version ? t("launcher.agentNoteInstalled", { version: row.version }) : t("launcher.agentNoteInstalledNoVersion");
  };
  const fallbackText = (f: LauncherIssue) => {
    const agentId = (f.alsoOn ? choice?.alsoOn?.agentId : choice?.agentId) ?? "";
    // Approval modes by their names ("Plan first"), models "default" as the chip says it, accounts by their labels.
    const name = (v: string | null) => {
      if (v === null) return f.field === "effort" ? t("launcher.effortDefault") : "—";
      if (f.field === "approval" && choice) return approvalLabel(agentId || choice.agentId, v);
      if (f.field === "model" && v === "default") return t("launcher.modelDefault");
      if (f.field === "account") return accountName(agentId, v);
      return v;
    };
    let text: string;
    if (f.field === "account" && f.now !== null && f.code.startsWith("accountSignedOut")) {
      text = t("launcher.fallbackAccountSignedOut", { account: name(f.was), using: name(f.now) });
    } else {
      text =
        f.now === null
          ? t(`launcher.fallbackGone.${f.field}`, { from: name(f.was) })
          : t(`launcher.fallback.${f.field}`, { from: name(f.was), to: name(f.now) });
    }
    // About a preset's second agent: said so.
    return f.alsoOn ? t("agentsSettings.issue.alsoOn", { issue: text }) : text;
  };

  /** Sign in for an agent: in its added account's own profile when that is the one signed out. */
  const signInFor = (agentId: string, accountId?: string | null) => onSignIn(agentId, isAddedAccount(accountId) ? accountId : null);
  const checkAgain = (agentId: string, accountId?: string | null) => void recheck(agentId, accountId);

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
      case "signed-out": {
        const account = isAddedAccount(row.accountId) ? accountName(row.agentId, row.accountId) : null;
        const checking = rechecking === row.agentId;
        return (
          <div className="task-launcher-block" data-kind={row.kind} data-agent-id={row.agentId} data-account-id={row.accountId ?? "default"} key={key}>
            <span>
              {account ? t("launcher.block.accountSignedOut", { account, agent: agentName(row.agentId) }) : t("launcher.block.signedOut", { agent: agentName(row.agentId) })}
            </span>
            <Button variant="link" className="task-launcher-link task-launcher-sign-in" onClick={() => signInFor(row.agentId, row.accountId)}>
              {account ? t("launcher.signInTo", { account }) : t("launcher.signIn")}
            </Button>
            <Button variant="link" className="task-launcher-link task-launcher-recheck" onClick={() => checkAgain(row.agentId, row.accountId)} disabled={checking || doctor.loading}>
              {checking ? t("launcher.checkingSignIn") : t("doctor.recheck")}
            </Button>
          </div>
        );
      }
      case "no-repo":
        return (
          <div className="task-launcher-block" data-kind={row.kind} key={key}>
            {t("launcher.block.noRepo")}
          </div>
        );
      case "not-git":
        return (
          <div className="task-launcher-block" data-kind={row.kind} data-missing={row.missing} key={key}>
            {row.missing === "missing" ? t("launcher.block.noFolder") : t("launcher.block.notAFolder")}
          </div>
        );
      case "no-commits":
        return (
          <div className="task-launcher-block" data-kind={row.kind} key={key}>
            <span>{t("launcher.block.noCommits")}</span>
            <Button variant="link" className="task-launcher-link task-launcher-use-current" onClick={() => setWhere("current-checkout")}>
              {t("launcher.useCurrentCheckout")}
            </Button>
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
            {row.branch === branch.trim() && row.suggestion && (
              <Button
                variant="link"
                className="task-launcher-link task-launcher-use-branch"
                data-branch={row.suggestion}
                onClick={() => {
                  if (!row.suggestion) return;
                  setBranch(row.suggestion);
                  setBranchEdited(true);
                  focusTask();
                }}
              >
                {t("launcher.useBranch", { branch: row.suggestion })}
              </Button>
            )}
            {row.branch === branch.trim() && row.clash !== "folder" && (
              <Button
                variant="link"
                className="task-launcher-link task-launcher-use-existing"
                onClick={() => {
                  update({ where: { kind: "existing-branch", branch: row.existing } });
                  focusTask();
                }}
              >
                {t("launcher.useExisting", { branch: row.existing })}
              </Button>
            )}
          </div>
        );
      case "bad-branch": {
        const p = row.problem;
        const text = !p
          ? t("launcher.block.badBranch", { branch: row.branch || "—" })
          : p.kind === "folder"
            ? t("launcher.block.branchIsFolder", { branch: row.branch, existing: p.existing })
            : p.kind === "under-branch"
              ? t("launcher.block.branchUnderBranch", { branch: row.branch, existing: p.existing })
              : p.kind === "dot-part"
                ? t("launcher.block.branchDotPart")
                : p.kind === "lock-part"
                  ? t("launcher.block.branchLockPart")
                  : t("launcher.block.branchTooLong", { max: p.max });
        return (
          <div className="task-launcher-block" data-kind={row.kind} data-problem={p?.kind} key={key}>
            {text}
          </div>
        );
      }
      case "low-disk":
        return (
          <div className="task-launcher-block" data-kind={row.kind} key={key}>
            {t("launcher.block.lowDisk", { free: formatBytes(row.freeBytes), required: formatBytes(row.requiredBytes) })}
          </div>
        );
    }
  };

  /** A chip of the row under the task: it opens its menu below the row. */
  const menuChip = (m: Exclude<Menu, null>, label: ReactNode, opts: { danger?: boolean; off?: boolean; title?: string } = {}) => (
    <Chip
      expands
      selected={menu === m}
      onToggle={() => openMenu(m)}
      disabled={opts.off}
      tone={opts.danger ? "danger" : "neutral"}
      buttonRef={(el) => {
        chipRefs.current[m] = el;
      }}
      buttonAttrs={{ className: cx("task-launcher-chip", menu === m && "open", opts.danger && "danger", opts.off && "off"), "data-chip": m, title: opts.title }}
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
      ? t("launcher.whereChipWorktree", { branch: branch.trim() || taskBranch(task, fallbackId) })
      : where.kind === "existing-branch"
        ? t("launcher.whereChipExisting", { branch: where.branch || "—" })
        : t("launcher.whereChipCurrent", { branch: currentBranch || "HEAD" });
  // The task runs in the project folder itself: said, in the danger colour.
  const unisolated = !!choice && where.kind === "current-checkout" && !plainFolder;

  /** A pick in an open chip menu closes it (see pickDone); the same control in + options leaves things be. */
  const pickedInMenu = () => {
    if (menu) pickDone();
  };
  const setWhere = (kind: WhereKind) => {
    if (kind === "new-worktree") update({ where: { kind, baseBranch: where.kind === "new-worktree" ? where.baseBranch : "", branch: "" } });
    else if (kind === "existing-branch") update({ where: { kind, branch: where.kind === "existing-branch" ? where.branch : localBranches.find((b) => b !== currentBranch) ?? localBranches[0] ?? "" } });
    else update({ where: { kind } });
    // An existing branch is picked next, in the same menu.
    if (kind !== "existing-branch") pickedInMenu();
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
            onChange={(v) => {
              update({ where: { kind: "new-worktree", baseBranch: v, branch: "" } });
              pickedInMenu();
            }}
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
            onChange={(v) => {
              update({ where: { kind: "existing-branch", branch: v } });
              pickedInMenu();
            }}
          />
        </div>
      )}
    </div>
  );

  const approvalBlock = choice && agentCaps && (
    <div className="task-launcher-approval" data-danger={danger ? "true" : "false"}>
      <div className="task-launcher-approval-modes" role="group" aria-label={t("launcher.approvalLabel")}>
        {agentCaps.approvalModes.map((m) =>
          optionChip(
            m.id,
            m.id === choice.approvalModeId,
            () => {
              update({ approvalModeId: m.id });
              pickedInMenu();
            },
            approvalLabel(choice.agentId, m.id),
            { "data-mode": m.id },
            { danger: !!m.danger },
          ),
        )}
      </div>
      <div className={`task-launcher-approval-note${danger ? " danger" : ""}`}>{approvalNote(choice.agentId, choice.approvalModeId)}</div>
      {agentCaps.approvalModes.some((m) => m.id === "plan") && (
        <div className="task-launcher-muted task-launcher-plan-hint">{t("launcher.planModeHint", { agent: agentName(choice.agentId), plan: approvalLabel(choice.agentId, "plan") })}</div>
      )}
      <div className="task-launcher-muted">
        {t("launcher.approvalRemembered", { agent: agentName(choice.agentId), account: accountLabel(agentCaps, choice.accountId) })}
        {" · "}
        <code>{selectedMode?.flag.length ? selectedMode.flag.join(" ") : t("launcher.noFlag")}</code>
      </div>
    </div>
  );

  const alsoSelects = (also: LaunchChoice) => {
    const c = capsOf(also.agentId, also.accountId);
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
  const appliedIndex = applied && applied.choice === choice ? presets.findIndex((p) => p.id === applied.id) : -1;
  const presetIndex =
    appliedIndex >= 0 ? appliedIndex : effective ? presets.findIndex((p) => sameCombo(rememberedForm(p.choice), rememberedForm(effective))) : -1;
  // Saving a combination a preset already is: said ("Same as ⌘2 Plan first").
  const sameAsIndex = saving !== null && effective ? presets.findIndex((p) => sameCombo(rememberedForm(p.choice), rememberedForm(effective))) : -1;
  const sameAsPreset = sameAsIndex >= 0 ? { preset: presets[sameAsIndex], index: sameAsIndex } : null;
  /** "Claude Code · Plan first", "Codex CLI · Read only · gpt-5": a combination in a few words. */
  const comboSummary = (c: LaunchChoice) => {
    const parts = [agentName(c.agentId)];
    if (isAddedAccount(c.accountId)) parts.push(accountName(c.agentId, c.accountId));
    parts.push(approvalLabel(c.agentId, c.approvalModeId));
    if (c.modelId !== "default") parts.push(c.modelId);
    return parts.join(" · ");
  };
  // The held account's row: what is wrong, and the two ways forward.
  const holdRow = holdActive && accountHold && choice && (
    <div className="task-launcher-block" data-kind="account-held" data-agent-id={accountHold.agentId} data-account-id={accountHold.was} key="account-held">
      <span>
        {(() => {
          const account = accountName(accountHold.agentId, accountHold.was);
          const fromPreset = accountHold.source !== "usual";
          if (accountHold.gone) {
            return fromPreset
              ? t("launcher.block.presetAccountGone", { name: accountHold.source, account })
              : t("launcher.block.usualAccountGone", { account });
          }
          return fromPreset
            ? t("launcher.block.presetAccountSignedOut", { name: accountHold.source, account })
            : t("launcher.block.usualAccountSignedOut", { account });
        })()}
      </span>
      {!accountHold.gone && (
        <Button variant="link" className="task-launcher-link task-launcher-sign-in" onClick={() => signInFor(accountHold.agentId, accountHold.was)}>
          {t("launcher.signInTo", { account: accountName(accountHold.agentId, accountHold.was) })}
        </Button>
      )}
      <Button
        variant="link"
        className="task-launcher-link task-launcher-use-default"
        onClick={() => {
          pickAccount(accountHold.now ?? "default");
          focusTask();
        }}
      >
        {accountHold.now && isAddedAccount(accountHold.now)
          ? t("launcher.useAccountThisTime", { account: accountName(accountHold.agentId, accountHold.now) })
          : t("launcher.useDefaultThisTime")}
      </Button>
      {!accountHold.gone && (
        <Button
          variant="link"
          className="task-launcher-link task-launcher-recheck"
          onClick={() => checkAgain(accountHold.agentId, accountHold.was)}
          disabled={rechecking === accountHold.agentId}
        >
          {rechecking === accountHold.agentId ? t("launcher.checkingSignIn") : t("doctor.recheck")}
        </Button>
      )}
    </div>
  );

  const body = (
    <div className={`task-launcher${inline ? " task-launcher-inline" : ""}`} ref={sheetRef} onKeyDown={onSheetKey} data-ready={ready && choice ? "true" : "false"}>
      {!inline && (
        <div className="task-launcher-header">
          <span className="task-launcher-title">{t("launcher.title")}</span>
          <span className="task-launcher-subtitle">{t("launcher.subtitle")}</span>
          <span className="task-launcher-spacer" />
          <span className="task-launcher-keyhint">{shortcutLabel("file.new-session")}</span>
          {onClose && <CloseButton className="task-launcher-close" label={t("launcher.close")} onClick={close} />}
        </div>
      )}

      {restored && !inline && (
        <div className="task-launcher-restored" role="status">
          <span>{t("launcher.draftRestored")}</span>
          <Button variant="link" className="task-launcher-link task-launcher-start-over" onClick={startOver}>
            {t("launcher.startOver")}
          </Button>
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
            onClick={() => {
              setPresetError(null);
              setSaving(choice ? uniquePresetName(defaultPresetName(choice), presets) : "");
            }}
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
              aria-invalid={presetError ? true : undefined}
              aria-describedby={presetError ? "task-launcher-preset-error" : undefined}
              value={saving}
              autoFocus
              onChange={(e) => {
                setSaving(e.target.value);
                setPresetError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.stopPropagation();
                  void submitPresetForm();
                }
              }}
            />
            <Button size="sm" className="task-launcher-preset-save" disabled={!saving.trim()} onClick={() => void submitPresetForm()}>
              {t("launcher.presetSave")}
            </Button>
            <Button variant="quiet" size="sm" className="task-launcher-preset-cancel" onClick={cancelPresetForm}>
              {t("launcher.cancel")}
            </Button>
            {sameAsPreset && (
              <span className="task-launcher-muted task-launcher-preset-same" data-preset-id={sameAsPreset.preset.id}>
                {sameAsPreset.index < PRESET_SHORTCUTS
                  ? t("launcher.presetSameAsKey", { key: fmt(`{mod}${sameAsPreset.index + 1}`), name: sameAsPreset.preset.name })
                  : t("launcher.presetSameAs", { name: sameAsPreset.preset.name })}
              </span>
            )}
          </span>
        )}
        {presetError && (saving !== null || !!suggest) && (
          <span id="task-launcher-preset-error" className="task-launcher-preset-error" role="alert">
            {presetError}
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
            onChange={(e) => {
              setSuggestName(e.target.value);
              setPresetError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.stopPropagation();
                // An empty name saves nothing and keeps the offer (as the disabled Save does).
                void submitSuggestion();
              }
            }}
          />
          <Button size="sm" className="task-launcher-suggest-save" disabled={!suggestName.trim()} onClick={() => void submitSuggestion()}>
            {t("launcher.presetSave")}
          </Button>
          <Button variant="quiet" size="sm" className="task-launcher-suggest-dismiss" onClick={dismissSuggestion}>
            {t("launcher.suggestDismiss")}
          </Button>
        </div>
      )}

      {otherUsual && (
        <div className="task-launcher-note task-launcher-other-usual" role="status">
          <span>{t("launcher.otherUsual", { repo: otherUsual.repo, combo: comboSummary(otherUsual.choice) })}</span>
          <Button
            variant="link"
            className="task-launcher-link task-launcher-use-usual"
            onClick={() => {
              const usual = otherUsual.choice;
              setOtherUsual(null);
              const agentCapsNow = caps[usual.agentId];
              applyStored(
                agentCapsNow ? reconcileChoice(usual, agentCapsNow, usual.alsoOn ? caps[usual.alsoOn.agentId] ?? null : null) : { choice: usual, issues: [], launchable: true },
                "usual",
                true,
              );
              focusTask();
            }}
          >
            {t("launcher.useIt")}
          </Button>
        </div>
      )}

      {fallbacks && (
        <div className="task-launcher-fallback" role="alert" data-source={fallbacks.source}>
          <span>
            {fallbacks.source === "usual"
              ? t("launcher.fallbackUsual")
              : fallbacks.source === "repo"
                ? t("launcher.fallbackRepo")
                : fallbacks.source === "account"
                  ? t("launcher.fallbackAccount", { account: choice ? accountName(choice.agentId, choice.accountId) : "" })
                  : t("launcher.fallbackPreset", { name: fallbacks.source })}
          </span>
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
        onChange={(e) => {
          setTask(e.target.value);
          if (!e.target.value.trim()) setLibPrompt(null);
        }}
        onKeyDown={(e) => {
          // ⌘J / Ctrl+J: the Library, filtered to the agents of this launch.
          if (isActionMod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j" && libraryReady) {
            e.preventDefault();
            togglePrompts();
          }
        }}
      />

      {libraryReady && (
        <div className="task-launcher-library" data-testid="launcher-library">
          <Button size="sm" variant="quiet" className="task-launcher-from-library" aria-expanded={libPickerOpen} aria-haspopup="dialog" onClick={togglePrompts}>
            {t("library.launcher.fromLibrary", { shortcut: fmt("{mod}J") })}
          </Button>
          {libPrompt && (
            <Chip size="sm" className="task-launcher-library-prompt" onRemove={() => setLibPrompt(null)} removeLabel={t("library.launcher.remove")}>
              {t("library.launcher.promptChip", { title: libPrompt.title, version: libPrompt.version })}
            </Chip>
          )}
          {libPersona && (
            <Chip size="sm" className="task-launcher-library-persona" onRemove={() => setLibPersona(null)} removeLabel={t("library.launcher.remove")}>
              {t("library.launcher.personaChip", { title: libPersona.title })}
            </Chip>
          )}
        </div>
      )}
      {libraryReady && libPersona && (
        <div className="task-launcher-library-how" data-testid="launcher-persona-how">
          <span className="task-launcher-library-how-title">{t("library.launcher.howTitle")}</span>
          {plannedAgents.map((a) => {
            const how = personaDelivery(a.id, a.mode);
            const name = agentName(a.id);
            return (
              <span key={`${a.id}-${a.mode}`} data-agent={a.id} data-delivery={how}>
                {how === "system"
                  ? t("library.launcher.howSystem", { agent: name, flag: systemPromptFlag(a.id) ?? "" })
                  : how === "first-message"
                    ? t("library.launcher.howFirst", { agent: name })
                    : t("library.launcher.howClipboard", { agent: name })}
              </span>
            );
          })}
        </div>
      )}

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
          {menuChip("project", repoPath.trim() ? baseName(repoPath) : t("launcher.projectNone"), { danger: !!repoPath.trim() && gitRoot === null && !plainFolder })}
          {!plainFolder && menuChip("where", whereChipText, { danger: unisolated })}
          {!isCustom &&
            menuChip("approval", approvalLabel(choice.agentId, choice.approvalModeId), {
              danger,
              title: t("launcher.approvalChipTitle", { mode: approvalLabel(choice.agentId, choice.approvalModeId), note: approvalNote(choice.agentId, choice.approvalModeId) }),
            })}
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

      {choice && danger && (
        <div className="task-launcher-danger-warning" role="note" data-mode={choice.approvalModeId}>
          {t("launcher.dangerWarning", { mode: approvalLabel(choice.agentId, choice.approvalModeId), agent: agentName(choice.agentId) })}
          {choice.trackAsFeature && ` ${t("launcher.dangerWarningTrack")}`}
        </div>
      )}
      {choice && !danger && dangerDropped && (
        <div className="task-launcher-muted task-launcher-danger-dropped" role="note">
          {t("launcher.dangerNotCarried", { mode: approvalLabel(choice.agentId, "bypassPermissions") })}
        </div>
      )}
      {unisolated && (
        <div className="task-launcher-danger-warning task-launcher-unisolated" role="note">
          {t("launcher.unisolatedNote", { branch: currentBranch || "HEAD" })}
        </div>
      )}
      {choice && plainFolder && (
        <div className="task-launcher-muted task-launcher-plain-folder" role="note">
          {t("folder.notGitHint")}
        </div>
      )}

      {choice && menu && (
        <div className="task-launcher-menu" data-menu={menu} ref={menuRef} onKeyDown={onMenuKeys} role="group" aria-label={t(`launcher.menu.${menu}`)}>
          {menu === "agent" && (
            <>
              <div className="task-launcher-menu-items">
                {agents.map((a) =>
                  optionChip(
                    a.id,
                    a.id === choice.agentId,
                    () => {
                      pickAgent(a.id);
                      pickDone();
                    },
                    a.name,
                    { "data-agent-id": a.id },
                    { note: agentNote(a.id) },
                  ),
                )}
              </div>
              <div className="task-launcher-menu-caption">{t("launcher.accountFor", { agent: agentName(choice.agentId) })}</div>
              <div className="task-launcher-menu-items">
                {(caps[choice.agentId]?.accounts ?? agentCaps?.accounts ?? []).map((a) =>
                  optionChip(
                    a.id,
                    a.id === choice.accountId,
                    () => {
                      pickAccount(a.id);
                      pickDone();
                    },
                    accountLabel(caps[choice.agentId] ?? agentCaps, a.id),
                    { "data-account-id": a.id },
                    { note: (a.id === "default" && !caps[choice.agentId]?.canAddAccount ? "" : a.detail) || (a.signedIn ? t("launcher.accountSignedIn") : t("launcher.accountSignedOut")) },
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
                      pickDone();
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
              {/* Enter here confirms the folder (it never launches): the menu closes, the task field has the keyboard. */}
              <span className="task-launcher-repo-field" data-own-enter="true">
                <Input
                  id="task-launcher-repo"
                  code
                  className="task-launcher-repo"
                  value={repoPath}
                  spellCheck={false}
                  placeholder={t("launcher.repoPlaceholder")}
                  aria-describedby={resolvedPath || (repoPath.trim() && gitRoot === null) ? "task-launcher-repo-state" : undefined}
                  onChange={(e) => setRepoPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
                      e.preventDefault();
                      e.stopPropagation();
                      pickDone();
                    }
                  }}
                />
              </span>
              {(resolvedPath || (repoPath.trim() && gitRoot === null)) && (
                <div id="task-launcher-repo-state" className="task-launcher-muted task-launcher-repo-state" role="status">
                  {resolvedPath ? t("launcher.repoResolved", { path: resolvedPath }) : null}
                  {resolvedPath && gitRoot === null ? " · " : null}
                  {gitRoot === null
                    ? folder && !folder.exists
                      ? t("launcher.block.noFolder")
                      : folder && !folder.isDir
                        ? t("launcher.block.notAFolder")
                        : t("folder.notGitHint")
                    : null}
                </div>
              )}
            </>
          )}
          {menu === "where" && !plainFolder && whereBlock}
          {menu === "approval" && approvalBlock}
          {menu === "model" && agentCaps && (
            <>
              <div className="task-launcher-menu-items">
                {agentCaps.models.map((m) => {
                  // A refusal is said in the person's language (the backend's
                  // reason is English).
                  const refused = m.unavailableCode === "refused";
                  const why = refused
                    ? t(m.id === "default" ? "launcher.modelDefaultRefused" : "launcher.modelRefused")
                    : m.unavailableReason;
                  return optionChip(
                    m.id,
                    m.id === choice.modelId,
                    () => {
                      pickModel(m.id);
                      pickDone();
                    },
                    m.id === "default" ? t("launcher.modelDefault") : m.label,
                    { "data-model-id": m.id, title: why },
                    {
                      disabled: !m.available,
                      note: !m.available
                        ? why || t("launcher.modelUnavailable")
                        : m.id === "default"
                          ? why || t("launcher.modelDefaultNote")
                          : m.efforts.length === 0
                            ? t("launcher.modelNoEffort")
                            : m.note || "",
                    },
                  );
                })}
              </div>
              {(agentCaps.modelSource === "free-text" || agentCaps.acceptsTypedModel) && (
                // Any model id the agent takes (a pinned version, a long-context variant); Enter confirms it.
                <span className="task-launcher-model-field" data-own-enter="true">
                  <Input
                    size="sm"
                    code
                    className="task-launcher-model-text"
                    aria-label={t("launcher.modelTypedLabel")}
                    placeholder={MODEL_EXAMPLE[choice.agentId] ? t("launcher.modelTypedExample", { example: MODEL_EXAMPLE[choice.agentId] }) : t("launcher.modelTyped")}
                    value={choice.modelId === "default" || agentCaps.models.some((m) => m.id === choice.modelId) ? "" : choice.modelId}
                    spellCheck={false}
                    onChange={(e) => update({ modelId: e.target.value.trim() || "default", effort: null })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        pickDone();
                      }
                    }}
                  />
                </span>
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
                    pickDone();
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
                      pickDone();
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
          {/* Not a git repository: no worktree or branch to choose (the hint above says so). */}
          {!plainFolder && (
            <div className="task-launcher-opt-row">
              <span className="task-launcher-opt-label">{t("launcher.whereLabel")}</span>
              {whereBlock}
            </div>
          )}
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
            <span className="task-launcher-opt-label">{t("launcher.featureTrackLabel")}</span>
            <Checkbox
              className="task-launcher-feature"
              inputClassName="task-launcher-feature-box"
              checked={choice.trackAsFeature}
              onChange={(on) => update({ trackAsFeature: on })}
              label={t("launcher.trackAsFeature")}
              description={`${t("launcher.trackAsFeatureNote", { slug: taskBranch(task).replace(/^hermes\//, "") })} ${t("launcher.trackNotPlanMode", { agent: agentName(choice.agentId), plan: approvalLabel(choice.agentId, "plan") })}`}
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
              {choice.alsoOn && <span className="task-launcher-muted">{plainFolder ? t("launcher.alsoNoteFolder") : t("launcher.alsoNote", { branch: plannedAgents[1]?.branch ?? "" })}</span>}
            </div>
          )}
        </div>
      )}

      <div className="task-launcher-preview" aria-live="polite">
        <span className="task-launcher-preview-label">{t("launcher.previewLabel")}</span>
        <span className="task-launcher-preview-line">
          <code className="task-launcher-command" title={previewLine}>{previewLine}</code>
          {contextNote && (
            <span className="task-launcher-context-note" title={t("launcher.contextNoteTitle")}>
              {t("launcher.contextNote")}
            </span>
          )}
        </span>
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

      {/* What stops Launch stays next to it, in view however far the sheet scrolls. */}
      <div className="task-launcher-dock">
      {(rows.length > 0 || holdActive || noFirstPrompt.length > 0 || failed || validation || customMissing || capsError || (doctor.loading && !doctor.rows)) && (
        <div className="task-launcher-rows" id="task-launcher-blocks">
          {doctor.loading && !doctor.rows && <div className="task-launcher-note">{t("doctor.checking")}</div>}
          {holdRow}
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

      {!(inline && controlRef) && (
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
              <Button variant="quiet" className="task-launcher-cancel" onClick={close}>
                {t("launcher.cancelEsc")}
              </Button>
            )}
            {!inline && (
              <Button
                className="task-launcher-launch-next"
                disabled={!canGo}
                aria-describedby={!canGo && blocked ? "task-launcher-blocks" : undefined}
                onClick={() => void launch(true)}
              >
                {t("launcher.launchNext", { shortcut: fmt("{mod}⏎") })}
              </Button>
            )}
            {/* One primary per surface: in the welcome, its own Finish is the primary. */}
            <Button
              variant={inline ? "secondary" : "primary"}
              className="task-launcher-launch"
              disabled={!canGo}
              aria-describedby={!canGo && blocked ? "task-launcher-blocks" : undefined}
              onClick={() => void launch(false)}
            >
              {launching ? t("launcher.launching") : t("launcher.launchEnter")}
            </Button>
          </div>
        </div>
      )}
      </div>
    </div>
  );

  // Prompts (⌘J) takes the sheet's place in the same overlay: one surface, and the launch keeps everything set.
  const prompts =
    libraryReady && libPickerOpen ? (
      <Suspense fallback={null}>
        <PromptPicker
          context="launcher"
          embedded={!inline}
          works={[...new Set(plannedAgents.map((a) => worksTarget(a.id)))]}
          prefill={task.trim() && !libPrompt ? task : ""}
          projectPath={repoPath || null}
          libraryContext={{ projectPath: repoPath || null }}
          onClose={() => {
            setLibPickerOpen(false);
            focusTask();
          }}
          onUse={(pick) => {
            if (pick.kind === "persona") {
              setLibPersona({ id: pick.id, version: pick.version, title: pick.title, text: pick.text });
            } else {
              setTask(pick.text);
              setLibPrompt({ id: pick.id, version: pick.version, title: pick.title });
              if (pick.persona) setLibPersona(pick.persona);
            }
            setLibPickerOpen(false);
            focusTask();
          }}
        />
      </Suspense>
    ) : null;

  if (inline) return (
    <>
      {body}
      {prompts}
    </>
  );
  return (
    <div
      ref={sheetWrapRef}
      className="task-launcher-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("launcher.title")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          if (libPickerOpen) setLibPickerOpen(false);
          else close();
        }
      }}
    >
      <div className="task-launcher-sheet" hidden={!!prompts}>
        {body}
      </div>
      {prompts}
    </div>
  );
}
