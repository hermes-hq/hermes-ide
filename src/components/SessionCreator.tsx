import "../styles/components/SessionCreator.css";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useResizablePanel } from "../hooks/useResizablePanel";
import { open } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { CreateSessionOpts } from "../state/SessionContext";
import { getProjectsOrdered, createProject, deleteProject } from "../api/projects";
import type { ProjectOrdered } from "../types/project";
import { getSessions, sshListTmuxSessions, checkAiProviders } from "../api/sessions";
import {
  AI_AGENT_PREFIXES_KEY,
  PREFIX_EXAMPLES,
  parseAgentPrefixes,
  getPrefixPlaceholder,
} from "../utils/aiProviders";
import {
  CUSTOM_AGENT_ID,
  buildLaunchPreview,
  customAgent,
  getAgent,
  getAvailableModes,
  installCommand,
  listAgents,
  launchPermissionMode,
  permissionFlagText,
  sanitizeCommandFragment,
} from "../catalog/agentCatalog";
import { isSafetyDefaultEnabled, safetyDefaultMode } from "../catalog/agentSafety";
import { PLATFORM } from "../utils/platform";
import { getSetting, setSetting } from "../api/settings";
import { LAST_AI_PROVIDER_KEY, resolveDefaultAiProvider } from "../utils/lastAiProvider";
import {
  SESSION_MODE_BY_PROVIDER_KEY,
  hasAgentView,
  parseSessionModeByProvider,
  preferredSessionMode,
  rememberSessionMode,
  type SessionModeByProvider,
} from "../utils/sessionModePref";
import { listSshSavedHosts, upsertSshSavedHost, type SshSavedHost } from "../api/ssh";
import type { PermissionMode, SessionMode, TmuxSessionEntry } from "../types/session";
import { isGitRepo as checkIsGitRepo } from "../api/git";
import { LANG_COLORS } from "../utils/langColors";
import { SessionBranchSelector, type BranchDraft } from "./SessionBranchSelector";
import { isFeatureFlagEnabled } from "../featureFlags";
import { randomTaskSlug } from "../state/isolation";
import { SESSION_COLORS } from "./SessionList";
import { useI18n } from "../i18n/I18nProvider";
import { rememberUserLabel } from "../attention/userLabels";
import { Badge, Button, Checkbox, Chip, CloseButton, IconButton, Input, Radio } from "./ui";
import { cx } from "./ui/Button";
import { CloseGlyph } from "./ui/icons";

// ─── SSH Connection History ──────────────────────────────────────────

export interface SshHistoryEntry {
  host: string;
  user: string;
  port: number;
  lastUsed: string;
}

const SSH_HISTORY_KEY = "ssh_connection_history";
const SSH_HISTORY_MAX = 10;

export function parseSshHistory(json: string): SshHistoryEntry[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function addToSshHistory(
  existing: SshHistoryEntry[],
  entry: SshHistoryEntry,
  maxEntries = SSH_HISTORY_MAX,
): SshHistoryEntry[] {
  const filtered = existing.filter(
    (e) => !(e.host === entry.host && e.user === entry.user && e.port === entry.port),
  );
  return [entry, ...filtered].slice(0, maxEntries);
}

export const CLAUDE_CHANNELS = [
  { id: "plugin:telegram@claude-plugins-official", label: "Telegram", icon: "\u{1F4F1}" },
] as const;

/** How the new session runs.  "terminal" (the default) runs the agent in its
 *  own terminal interface; "agent" is the optional Agent view for agents that
 *  have one (Claude); "ssh" connects to a remote machine. */
export type SessionCreatorMode = "agent" | "terminal" | "ssh";

// Internal step identifiers (not displayed to user).
//
// Terminal first (ADR 003): every flow starts on the agent step ("ai"), where
// the user picks an agent or a plain shell.  An agent that has an Agent view
// shows an opt-in checkbox there, and a link switches to SSH.  After that:
//  - mode="terminal" | "agent" → projects → branch (if any) → confirm
//  - mode="ssh"                → ssh → tmux → confirm
type Step = "projects" | "branch" | "ai" | "tmux" | "ssh" | "confirm";

interface SessionCreatorProps {
  onClose: () => void;
  onCreate: (opts: CreateSessionOpts) => Promise<void>;
  /** Pre-select a project group when creating from a project's "+" button */
  defaultGroup?: string;
  /** Test/integration hook — start the modal already on a chosen mode.
   *  "agent" opens on the folder step with Claude's Agent view chosen,
   *  "ssh" opens on the SSH form, "terminal" (the default) on the agent step. */
  initialMode?: SessionCreatorMode;
  /** Called once on first paint so the parent can dismiss its
   *  "opening…" placeholder.  Without this, a heavy first-mount makes
   *  the modal feel stuck after Cmd+N / button click. */
  onReady?: () => void;
}

export function SessionCreator({ onClose, onCreate, defaultGroup, initialMode, onReady }: SessionCreatorProps) {
  const { t } = useI18n();
  const permissionShortLabel = (mode: PermissionMode) => t(`permission.${mode}.shortLabel`);
  const permissionDescription = (mode: PermissionMode) => t(`permission.${mode}.description`);
  // Diagnostic — logs every time React calls the function component
  // body.  Combined with the App.tsx click timestamp, lets us see
  // how long elapses between click and first-render-start.
  console.log(`[opening-overlay] SessionCreator render() at ${performance.now().toFixed(0)}ms`);
  // Session mode.  Drives every conditional below.  Terminal first: every
  // agent opens in its own terminal interface unless the user opts into the
  // Agent view (ADR 003).
  const [mode, setMode] = useState<SessionCreatorMode>(initialMode ?? "terminal");
  const [step, setStep] = useState<Step>(initialMode === "ssh" ? "ssh" : initialMode === "agent" ? "projects" : "ai");
  // Per-agent remembered Terminal / Agent view choice (session_mode_by_provider).
  const [modePrefs, setModePrefs] = useState<SessionModeByProvider>({});
  const [modePrefsLoaded, setModePrefsLoaded] = useState(false);

  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  // The agent the session runs.  The Agent view forces "claude"; for ssh
  // mode it's irrelevant (the session mode is "terminal").
  const [aiProvider, setAiProvider] = useState<string | null>(initialMode === "agent" ? "claude" : null);
  // Pre-selection default for terminal-mode (issue #3). Loaded async from
  // the persisted setting; applied once on the first transition into
  // terminal mode via `defaultProviderAppliedRef`. Stays null if the user
  // never picked a provider before, or if the saved provider is no longer
  // in the registry (silent fall-through is the right UX — better than
  // surfacing a dead selection the user has to clear).
  const [defaultAiProvider, setDefaultAiProvider] = useState<string | null>(null);
  const [defaultAiProviderLoaded, setDefaultAiProviderLoaded] = useState(false);
  const defaultProviderAppliedRef = useRef(false);
  // The local choice (agent + Terminal / Agent view) in place when the user
  // opened the SSH form, so Back from it restores that choice.
  const beforeSshRef = useRef<{ mode: SessionCreatorMode; aiProvider: string | null }>({ mode: "terminal", aiProvider: null });
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [allProjects, setAllProjects] = useState<ProjectOrdered[]>([]);
  const [query, setQuery] = useState("");
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [highlightedProviderIndex, setHighlightedProviderIndex] = useState(0);
  const [providerAvailability, setProviderAvailability] = useState<Record<string, boolean>>({});
  const [availabilityLoaded, setAvailabilityLoaded] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const aiStepRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  const { panelWidth, panelHeight, onResizeWidthStart, onResizeHeightStart, handleOverlayClick } = useResizablePanel({
    defaultWidth: 480,
    defaultHeight: 620,
    minWidth: 380,
    minHeight: 360,
    maxWidthRatio: 0.92,
    maxHeightRatio: 0.78,
    widthKey: "session_creator_panel_width",
    heightKey: "session_creator_panel_height",
  });

  // Project (group) assignment state
  const [selectedGroup, setSelectedGroup] = useState<string | null>(defaultGroup ?? null);
  const [newProjectName, setNewProjectName] = useState("");
  const [showNewProjectInput, setShowNewProjectInput] = useState(false);

  // SSH-specific state
  const [sshHost, setSshHost] = useState("");
  const [sshUser, setSshUser] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshHistory, setSshHistory] = useState<SshHistoryEntry[]>([]);
  const [sshSavedHosts, setSshSavedHosts] = useState<SshSavedHost[]>([]);
  const [sshIdentityFile, setSshIdentityFile] = useState("");
  const [sshJumpHost, setSshJumpHost] = useState("");
  const [saveAsHost, setSaveAsHost] = useState(false);
  const [saveHostLabel, setSaveHostLabel] = useState("");

  // Tmux session discovery state
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionEntry[]>([]);
  const [tmuxLoading, setTmuxLoading] = useState(false);
  const [tmuxError, setTmuxError] = useState<string | null>(null);
  const [selectedTmuxSession, setSelectedTmuxSession] = useState<string | null>(null);
  const [tmuxAvailable, setTmuxAvailable] = useState(true);
  const [newTmuxSessionName, setNewTmuxSessionName] = useState("");
  const [showNewTmuxInput, setShowNewTmuxInput] = useState(false);

  // Color selection — no color by default
  const [selectedColor, setSelectedColor] = useState<string>("");

  // Permission/agent-launch knobs (terminal mode only).
  const [autoApprove, setAutoApprove] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  // F35: with the 2.0 catalog on, each agent starts in its mapping of
  // Hermes's one safety default, unless the user picked a mode (a pill, or
  // the default mode saved in Settings).
  const safetyDefaultOn = isSafetyDefaultEnabled();
  const userPickedModeRef = useRef(false);
  const [customSuffix, setCustomSuffix] = useState("");
  // Custom agent (any command): the name shown for the session and the command typed to start it.
  const [customAgentName, setCustomAgentName] = useState("");
  const [customAgentCommand, setCustomAgentCommand] = useState("");
  const [agentPrefixDefaults, setAgentPrefixDefaults] = useState<Record<string, string>>({});
  const [customPrefix, setCustomPrefix] = useState("");

  // Channel plugins state (Claude only — visible in both agent & terminal-claude paths)
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);

  // Branch isolation — per-project
  type BranchSelection = { branch: string; createNew: boolean; fromRemote?: string };
  const [gitProjectIds, setGitProjectIds] = useState<string[]>([]);
  const [checkingGit, setCheckingGit] = useState(false);
  // The selection the git check last answered for (see gitCheckPending).
  const [gitCheckedFor, setGitCheckedFor] = useState<readonly string[] | null>(null);
  const [branchSelections, setBranchSelections] = useState<Record<string, BranchSelection>>({});
  // A name typed in the open "New branch" form; Continue commits it.
  const [branchDraft, setBranchDraft] = useState<(BranchDraft & { projectId: string }) | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  // Honest isolation: one slug per task, so every project of this task
  // defaults to the same hermes/<slug> branch.
  const [defaultTaskSlug] = useState<string | undefined>(() =>
    isFeatureFlagEnabled("honestIsolation") ? randomTaskSlug() : undefined,
  );

  // Resolve session-mode that gets persisted to the session.  The Agent view
  // is Claude-only; ssh always = terminal.
  const resolvedSessionMode: SessionMode = mode === "agent" ? "agent" : "terminal";

  const isShellOnly = mode === "terminal" && aiProvider === null;

  // Notify parent of first paint so its "opening…" placeholder
  // dismisses (M9 — Cmd+N / new-session-button immediate feedback).
  useEffect(() => {
    console.log(`[opening-overlay] SessionCreator first useEffect (mounted) at ${performance.now().toFixed(0)}ms`);
    onReady?.();
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-expand first git project only when first entering the branch step
  const prevStepRef = useRef(step);
  useEffect(() => {
    if (step === "branch" && prevStepRef.current !== "branch" && gitProjectIds.length > 0) {
      const firstGit = selectedProjectIds.find((id) => gitProjectIds.includes(id));
      if (firstGit) setExpandedProjectId(firstGit);
    }
    prevStepRef.current = step;
  }, [step, gitProjectIds, selectedProjectIds]);

  // Auto-advance to the next unselected git project when branchSelections changes
  useEffect(() => {
    if (step !== 'branch') return;
    const nextUnselected = selectedProjectIds.find(
      (id) => gitProjectIds.includes(id) && !branchSelections[id]
    );
    if (nextUnselected) {
      setExpandedProjectId(nextUnselected);
    } else if (Object.keys(branchSelections).length > 0 && selectedProjectIds.every(
      (id) => !gitProjectIds.includes(id) || branchSelections[id]
    )) {
      setExpandedProjectId(null);
    }
  }, [branchSelections, step, selectedProjectIds, gitProjectIds]);

  const showBranchStep = gitProjectIds.length > 0 && selectedProjectIds.length > 0;

  // Existing project groups (from current sessions) with their colors
  const [existingGroups, setExistingGroups] = useState<string[]>([]);
  const [groupColors, setGroupColors] = useState<Record<string, string>>({});

  // Compute ordered steps for the progress dots & footer nav.
  const orderedSteps = useMemo<Step[]>(() => {
    if (mode === "ssh") {
      // SSH path: host → tmux → confirm.  The agent step stays in front so
      // Back returns to it.
      return ["ai", "ssh", "tmux", "confirm"];
    }
    // Local path (terminal or Agent view): agent picker → folder picker →
    // (branch) → confirm.
    const steps: Step[] = ["ai", "projects"];
    if (showBranchStep) steps.push("branch");
    steps.push("confirm");
    return steps;
  }, [mode, showBranchStep]);

  // Truncate project selection when switching to Shell Only (terminal mode)
  useEffect(() => {
    if (isShellOnly && selectedProjectIds.length > 1) {
      setSelectedProjectIds((prev) => prev.slice(0, 1));
    }
  }, [isShellOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // When mode changes, force aiProvider to "claude" for the Agent view.
  // Terminal-only knobs (permission, prefix, flags) are kept as they are:
  // they are hidden and ignored while the Agent view is chosen, and come
  // back unchanged if the user unticks it.
  useEffect(() => {
    if (mode === "agent") {
      setAiProvider("claude");
    }
    if (mode === "ssh") {
      setAiProvider(null);
      setSelectedChannels([]);
    }
  }, [mode]);

  // Rehydrate the prefix input from per-agent default when the provider
  // changes.  Only relevant in terminal mode.
  useEffect(() => {
    if (mode !== "terminal") return;
    if (aiProvider) {
      setCustomPrefix(agentPrefixDefaults[aiProvider] ?? "");
    } else {
      setCustomPrefix("");
    }
  }, [aiProvider, agentPrefixDefaults, mode]);

  const totalSteps = orderedSteps.length;
  const currentStepNumber = Math.max(orderedSteps.indexOf(step) + 1, 1);

  const goNext = useCallback(() => {
    const idx = orderedSteps.indexOf(step);
    if (idx < orderedSteps.length - 1) {
      setStep(orderedSteps[idx + 1]);
    }
  }, [step, orderedSteps]);

  const goBack = useCallback(() => {
    const idx = orderedSteps.indexOf(step);
    if (idx > 0) {
      const prev = orderedSteps[idx - 1];
      // Leaving the SSH form for the agent step returns to the local session
      // the user had picked before opening it (agent and Terminal / Agent view).
      if (prev === "ai" && mode === "ssh") {
        const before = beforeSshRef.current;
        setMode(before.mode);
        setAiProvider(before.aiProvider);
      }
      setStep(prev);
    }
  }, [step, orderedSteps, mode]);

  // PERF: Mount-time loads — keep ONLY the work that's needed for the
  // first interactive frame. Everything mode-specific or step-specific
  // is deferred to its own effect below. Without this split, the modal
  // mounts and the DB mutex serialises 8 simultaneous IPC calls (one
  // of which spawns child processes via checkAiProviders), making the
  // open feel laggy even though the React mount itself is sub-50ms.
  useEffect(() => {
    getProjectsOrdered()
      .then((r) => setAllProjects(r))
      .catch((err) => console.warn("[SessionCreator] Failed to load projects:", err));
    // Settings: 3 small key/value lookups. Cheap (~ms each) and the
    // values are needed for permission/prefix/suffix UI. Keep at mount.
    getSetting("default_permission_mode")
      .then((val) => {
        if (val) {
          userPickedModeRef.current = true;
          setPermissionMode(val as PermissionMode);
        }
      })
      .catch(() => {});
    getSetting("custom_command_suffix")
      .then((val) => { if (val) setCustomSuffix(val); })
      .catch(() => {});
    getSetting(AI_AGENT_PREFIXES_KEY)
      .then((val) => {
        const map = parseAgentPrefixes(val);
        setAgentPrefixDefaults(map);
      })
      .catch(() => {});
    // If the parent passed a defaultGroup, we need getSessions() up-front
    // to look up that group's colour. Otherwise the existingGroups +
    // groupColors UI doesn't appear until the user reaches a non-mode
    // step, so we defer the load below.
    if (defaultGroup) {
      loadSessionsForGroups(defaultGroup);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // PERF: AI-provider availability check spawns one child process per
  // configured provider (via `which claude` etc.) — typically the slowest
  // load on mount. Only matters on the agent step (not for SSH).
  useEffect(() => {
    if (mode === "ssh" || availabilityLoaded) return;
    checkAiProviders()
      .then((r) => { setProviderAvailability(r); setAvailabilityLoaded(true); })
      .catch((err) => {
        console.warn("[SessionCreator] Failed to check AI providers:", err);
        setAvailabilityLoaded(true);
      });
  }, [mode, availabilityLoaded]);

  // PERF: SSH-related state is only used inside the SSH step. Defer
  // both the history setting + the saved-hosts table query until the
  // user actually picks SSH mode. Saves two IPC round-trips at mount
  // for every non-SSH session creation (the common case).
  const sshLoadedRef = useRef(false);
  useEffect(() => {
    if (mode !== "ssh" || sshLoadedRef.current) return;
    sshLoadedRef.current = true;
    getSetting(SSH_HISTORY_KEY)
      .then((json) => setSshHistory(parseSshHistory(json)))
      .catch((err) => console.warn("[SessionCreator] Failed to load SSH history:", err));
    listSshSavedHosts()
      .then(setSshSavedHosts)
      .catch((err) => console.warn("[SessionCreator] Failed to load saved SSH hosts:", err));
  }, [mode]);

  // PERF: getSessions() can return a large list (every session ever).
  // It's only used to derive `existingGroups` + `groupColors`, which
  // appear on the projects/confirm step. Defer until the user advances
  // past the agent step (or load eagerly above when defaultGroup
  // is set).
  const sessionsLoadedRef = useRef(false);
  useEffect(() => {
    if (sessionsLoadedRef.current) return;
    if (step === "ai" && !defaultGroup) return; // wait for advance
    sessionsLoadedRef.current = true;
    loadSessionsForGroups(defaultGroup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /** Shared by the eager (mount-with-defaultGroup) and lazy (post-agent-step)
   *  load paths above. Pulled out so both call sites stay in sync. */
  function loadSessionsForGroups(defaultGroupArg: string | undefined) {
    getSessions()
      .then((sessions) => {
        const groups = [...new Set(sessions.map((s) => s.group).filter((g): g is string => !!g))].sort();
        setExistingGroups(groups);
        const colors: Record<string, string> = {};
        for (const g of groups) {
          const groupSession = sessions.find((s) => s.group === g && s.phase !== "destroyed")
            || sessions.find((s) => s.group === g);
          if (groupSession) colors[g] = groupSession.color;
        }
        setGroupColors(colors);
        if (defaultGroupArg && colors[defaultGroupArg]) {
          setSelectedColor(colors[defaultGroupArg]);
        }
      })
      .catch((err) => console.warn("[SessionCreator] Failed to load sessions:", err));
  }

  // Discover tmux sessions on entering the tmux step.
  useEffect(() => {
    if (step !== "tmux" || !sshHost.trim()) return;
    setTmuxLoading(true);
    setTmuxError(null);
    setTmuxAvailable(true);
    sshListTmuxSessions(sshHost.trim(), parseInt(sshPort) || 22, sshUser || undefined, sshJumpHost.trim() || undefined)
      .then((sessions) => {
        setTmuxSessions(sessions);
        setTmuxLoading(false);
      })
      .catch((err) => {
        const msg = String(err);
        if (msg.includes("not installed")) {
          setTmuxAvailable(false);
          setTmuxSessions([]);
          setSelectedTmuxSession(null);
          setTmuxLoading(false);
          setStep("confirm");
        } else {
          setTmuxError(msg);
          setTmuxLoading(false);
        }
      });
  }, [step, sshHost, sshPort, sshUser, sshJumpHost]);

  useEffect(() => {
    if (step === "projects") searchRef.current?.focus();
    if (step === "ai") {
      aiStepRef.current?.focus();
      const currentIdx = enabledProviders.indexOf(aiProvider);
      setHighlightedProviderIndex(currentIdx >= 0 ? currentIdx : enabledProviders.length - 1);
    }
    if (step === "confirm") {
      labelRef.current?.focus();
      setShowNewProjectInput(false);
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [query]);

  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll(".project-picker-item");
      items[highlightedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  // Check which selected projects are git repos when selection changes
  useEffect(() => {
    if (selectedProjectIds.length === 0) {
      setGitProjectIds([]);
      setBranchSelections({});
      return;
    }
    let cancelled = false;
    setCheckingGit(true);
    Promise.all(
      selectedProjectIds.map((projectId) =>
        checkIsGitRepo(projectId)
          .then((isGit) => ({ projectId, isGit }))
          .catch(() => ({ projectId, isGit: false }))
      )
    )
      .then((results) => {
        if (cancelled) return;
        const gitIds = results.filter((r) => r.isGit).map((r) => r.projectId);
        setGitProjectIds(gitIds);
        setGitCheckedFor(selectedProjectIds);
        setBranchSelections((prev) => {
          const next: Record<string, BranchSelection> = {};
          for (const [id, sel] of Object.entries(prev)) {
            if (gitIds.includes(id) && selectedProjectIds.includes(id)) {
              next[id] = sel;
            }
          }
          return next;
        });
      })
      .finally(() => {
        if (!cancelled) setCheckingGit(false);
      });
    return () => { cancelled = true; };
  }, [selectedProjectIds]);

  // Next waits until the git check has answered for THIS selection. Right
  // after a folder is picked there is a render before the check starts;
  // moving on then would skip the branch step (and with it the task's own
  // worktree).
  const gitCheckPending =
    checkingGit || (selectedProjectIds.length > 0 && gitCheckedFor !== selectedProjectIds);

  const filtered = useMemo(() => {
    if (!query) return allProjects;
    const q = query.toLowerCase();
    return allProjects.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q) ||
        r.languages.some((l: string) => l.toLowerCase().includes(q))
    );
  }, [query, allProjects]);

  const selectedProjectNames = useMemo(() => {
    return selectedProjectIds
      .map((id) => allProjects.find((r) => r.id === id)?.name)
      .filter(Boolean) as string[];
  }, [selectedProjectIds, allProjects]);

  const toggleProject = (id: string) => {
    setSelectedProjectIds((prev) => {
      // A shell's folder is a radio: picking it again (row, box or Space)
      // keeps it; Skip is the way to have none.
      if (isShellOnly) return prev.length === 1 && prev[0] === id ? prev : [id];
      if (prev.includes(id)) return prev.filter((r) => r !== id);
      return [...prev, id];
    });
  };

  const removeProject = async (id: string) => {
    try {
      await deleteProject(id);
      setAllProjects((prev) => prev.filter((r) => r.id !== id));
      setSelectedProjectIds((prev) => prev.filter((r) => r !== id));
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  };

  const scanNewPath = async (path: string) => {
    if (!path.trim()) return;
    setScanning(true);
    try {
      const project = await createProject(path.trim(), null);
      const ordered: ProjectOrdered = { ...project, session_count: 0, last_opened_at: null, path_exists: true };
      setAllProjects((prev) => [ordered, ...prev.filter((r) => r.id !== project.id)]);
      setSelectedProjectIds((prev) =>
        prev.includes(project.id) ? prev : (isShellOnly ? [project.id] : [...prev, project.id])
      );
      setScanPath("");
    } catch (err) {
      console.error("Failed to create project:", err);
    } finally {
      setScanning(false);
    }
  };

  const handleBrowse = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      await scanNewPath(selected);
    }
  };

  const shortPath = (p: string) => {
    const home = p.replace(/^\/Users\/[^/]+/, "~");
    return home.length > 50 ? "..." + home.slice(-47) : home;
  };

  const handleConfirm = async () => {
    setCreating(true);
    try {
      const firstProjectPath = selectedProjectIds.length > 0
        ? allProjects.find((r) => r.id === selectedProjectIds[0])?.path
        : undefined;
      const sshDest = sshUser.trim() ? `${sshUser.trim()}@${sshHost}` : sshHost;
      const sshLabel = selectedTmuxSession
        ? `${sshDest} [${selectedTmuxSession}]`
        : sshDest;

      // Local path = terminal or Agent view.  SSH path is its own branch.
      const isLocal = mode !== "ssh";
      const isAgent = mode === "agent";
      // Pass aiProvider only for local sessions; the Agent view is implicitly Claude.
      const providerForCreate = isLocal && !isAgent ? aiProvider || undefined : isAgent ? "claude" : undefined;
      const isCustomAgent = providerForCreate === CUSTOM_AGENT_ID;

      // A name typed here may go into an away message; remember it as the
      // user's (see attention/userLabels.ts).
      const typedLabel = label.trim();
      const sessionId = typedLabel ? crypto.randomUUID() : undefined;
      if (sessionId) rememberUserLabel(sessionId, typedLabel);
      await onCreate({
        sessionId,
        label: label || (mode === "ssh" ? sshLabel : undefined),
        description: description || undefined,
        group: selectedGroup || undefined,
        color: selectedColor,
        aiProvider: providerForCreate,
        // The Agent view skips permission/prefix/suffix entirely.
        autoApprove: isLocal && !isAgent ? (autoApprove || undefined) : undefined,
        permissionMode: isLocal && !isAgent && aiProvider ? launchPermissionMode(aiProvider, permissionMode) : undefined,
        customPrefix: isLocal && !isAgent && aiProvider && customPrefix.trim() ? customPrefix.trim() : undefined,
        customSuffix: isLocal && !isAgent && aiProvider && customSuffix.trim() ? customSuffix.trim() : undefined,
        agentName: isCustomAgent ? sanitizeCommandFragment(customAgentName) || undefined : undefined,
        agentCommand: isCustomAgent ? sanitizeCommandFragment(customAgentCommand) : undefined,
        // Channels still apply in the Agent view (Telegram etc).
        channels: isLocal && (isAgent || aiProvider === "claude") && selectedChannels.length > 0 ? selectedChannels : undefined,
        projectIds: isLocal && selectedProjectIds.length > 0 ? selectedProjectIds : undefined,
        workingDirectory: isLocal ? firstProjectPath : undefined,
        branchSelections: isLocal && Object.keys(branchSelections).length > 0 ? branchSelections : undefined,
        mode: resolvedSessionMode,
        sshHost: mode === "ssh" ? sshHost : undefined,
        sshPort: mode === "ssh" ? (parseInt(sshPort) || 22) : undefined,
        sshUser: mode === "ssh" ? (sshUser || undefined) : undefined,
        tmuxSession: mode === "ssh" ? (selectedTmuxSession || undefined) : undefined,
        sshIdentityFile: mode === "ssh" ? (sshIdentityFile || undefined) : undefined,
        sshJumpHost: mode === "ssh" ? (sshJumpHost.trim() || undefined) : undefined,
      });

      // Remember Terminal vs Agent view for this agent, so the next new
      // session preselects the same choice.
      if (isLocal && providerForCreate) {
        const next = rememberSessionMode(modePrefs, providerForCreate, resolvedSessionMode);
        setModePrefs(next);
        setSetting(SESSION_MODE_BY_PROVIDER_KEY, JSON.stringify(next)).catch((err) =>
          console.warn("[SessionCreator] Failed to persist session_mode_by_provider:", err),
        );
      }

      if (mode === "ssh" && sshHost.trim()) {
        const entry: SshHistoryEntry = {
          host: sshHost.trim(),
          user: sshUser.trim() || "",
          port: parseInt(sshPort) || 22,
          lastUsed: new Date().toISOString(),
        };
        const updated = addToSshHistory(sshHistory, entry);
        setSetting(SSH_HISTORY_KEY, JSON.stringify(updated))
          .catch((err) => console.warn("[SessionCreator] Failed to save SSH history:", err));

        if (saveAsHost && saveHostLabel.trim()) {
          upsertSshSavedHost({
            id: crypto.randomUUID(),
            label: saveHostLabel.trim(),
            host: sshHost.trim(),
            port: parseInt(sshPort) || 22,
            user: sshUser.trim() || "",
            identity_file: sshIdentityFile.trim() || null,
            jump_host: sshJumpHost.trim() || null,
            port_forwards: "[]",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).catch((err) => console.warn("[SessionCreator] Failed to save SSH host:", err));
        }
      }
    } finally {
      setCreating(false);
    }
  };

  // Agents from the catalog this build shows (beta entries and the Custom
  // agent only with the agentCatalog flag), then "Plain shell" last.
  const agents = useMemo(() => listAgents(), []);
  const customAgentEntry = useMemo(() => customAgent(), []);
  const enabledProviders = useMemo<(string | null)[]>(
    () => [...agents.map((p) => p.id), ...(customAgentEntry ? [customAgentEntry.id] : []), null],
    [agents, customAgentEntry],
  );

  const knownProviderIds = useMemo(() => enabledProviders.filter((id): id is string => id !== null), [enabledProviders]);
  const customCommandMissing = aiProvider === CUSTOM_AGENT_ID && !sanitizeCommandFragment(customAgentCommand);

  // Keep the keyboard highlight on the chosen agent when the choice changes
  // without a click (the saved default arrives after the first render), so
  // only one card looks selected.
  useEffect(() => {
    setHighlightedProviderIndex(enabledProviders.indexOf(aiProvider as (typeof enabledProviders)[number]));
  }, [aiProvider, enabledProviders]);

  // Load the per-agent Terminal / Agent view choice once on mount.
  useEffect(() => {
    let cancelled = false;
    getSetting(SESSION_MODE_BY_PROVIDER_KEY)
      .then((raw) => { if (!cancelled) setModePrefs(parseSessionModeByProvider(raw)); })
      .catch((err) => console.warn("[SessionCreator] Failed to load session_mode_by_provider:", err))
      .finally(() => { if (!cancelled) setModePrefsLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  // Load the persisted default once on mount.
  useEffect(() => {
    let cancelled = false;
    getSetting(LAST_AI_PROVIDER_KEY)
      .then((raw) => {
        if (cancelled) return;
        setDefaultAiProvider(resolveDefaultAiProvider(raw, knownProviderIds));
        setDefaultAiProviderLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) setDefaultAiProviderLoaded(true);
        console.warn("[SessionCreator] Failed to load last_ai_provider:", err);
      });
    return () => { cancelled = true; };
    // knownProviderIds is a stable useMemo — exhaustive-deps lint silenced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply the saved default the first time the user lands on the agent step
  // with both settings loaded. One-shot: subsequent mode flips don't override
  // the user's in-flight selection. The remembered Terminal / Agent view
  // choice for that agent is preselected with it.
  useEffect(() => {
    if (defaultProviderAppliedRef.current) return;
    if (mode !== "terminal") return;
    if (!defaultAiProviderLoaded || !modePrefsLoaded) return;
    if (!defaultAiProvider) return;
    defaultProviderAppliedRef.current = true;
    setAiProvider(defaultAiProvider);
    setMode(preferredSessionMode(modePrefs, defaultAiProvider));
  }, [mode, defaultAiProvider, defaultAiProviderLoaded, modePrefs, modePrefsLoaded]);

  /** Wrap setAiProvider so an explicit user pick is also persisted as the
   *  new global default. Only non-null choices are persisted — "no AI"
   *  leaves the previous default intact so it can pre-select next time.
   *  Picking an agent also preselects its remembered Terminal / Agent view
   *  choice (terminal unless the user chose the Agent view last time).
   *  Re-picking the agent that is already selected keeps the current choice. */
  const chooseAiProvider = useCallback((id: string | null) => {
    if (id !== aiProvider) setMode(preferredSessionMode(modePrefs, id));
    setAiProvider(id);
    if (id) {
      setSetting(LAST_AI_PROVIDER_KEY, id).catch((err) =>
        console.warn("[SessionCreator] Failed to persist last_ai_provider:", err),
      );
    }
  }, [modePrefs, aiProvider]);

  // F35: the chosen agent starts in its mapping of the safety default.
  useEffect(() => {
    if (!safetyDefaultOn || !aiProvider || aiProvider === CUSTOM_AGENT_ID || userPickedModeRef.current) return;
    const safe = safetyDefaultMode(aiProvider);
    setPermissionMode(safe);
    setAutoApprove(safe === "bypassPermissions");
  }, [safetyDefaultOn, aiProvider]);

  const selectProviderAndAdvance = (idx: number) => {
    const id = enabledProviders[idx] ?? null;
    chooseAiProvider(id as string | null);
    if (!id || id === CUSTOM_AGENT_ID) { setAutoApprove(false); setPermissionMode("default"); }
    if (id !== "claude") setSelectedChannels([]);
    // The Custom agent needs its command typed first.
    if (id === CUSTOM_AGENT_ID && !sanitizeCommandFragment(customAgentCommand)) return;
    goNext();
  };

  const continueFromBranchStep = () => {
    const draft = branchDraft;
    if (draft?.ok) {
      setBranchSelections((prev) => ({ ...prev, [draft.projectId]: { branch: draft.name, createNew: true } }));
    }
    goNext();
  };

  const handleBranchSkipped = useCallback(() => {
    setBranchSelections({});
    goNext();
  }, [goNext]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }

    if (step === "projects") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((prev) => {
          const next = prev - 1;
          if (next < 0) { searchRef.current?.focus(); return -1; }
          return next;
        });
      } else if (e.key === " " && highlightedIndex >= 0) {
        e.preventDefault();
        toggleProject(filtered[highlightedIndex].id);
      } else if (e.key === "Enter" && highlightedIndex >= 0) {
        e.preventDefault();
        if (!gitCheckPending) goNext();
      }
    } else if (step === "ai") {
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        setHighlightedProviderIndex((prev) => (prev + 1) % enabledProviders.length);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        setHighlightedProviderIndex((prev) => (prev - 1 + enabledProviders.length) % enabledProviders.length);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectProviderAndAdvance(highlightedProviderIndex);
      }
    }
  };

  // Wording helpers — mode-conditional vocabulary.
  const folderSectionTitle = mode === "agent"
    ? t("session.projectContext")
    : isShellOnly ? t("session.workingDirectory") : t("session.selectFolders");
  const folderSubtitle = mode === "agent"
    ? t("session.projectContextHint")
    : isShellOnly
      ? t("session.workingDirectoryHint")
      : t("session.selectFoldersHint");

  return (
    <div
      className="command-palette-overlay"
      onClick={() => handleOverlayClick(onClose)}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="session-creator"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{ width: panelWidth, height: panelHeight }}
      >
        <div className="session-creator-resize-handle" onMouseDown={onResizeWidthStart} />
        <div className="session-creator-resize-handle-bottom" onMouseDown={onResizeHeightStart} />
        {/* Header */}
        <div className="session-creator-header">
          <span className="session-creator-title">{t("session.new")}</span>
          <span className="session-creator-step">{t("session.step", { current: currentStepNumber, total: totalSteps })}</span>
          <CloseButton className="session-creator-close" label={t("common.close")} onClick={onClose} />
        </div>

        {/* Step indicator */}
        <div className="session-creator-steps">
          {orderedSteps.map((s, idx) => (
            <span
              key={s}
              className={`session-creator-step-dot ${currentStepNumber >= idx + 1 ? "active" : ""}`}
            />
          ))}
        </div>

        {/* ── SSH connection form (mode=ssh) ────────────────────────── */}
        {step === "ssh" && mode === "ssh" && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">SSH</div>
            <div className="session-creator-ssh-fields">
              {sshSavedHosts.length > 0 && !sshHost && (
                <div className="session-creator-ssh-history">
                  <span className="session-creator-ssh-history-label">{t("session.saved")}</span>
                  <div className="session-creator-ssh-history-list">
                    {sshSavedHosts.map((h) => (
                      <Button
                        key={h.id}
                        size="sm"
                        className="session-creator-ssh-history-item"
                        onClick={() => {
                          setSshHost(h.host);
                          setSshUser(h.user);
                          setSshPort(String(h.port));
                          setSshIdentityFile(h.identity_file || "");
                          setSshJumpHost(h.jump_host || "");
                        }}
                      >
                        <span className="session-creator-ssh-history-host">
                          {h.label}
                        </span>
                        <span className="session-creator-ssh-history-port">
                          {h.user ? `${h.user}@` : ""}{h.host}{h.port !== 22 ? `:${h.port}` : ""}
                        </span>
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {sshHistory.length > 0 && !sshHost && (
                <div className="session-creator-ssh-history">
                  <span className="session-creator-ssh-history-label">{t("session.recent")}</span>
                  <div className="session-creator-ssh-history-list">
                    {sshHistory.map((h, i) => (
                      <Button
                        key={`${h.host}-${h.user}-${h.port}-${i}`}
                        size="sm"
                        className="session-creator-ssh-history-item"
                        onClick={() => {
                          setSshHost(h.host);
                          setSshUser(h.user);
                          setSshPort(String(h.port));
                        }}
                      >
                        <span className="session-creator-ssh-history-host">
                          {h.user ? `${h.user}@` : ""}{h.host}
                        </span>
                        {h.port !== 22 && (
                          <span className="session-creator-ssh-history-port">:{h.port}</span>
                        )}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              <Input
                ref={searchRef}
                code
                aria-label={t("session.sshHostPlaceholder")}
                placeholder={t("session.sshHostPlaceholder")}
                value={sshHost}
                onChange={(e) => setSshHost(e.target.value)}
                autoComplete="off"
                autoFocus
              />
              <div className="session-creator-ssh-row">
                <Input
                  className="session-creator-ssh-user"
                  aria-label={t("session.sshUserPlaceholder")}
                  placeholder={t("session.sshUserPlaceholder")}
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  autoComplete="off"
                />
                <Input
                  className="session-creator-ssh-port"
                  aria-label={t("session.sshPortPlaceholder")}
                  placeholder={t("session.sshPortPlaceholder")}
                  value={sshPort}
                  onChange={(e) => setSshPort(e.target.value.replace(/\D/g, ""))}
                  autoComplete="off"
                />
              </div>
              <Input
                code
                aria-label={t("session.sshIdentityFilePlaceholder")}
                placeholder={t("session.sshIdentityFilePlaceholder")}
                value={sshIdentityFile}
                onChange={(e) => setSshIdentityFile(e.target.value)}
                autoComplete="off"
              />
              <Input
                code
                aria-label={t("session.sshJumpHostPlaceholder")}
                placeholder={t("session.sshJumpHostPlaceholder")}
                value={sshJumpHost}
                onChange={(e) => setSshJumpHost(e.target.value)}
                autoComplete="off"
              />
              <span className="settings-hint-inline">{t("session.sshConfigHint")}</span>
              <div className="session-creator-save-host">
                <Checkbox className="session-creator-save-host-label" checked={saveAsHost} onChange={setSaveAsHost} label="Save this host" />
                {saveAsHost && (
                  <Input
                    className="session-creator-save-host-name"
                    aria-label={t("session.sshLabelExample")}
                    placeholder={t("session.sshLabelExample")}
                    value={saveHostLabel}
                    onChange={(e) => setSaveHostLabel(e.target.value)}
                    autoComplete="off"
                  />
                )}
              </div>
            </div>
            <div className="session-creator-actions">
              <Button className="session-creator-btn-secondary" onClick={goBack}>{t("common.back")}</Button>
              <Button variant="primary" className="session-creator-btn-primary" onClick={goNext} disabled={!sshHost.trim()}>
                {t("common.next")}
              </Button>
            </div>
          </div>
        )}

        {/* ── Folder picker (terminal + Agent view) ─────────────────── */}
        {step === "projects" && mode !== "ssh" && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">{folderSectionTitle}</div>
            <div className="session-creator-subtitle">{folderSubtitle}</div>
            <Input
              ref={searchRef}
              className="session-creator-filter"
              aria-label={t("session.filterFolders")}
              placeholder={t("session.filterFolders")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <div className="session-creator-list" ref={listRef}>
              {filtered.length === 0 && !query && (
                <div className="workspace-empty">
                  {t("session.noFolders")}
                </div>
              )}
              {filtered.length === 0 && query && (
                <div className="command-palette-empty">
                  {t("session.noFoldersMatch", { query })}
                </div>
              )}
              {filtered.map((project, idx) => {
                const missing = "path_exists" in project && !project.path_exists;
                const attached = selectedProjectIds.includes(project.id);
                const info = (
                  <span className="project-picker-info">
                    <span className="project-picker-name">
                      {project.name}
                      {!isShellOnly && selectedProjectIds[0] === project.id && selectedProjectIds.length > 0 && (
                        <Badge tone="info" className="session-creator-cwd-badge">CWD</Badge>
                      )}
                    </span>
                    <span className="project-picker-path">{shortPath(project.path)}</span>
                    {missing && (
                      <span className="project-picker-missing-label">{t("session.folderNotFound")}</span>
                    )}
                    {(project.languages.length > 0 || project.frameworks.length > 0) && (
                      <span className="project-picker-tags">
                        {project.languages.map((lang) => (
                          <span
                            key={lang}
                            className="workspace-lang-tag"
                            style={{
                              color: LANG_COLORS[lang] || "#7b93db",
                              borderColor: (LANG_COLORS[lang] || "#7b93db") + "66",
                            }}
                          >
                            {lang}
                          </span>
                        ))}
                        {project.frameworks.map((fw) => (
                          <span key={fw} className="workspace-fw-tag">{fw}</span>
                        ))}
                      </span>
                    )}
                  </span>
                );
                // The list is driven from the filter field (arrows, Space), so its
                // boxes are not tab stops; a click anywhere on the row toggles it.
                const pick = isShellOnly ? (
                  <Radio className="session-creator-pick" tabIndex={-1} name="session-creator-folder" checked={attached} onChange={() => toggleProject(project.id)} label={info} />
                ) : (
                  <Checkbox className="session-creator-pick" tabIndex={-1} checked={attached} onChange={() => toggleProject(project.id)} label={info} />
                );
                return (
                  <div
                    key={project.id}
                    className={cx("project-picker-item", attached && "project-picker-item-attached", highlightedIndex === idx && "session-creator-highlighted", missing && "project-picker-item-missing")}
                    onClick={(e) => {
                      // The box's own label already toggles it.
                      if (missing || (e.target as HTMLElement).closest(".h-choice")) return;
                      toggleProject(project.id);
                    }}
                  >
                    {missing ? (
                      <>
                        <span className="project-picker-check" aria-hidden="true">(!)</span>
                        {info}
                      </>
                    ) : (
                      pick
                    )}
                    <IconButton
                      size="sm"
                      className="session-creator-remove-btn"
                      label={t("session.removeFolder")}
                      icon={<CloseGlyph />}
                      onClick={(e) => { e.stopPropagation(); removeProject(project.id); }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="project-picker-footer">
              <Input
                code
                className="session-creator-scan-input"
                aria-label={t("session.pathOrBrowse")}
                placeholder={t("session.pathOrBrowse")}
                value={scanPath}
                onChange={(e) => setScanPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") scanNewPath(scanPath);
                }}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <Button className="session-creator-scan-btn" onClick={handleBrowse} disabled={scanning} loading={scanning}>
                {t("common.browse")}
              </Button>
              <Button className="session-creator-scan-btn" onClick={() => scanNewPath(scanPath)} disabled={scanning || !scanPath.trim()}>
                {t("common.scan")}
              </Button>
            </div>
            <div className="session-creator-hints">
              <span><kbd>&uarr;&darr;</kbd> {t("common.navigate")}</span>
              <span><kbd>Space</kbd> {isShellOnly ? t("common.select") : t("common.toggle")}</span>
              <span><kbd>Enter</kbd> {t("common.next")}</span>
              <span><kbd>Esc</kbd> {t("session.closeHint")}</span>
            </div>
            <div className="session-creator-actions">
              <Button className="session-creator-btn-secondary" onClick={goBack}>
                {t("common.back")}
              </Button>
              <Button className="session-creator-btn-secondary" onClick={() => { setSelectedProjectIds([]); goNext(); }}>
                {t("common.skip")}
              </Button>
              <Button variant="primary" className="session-creator-btn-primary" onClick={goNext} disabled={gitCheckPending}>
                {gitCheckPending ? t("common.checking") : isShellOnly
                  ? t("common.next")
                  : t("common.selectedCount", { count: selectedProjectIds.length })}
              </Button>
            </div>
          </div>
        )}

        {/* ── Branch isolation step ─────────────────────────────────── */}
        {step === "branch" && gitProjectIds.length > 0 && (
          <>
            <div className="session-creator-body">
              <div className="session-creator-section-title">{t("session.selectBranches")}</div>
              <div className="session-creator-subtitle">
                {t("session.selectBranchesHint")}
              </div>
              <div className="session-creator-branch-multi">
                {selectedProjectIds.map((projectId) => {
                  const isGit = gitProjectIds.includes(projectId);
                  const projectName = allProjects.find((r) => r.id === projectId)?.name || projectId;
                  const isExpanded = expandedProjectId === projectId;

                  if (!isGit) {
                    return (
                      <div key={projectId} className="session-creator-branch-project">
                        <div className="session-creator-branch-project-header">
                          <span className="session-creator-branch-project-name">{projectName}</span>
                          <span className="session-creator-branch-nonGit">{t("session.notGitRepo")}</span>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={projectId} className={`session-creator-branch-project ${isExpanded ? "expanded" : ""}`}>
                      <div
                        className="session-creator-branch-project-header"
                        onClick={() => setExpandedProjectId(isExpanded ? null : projectId)}
                        style={{ cursor: "pointer" }}
                      >
                        <span className="session-creator-branch-project-chevron">{isExpanded ? "▼" : "▶"}</span>
                        <span className="session-creator-branch-project-name">{projectName}</span>
                        {branchSelections[projectId] && (
                          <span className="session-creator-branch-selected-label">
                            {branchSelections[projectId].branch}
                            {branchSelections[projectId].createNew ? " (new)" : ""}
                          </span>
                        )}
                      </div>
                      {isExpanded && (
                        <SessionBranchSelector
                          projectId={projectId}
                          // Tell the selector what we already have for this
                          // project so it skips Bug 2's auto-propagation
                          // (which would otherwise re-fire on every
                          // re-expand, retrigger the auto-advance effect
                          // below, and snap the panel shut).
                          existingBranchName={branchSelections[projectId]?.branch}
                          defaultTaskSlug={defaultTaskSlug}
                          onBranchSelected={(name, isNew, fromRemote) => {
                            setBranchSelections((prev) => ({
                              ...prev,
                              [projectId]: { branch: name, createNew: isNew, fromRemote },
                            }));
                          }}
                          onDraftChange={(draft) => {
                            setBranchDraft((prev) => (draft ? { ...draft, projectId } : prev?.projectId === projectId ? null : prev));
                          }}
                          onSkip={() => {
                            // "Use current branch" wins over a name left in the form.
                            setBranchDraft(null);
                            setBranchSelections((prev) => {
                              const next = { ...prev };
                              delete next[projectId];
                              return next;
                            });
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="session-creator-footer-actions">
              <Button className="session-creator-btn-secondary" onClick={goBack}>
                {t("common.back")}
              </Button>
              <Button className="session-creator-btn-secondary" onClick={handleBranchSkipped}>
                {t("session.continueWithoutIsolation")}
              </Button>
              <Button
                variant="primary"
                className="session-creator-btn-primary"
                onClick={continueFromBranchStep}
                disabled={!!branchDraft && !branchDraft.ok}
              >
                {t("common.continue")}
              </Button>
            </div>
          </>
        )}

        {/* ── tmux session picker (SSH only) ────────────────────────── */}
        {step === "tmux" && mode === "ssh" && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">{t("session.tmuxSessions")}</div>
            {tmuxLoading && (
              <div className="command-palette-empty">Connecting to {sshHost}...</div>
            )}
            {tmuxError && (
              <div className="command-palette-empty">
                Failed to discover tmux sessions: {tmuxError}
              </div>
            )}
            {!tmuxLoading && !tmuxError && tmuxAvailable && (
              <>
              <div className="session-creator-list" role="radiogroup" aria-label={t("session.tmuxSessions")}>
                {tmuxSessions.map((ts) => {
                  const pickTmux = () => { setSelectedTmuxSession(ts.name); setShowNewTmuxInput(false); };
                  return (
                    <div
                      key={ts.name}
                      className={cx("project-picker-item", selectedTmuxSession === ts.name && "project-picker-item-attached")}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest(".h-choice")) return;
                        pickTmux();
                      }}
                    >
                      <Radio
                        className="session-creator-pick"
                        name="session-creator-tmux"
                        checked={selectedTmuxSession === ts.name}
                        onChange={pickTmux}
                        label={
                          <span className="project-picker-info">
                            <span className="project-picker-name">{ts.name}</span>
                            <span className="project-picker-path">
                              {ts.windows} window{ts.windows !== 1 ? "s" : ""}
                              {ts.attached ? " (attached)" : ""}
                            </span>
                          </span>
                        }
                      />
                    </div>
                  );
                })}
                {!showNewTmuxInput ? (
                  <Button
                    variant="quiet"
                    className="session-creator-tmux-new"
                    title={t("session.newTmuxSessionHint")}
                    onClick={() => { setShowNewTmuxInput(true); setNewTmuxSessionName(""); }}
                  >
                    {t("session.newTmuxSession")}
                  </Button>
                ) : (
                  <div className="project-picker-item project-picker-item-attached">
                    <span className="project-picker-info">
                      <Input
                        className="session-creator-tmux-name"
                        aria-label={t("session.newTmuxSession")}
                        autoFocus
                        placeholder={t("session.tmuxNamePlaceholder")}
                        value={newTmuxSessionName}
                        onChange={(e) => {
                          setNewTmuxSessionName(e.target.value);
                          setSelectedTmuxSession(e.target.value.trim() || null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter" && newTmuxSessionName.trim()) {
                            setSelectedTmuxSession(newTmuxSessionName.trim());
                            setShowNewTmuxInput(false);
                          }
                          if (e.key === "Escape") {
                            setShowNewTmuxInput(false);
                            setSelectedTmuxSession(null);
                          }
                        }}
                        onBlur={() => {
                          if (newTmuxSessionName.trim()) {
                            setSelectedTmuxSession(newTmuxSessionName.trim());
                          }
                          setShowNewTmuxInput(false);
                        }}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </span>
                  </div>
                )}
              </div>
              <span className="settings-hint-inline">
                tmux sessions persist on the server — reconnect anytime to pick up where you left off
              </span>
              </>
            )}
            <div className="session-creator-actions">
              <Button className="session-creator-btn-secondary" onClick={goBack}>
                {t("common.back")}
              </Button>
              <Button variant="primary" className="session-creator-btn-primary" onClick={goNext} disabled={tmuxLoading || !selectedTmuxSession}>
                {tmuxLoading ? t("common.checking") : t("common.next")}
              </Button>
            </div>
          </div>
        )}

        {/* ── Agent picker (first step for every local session) ─────── */}
        {step === "ai" && mode !== "ssh" && (
          <div className="session-creator-body" ref={aiStepRef} tabIndex={-1} style={{ outline: "none" }}>
            <div className="session-creator-section-title">{t("session.chooseAgent")}</div>
            <div className="session-creator-provider-grid">
              {agents.map((p) => {
                const providerIdx = enabledProviders.indexOf(p.id);
                const isAvailable = !availabilityLoaded || providerAvailability[p.id];
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-agent-id={p.id}
                    aria-pressed={aiProvider === p.id}
                    className={`session-creator-provider-card ${aiProvider === p.id ? "selected" : ""} ${highlightedProviderIndex === providerIdx ? "selected" : ""} ${availabilityLoaded && !isAvailable ? "session-creator-provider-unavailable" : ""}`}
                    onClick={() => { chooseAiProvider(p.id); setHighlightedProviderIndex(providerIdx); if (p.id !== "claude") setSelectedChannels([]); }}
                  >
                    <span className="session-creator-provider-name">
                      {p.name}
                      {availabilityLoaded && !isAvailable && (
                        <Badge tone="warning" className="session-creator-provider-status-badge">{t("session.notDetected")}</Badge>
                      )}
                    </span>
                    <span className="session-creator-provider-desc">{p.description}</span>
                    {availabilityLoaded && !isAvailable && (
                      <a
                        className="session-creator-provider-install-link"
                        onClick={(e) => { e.stopPropagation(); if (p.install) shellOpen(p.install.url); }}
                      >
                        How to install
                      </a>
                    )}
                  </button>
                );
              })}
              {customAgentEntry && (
                <button
                  type="button"
                  data-agent-id={customAgentEntry.id}
                  aria-pressed={aiProvider === customAgentEntry.id}
                  className={`session-creator-provider-card ${aiProvider === customAgentEntry.id ? "selected" : ""} ${highlightedProviderIndex === enabledProviders.indexOf(customAgentEntry.id) ? "selected" : ""}`}
                  onClick={() => {
                    chooseAiProvider(customAgentEntry.id);
                    setHighlightedProviderIndex(enabledProviders.indexOf(customAgentEntry.id));
                    setPermissionMode("default");
                    setAutoApprove(false);
                    setSelectedChannels([]);
                  }}
                >
                  <span className="session-creator-provider-name">{customAgentEntry.name}</span>
                  <span className="session-creator-provider-desc">{customAgentEntry.description}</span>
                </button>
              )}
              <button
                type="button"
                aria-pressed={aiProvider === null}
                className={`session-creator-provider-card ${aiProvider === null ? "selected" : ""} ${highlightedProviderIndex === enabledProviders.length - 1 ? "selected" : ""}`}
                onClick={() => { chooseAiProvider(null); setAutoApprove(false); setSelectedChannels([]); setHighlightedProviderIndex(enabledProviders.length - 1); }}
              >
                <span className="session-creator-provider-name">{t("session.plainShell")}</span>
                <span className="session-creator-provider-desc">{t("session.noAiAgent")}</span>
              </button>
            </div>
            {aiProvider && getAgent(aiProvider)?.install && availabilityLoaded && !providerAvailability[aiProvider] && (
              <div className="session-creator-install-hint">
                <div className="session-creator-install-hint-title">
                  {t("session.cliNotDetected", { cli: getAgent(aiProvider)?.name ?? aiProvider })}
                </div>
                <code className="session-creator-install-hint-cmd">{installCommand(getAgent(aiProvider))}</code>
                <div className="session-creator-install-hint-auth">{getAgent(aiProvider)?.auth?.hint}</div>
              </div>
            )}
            {aiProvider && getAgent(aiProvider)?.status_note && (
              <div className="session-creator-install-hint session-creator-agent-note">
                <div className="session-creator-install-hint-auth">{getAgent(aiProvider)?.status_note}</div>
              </div>
            )}
            {aiProvider === CUSTOM_AGENT_ID && (
              <div className="session-creator-custom-agent">
                <div className="session-creator-custom-suffix">
                  <label className="session-creator-custom-suffix-label" htmlFor="session-creator-custom-agent-name">{t("session.customAgentName")}</label>
                  <Input
                    id="session-creator-custom-agent-name"
                    className="session-creator-custom-suffix-input"
                    value={customAgentName}
                    onChange={(e) => setCustomAgentName(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder={t("session.customAgentNamePlaceholder")}
                    maxLength={40}
                    spellCheck={false}
                  />
                </div>
                <div className="session-creator-custom-suffix">
                  <label className="session-creator-custom-suffix-label" htmlFor="session-creator-custom-agent-command">{t("session.customAgentCommand")}</label>
                  <Input
                    id="session-creator-custom-agent-command"
                    code
                    className="session-creator-custom-suffix-input"
                    value={customAgentCommand}
                    onChange={(e) => setCustomAgentCommand(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder={t("session.customAgentCommandPlaceholder")}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                  <span className="session-creator-custom-suffix-hint">
                    {t("session.customAgentCommandHint")}
                  </span>
                </div>
              </div>
            )}
            {hasAgentView(aiProvider) && (
              <Checkbox
                className="session-creator-agent-view"
                checked={mode === "agent"}
                onChange={(on) => setMode(on ? "agent" : "terminal")}
                onKeyDown={(e) => e.stopPropagation()}
                label={<span className="session-creator-agent-view-label">{t("session.agentView")}</span>}
                description={<span className="session-creator-agent-view-hint">{t("session.agentViewHint")}</span>}
              />
            )}
            {aiProvider && aiProvider !== CUSTOM_AGENT_ID && mode === "terminal" && (
              <div className="session-creator-permission-mode">
                <div className="session-creator-permission-mode-label">{t("session.approvalFlow")}</div>
                <div className="session-creator-permission-mode-pills" role="group" aria-label={t("session.approvalFlow")}>
                  {getAvailableModes(aiProvider).map((m) => (
                    <Chip
                      key={m}
                      selected={permissionMode === m}
                      tone={m === "bypassPermissions" ? "danger" : "neutral"}
                      buttonAttrs={{
                        className: cx(
                          "session-creator-permission-pill",
                          permissionMode === m && "session-creator-permission-pill-active",
                          m === "bypassPermissions" && "session-creator-permission-pill-danger",
                        ),
                        "data-mode": m,
                      }}
                      onToggle={() => {
                        userPickedModeRef.current = true;
                        setPermissionMode(m);
                        setAutoApprove(m === "bypassPermissions");
                      }}
                    >
                      {permissionShortLabel(m)}
                      {safetyDefaultOn && m === safetyDefaultMode(aiProvider) && (
                        <span className="session-creator-permission-pill-default">{t("safety.hermesDefault")}</span>
                      )}
                    </Chip>
                  ))}
                </div>
                <div className="session-creator-permission-mode-info">
                  <span className="session-creator-permission-mode-desc">
                    {permissionDescription(permissionMode)}
                  </span>
                  {permissionFlagText(aiProvider, permissionMode) && (
                    <code className="session-creator-permission-mode-flag">
                      {permissionFlagText(aiProvider, permissionMode)}
                    </code>
                  )}
                </div>
              </div>
            )}
            {aiProvider && mode === "terminal" && (
              <div className="session-creator-custom-suffix">
                <div className="session-creator-custom-suffix-label">{t("session.prefixCommand")}</div>
                <Input
                  code
                  className="session-creator-custom-suffix-input"
                  aria-label={t("session.prefixCommand")}
                  value={customPrefix}
                  onChange={(e) => setCustomPrefix(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={getPrefixPlaceholder(PLATFORM)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <span className="session-creator-custom-suffix-hint">
                  {t("session.prefixCommandHint")} <code>caffeinate -i</code>, <code>wsl</code>, <code>nice -n 10</code>.
                </span>
                {PREFIX_EXAMPLES[PLATFORM].length > 0 && (
                  <div
                    className="session-creator-prefix-chips"
                    role="group"
                    aria-label="Prefix examples"
                  >
                    {PREFIX_EXAMPLES[PLATFORM].map((ex) => (
                      <Chip
                        key={ex.value}
                        selected={customPrefix.trim() === ex.value}
                        buttonAttrs={{ className: "session-creator-prefix-chip", title: ex.hint }}
                        onToggle={() => setCustomPrefix(ex.value)}
                      >
                        {ex.label}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            )}
            {aiProvider && mode === "terminal" && (
              <div className="session-creator-custom-suffix">
                <div className="session-creator-custom-suffix-label">{t("session.customFlags")}</div>
                <Input
                  code
                  className="session-creator-custom-suffix-input"
                  aria-label={t("session.customFlags")}
                  value={customSuffix}
                  onChange={(e) => setCustomSuffix(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                  placeholder={t("session.flagsPlaceholder")}
                />
                <span className="session-creator-custom-suffix-hint">
                  {t("session.customFlagsHint")}
                </span>
              </div>
            )}
            {aiProvider && mode === "terminal" && (
              <div
                className="session-creator-launch-preview"
                aria-live="polite"
              >
                <span className="session-creator-launch-preview-label">{t("session.preview")}</span>
                <code className="session-creator-launch-preview-cmd">
                  {buildLaunchPreview(aiProvider, permissionMode, customPrefix, customSuffix, customAgentCommand)}
                </code>
              </div>
            )}
            {aiProvider === "claude" && (
              <div className="session-creator-channels">
                <div className="session-creator-channels-label">{t("session.channels")}</div>
                <div className="session-creator-channels-desc">
                  {t("session.channelsHint")}
                </div>
                <div className="session-creator-channels-list">
                  {CLAUDE_CHANNELS.map((ch) => (
                    <Checkbox
                      key={ch.id}
                      className="session-creator-channel-item"
                      checked={selectedChannels.includes(ch.id)}
                      onChange={(on) => {
                        if (on) {
                          setSelectedChannels((prev) => [...prev, ch.id]);
                        } else {
                          setSelectedChannels((prev) => prev.filter((c) => c !== ch.id));
                        }
                      }}
                      label={
                        <>
                          <span className="session-creator-channel-icon" aria-hidden="true">{ch.icon}</span>{" "}
                          <span className="session-creator-channel-name">{ch.label}</span>
                        </>
                      }
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="session-creator-hints">
              <span><kbd>&uarr;&darr;</kbd><kbd>&larr;&rarr;</kbd> {t("common.navigate")}</span>
              <span><kbd>Enter</kbd> {t("common.select")}</span>
              <span><kbd>Esc</kbd> {t("session.closeHint")}</span>
            </div>
            <div className="session-creator-actions">
              <Button
                variant="quiet"
                className="session-creator-ssh-link"
                onClick={() => { beforeSshRef.current = { mode, aiProvider }; setMode("ssh"); setStep("ssh"); }}
              >
                {t("session.connectSsh")}
              </Button>
              <Button variant="primary" className="session-creator-btn-primary" onClick={goNext} disabled={customCommandMissing}>
                {t("common.next")}
              </Button>
            </div>
          </div>
        )}

        {/* ── Confirm step ──────────────────────────────────────────── */}
        {step === "confirm" && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">{t("session.confirm")}</div>
            <div className="session-creator-summary">
              {mode === "ssh" ? (
                <>
                  <div className="session-creator-summary-row">
                    <span className="session-creator-summary-label">{t("session.connection")}</span>
                    <span className="session-creator-summary-value">{t("session.sshRemote")}</span>
                  </div>
                  <div className="session-creator-summary-row">
                    <span className="session-creator-summary-label">{t("session.host")}</span>
                    <span className="session-creator-summary-value">{sshUser.trim() ? `${sshUser.trim()}@` : ""}{sshHost}{sshPort !== "22" ? `:${sshPort}` : ""}</span>
                  </div>
                  <div className="session-creator-summary-row">
                    <span className="session-creator-summary-label">tmux:</span>
                    <span className="session-creator-summary-value">{selectedTmuxSession || "None (plain shell)"}</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="session-creator-summary-row">
                    <span className="session-creator-summary-label">
                      {mode === "agent" ? `${t("session.projectContext")}:` : (isShellOnly ? t("session.folder") : t("session.folders"))}
                    </span>
                    <span className="session-creator-summary-value">
                      {selectedProjectNames.length > 0 ? selectedProjectNames.join(", ") : t("common.none")}
                    </span>
                  </div>
                  {Object.keys(branchSelections).length > 0 && (
                    <div className="session-creator-summary-row">
                      <span className="session-creator-summary-label">{Object.keys(branchSelections).length === 1 ? "Branch:" : "Branches:"}</span>
                      <span className="session-creator-summary-value">
                        {Object.entries(branchSelections).map(([projectId, sel], idx) => {
                          const name = allProjects.find((r) => r.id === projectId)?.name || projectId;
                          return (
                            <span key={projectId}>
                              {idx > 0 && ", "}
                              {Object.keys(branchSelections).length > 1 ? `${name}: ` : ""}
                              {sel.branch}{sel.createNew ? " (new)" : ""}
                            </span>
                          );
                        })}
                      </span>
                    </div>
                  )}
                  <div className="session-creator-summary-row">
                    <span className="session-creator-summary-label">{t("session.mode")}</span>
                    <span className="session-creator-summary-value">
                      {mode === "agent"
                        ? t("session.agentViewSummary")
                        : aiProvider
                          ? (aiProvider === CUSTOM_AGENT_ID ? sanitizeCommandFragment(customAgentName) : "") || getAgent(aiProvider)?.name || aiProvider
                          : t("session.plainShell")}
                      {mode === "terminal" && aiProvider && permissionMode !== "default" && (
                        <span className="session-creator-summary-flag"> ({permissionShortLabel(permissionMode)})</span>
                      )}
                    </span>
                  </div>
                  {selectedChannels.length > 0 && (
                    <div className="session-creator-summary-row">
                      <span className="session-creator-summary-label">{t("session.channels")}</span>
                      <span className="session-creator-summary-value">
                        {selectedChannels.map((ch) => CLAUDE_CHANNELS.find((c) => c.id === ch)?.label || ch).join(", ")}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
            <Input
              ref={labelRef}
              className="session-creator-name"
              aria-label={t("session.namePlaceholder")}
              placeholder={t("session.namePlaceholder")}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creating) handleConfirm();
              }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <Input
              className="session-creator-description"
              aria-label={t("session.descriptionPlaceholder")}
              placeholder={t("session.descriptionPlaceholder")}
              value={description}
              maxLength={120}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creating) handleConfirm();
              }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />

            {/* Inline project assignment */}
            <div className="session-creator-project-picker">
              <span className="session-creator-project-picker-label">{t("session.project")}</span>
              <div className="session-creator-project-chips" role="group" aria-label={t("session.project")}>
                <Chip
                  selected={selectedGroup === null}
                  buttonAttrs={{ className: cx("session-creator-project-chip", selectedGroup === null && "selected") }}
                  onToggle={() => setSelectedGroup(null)}
                >
                  {t("common.none")}
                </Chip>
                {existingGroups.map((group) => (
                  <Chip
                    key={group}
                    selected={selectedGroup === group}
                    buttonAttrs={{ className: cx("session-creator-project-chip", selectedGroup === group && "selected") }}
                    onToggle={() => { setSelectedGroup(group); if (groupColors[group]) setSelectedColor(groupColors[group]); }}
                  >
                    {groupColors[group] && (
                      <span className="session-creator-project-chip-dot" style={{ background: groupColors[group] }} />
                    )}
                    <svg className="session-creator-project-chip-icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2 5C2 3.9 2.9 3 4 3H7L9 5H14C15.1 5 16 5.9 16 7V13C16 14.1 15.1 15 14 15H4C2.9 15 2 14.1 2 13V5Z" />
                    </svg>
                    {group}
                  </Chip>
                ))}
                {!showNewProjectInput ? (
                  <Button
                    variant="quiet"
                    size="sm"
                    className="session-creator-project-chip-new"
                    onClick={() => { setShowNewProjectInput(true); setNewProjectName(""); }}
                  >
                    {t("session.newProject")}
                  </Button>
                ) : (
                  <Input
                    size="sm"
                    className="session-creator-project-chip-input"
                    aria-label={t("session.projectName")}
                    autoFocus
                    placeholder={t("session.projectName")}
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter" && newProjectName.trim()) {
                        const name = newProjectName.trim();
                        if (!existingGroups.includes(name)) {
                          setExistingGroups((prev) => [...prev, name].sort());
                        }
                        setGroupColors((prev) => ({ ...prev, [name]: selectedColor }));
                        setSelectedGroup(name);
                        setShowNewProjectInput(false);
                        setNewProjectName("");
                      }
                      if (e.key === "Escape") {
                        setShowNewProjectInput(false);
                        setNewProjectName("");
                      }
                    }}
                    onBlur={() => {
                      if (newProjectName.trim()) {
                        const name = newProjectName.trim();
                        if (!existingGroups.includes(name)) {
                          setExistingGroups((prev) => [...prev, name].sort());
                        }
                        setGroupColors((prev) => ({ ...prev, [name]: selectedColor }));
                        setSelectedGroup(name);
                      }
                      setShowNewProjectInput(false);
                      setNewProjectName("");
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              </div>
            </div>

            {/* Color picker */}
            <div className="session-creator-color-picker">
              <span className="session-creator-color-picker-label">{t("session.color")}</span>
              <div className="session-creator-color-swatches" role="group" aria-label={t("session.color")}>
                <button
                  type="button"
                  className={`session-creator-color-swatch session-creator-color-swatch-none ${selectedColor === "" ? "selected" : ""}`}
                  aria-pressed={selectedColor === ""}
                  aria-label={t("session.noColor")}
                  onClick={() => setSelectedColor("")}
                  title={t("session.noColor")}
                >
                  <svg viewBox="0 0 16 16" stroke="currentColor" strokeWidth="2" fill="none" aria-hidden="true">
                    <line x1="2" y1="2" x2="14" y2="14" />
                  </svg>
                </button>
                {SESSION_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`session-creator-color-swatch ${selectedColor === c ? "selected" : ""}`}
                    aria-pressed={selectedColor === c}
                    aria-label={c}
                    style={{ background: c }}
                    onClick={() => setSelectedColor(c)}
                    title={c}
                  />
                ))}
              </div>
            </div>

            <div className="session-creator-hints">
              <span><kbd>Enter</kbd> {t("session.createHint")}</span>
              <span><kbd>Esc</kbd> {t("session.closeHint")}</span>
            </div>
            <div className="session-creator-actions">
              <Button className="session-creator-btn-secondary" onClick={goBack}>
                {t("common.back")}
              </Button>
              <Button variant="primary" className="session-creator-btn-primary" onClick={handleConfirm} disabled={creating}>
                {creating ? t("common.creating") : t("session.createSession")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
