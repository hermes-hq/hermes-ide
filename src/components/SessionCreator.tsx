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
  AI_PROVIDERS,
  getProviderInfo,
  PERMISSION_MODE_FLAGS,
  getAvailableModes,
  AI_AGENT_PREFIXES_KEY,
  PREFIX_EXAMPLES,
  parseAgentPrefixes,
  getPrefixPlaceholder,
  buildLaunchPreview,
} from "../utils/aiProviders";
import { PLATFORM } from "../utils/platform";
import { getSetting, setSetting } from "../api/settings";
import { listSshSavedHosts, upsertSshSavedHost, type SshSavedHost } from "../api/ssh";
import type { PermissionMode, SessionMode, TmuxSessionEntry } from "../types/session";
import { isGitRepo as checkIsGitRepo } from "../api/git";
import { LANG_COLORS } from "../utils/langColors";
import { SessionBranchSelector } from "./SessionBranchSelector";
import { SESSION_COLORS } from "./SessionList";
import {
  SessionCreatorModeStep,
  type SessionCreatorMode,
} from "./SessionCreatorModeStep";
import { useI18n } from "../i18n/I18nProvider";

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

// Internal step identifiers (not displayed to user).
//
// Phase 6 (v1.0.0) inserts a `mode` step as the cardinal Step 1 — every flow
// starts there. After that:
//  - mode="agent"    → projects → branch (if any) → confirm
//  - mode="terminal" → ai → projects → branch (if any) → confirm
//  - mode="ssh"      → ssh → tmux → confirm
type Step = "mode" | "projects" | "branch" | "ai" | "tmux" | "ssh" | "confirm";

interface SessionCreatorProps {
  onClose: () => void;
  onCreate: (opts: CreateSessionOpts) => Promise<void>;
  /** Pre-select a project group when creating from a project's "+" button */
  defaultGroup?: string;
  /** Test/integration hook — start the modal already on a chosen mode and
   *  skip Step 1.  Tests use this to render the "agent path" or "terminal
   *  path" of Step 2+ directly without simulating a click. */
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
  // Cardinal mode (Phase 6).  Drives every conditional below.  Defaults to
  // "agent" so v1.0.0 leads with "Chat with Claude" (the headline experience).
  const [mode, setMode] = useState<SessionCreatorMode>(initialMode ?? "agent");
  const [step, setStep] = useState<Step>(initialMode ? (initialMode === "ssh" ? "ssh" : initialMode === "terminal" ? "ai" : "projects") : "mode");

  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  // For terminal mode the user picks an AI provider; for agent mode it's
  // forced to "claude"; for ssh mode it's irrelevant (mode is "terminal").
  const [aiProvider, setAiProvider] = useState<string | null>(initialMode === "agent" ? "claude" : null);
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
  const [worktreeBasePath, setWorktreeBasePath] = useState("");
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
  const [customSuffix, setCustomSuffix] = useState("");
  const [agentPrefixDefaults, setAgentPrefixDefaults] = useState<Record<string, string>>({});
  const [customPrefix, setCustomPrefix] = useState("");

  // Channel plugins state (Claude only — visible in both agent & terminal-claude paths)
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);

  // Branch isolation — per-project
  type BranchSelection = { branch: string; createNew: boolean; fromRemote?: string };
  const [gitProjectIds, setGitProjectIds] = useState<string[]>([]);
  const [checkingGit, setCheckingGit] = useState(false);
  const [branchSelections, setBranchSelections] = useState<Record<string, BranchSelection>>({});
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);

  // Resolve session-mode that gets persisted to the session.  Agent mode is
  // Claude-only; ssh always = terminal (per v1.0.0 — see playbook §8).
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
      // SSH path is unchanged from v0.6 — host → tmux → confirm.  We add the
      // mode step in front so the user can revisit Step 1.
      return ["mode", "ssh", "tmux", "confirm"];
    }
    if (mode === "agent") {
      // Agent path: mode → folder picker → (branch) → confirm.  No provider
      // step (forced to claude), no permission pills, no shell prefix.
      const steps: Step[] = ["mode", "projects"];
      if (showBranchStep) steps.push("branch");
      steps.push("confirm");
      return steps;
    }
    // Terminal path: mode → provider picker → folder picker → (branch) → confirm.
    const steps: Step[] = ["mode", "ai", "projects"];
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

  // When mode changes, force aiProvider to "claude" for agent mode and clear
  // out terminal-only state.  When switching back to terminal, leave the
  // aiProvider null so the user reopens the picker explicitly.
  useEffect(() => {
    if (mode === "agent") {
      setAiProvider("claude");
      setAutoApprove(false);
      setPermissionMode("default");
      setCustomPrefix("");
      setCustomSuffix("");
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
      setStep(orderedSteps[idx - 1]);
    }
  }, [step, orderedSteps]);

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
      .then((val) => { if (val) setPermissionMode(val as PermissionMode); })
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
  // load on mount. Only matters in terminal mode where the user picks
  // a provider. Agent mode forces "claude" and never shows the picker.
  useEffect(() => {
    if (mode !== "terminal" || availabilityLoaded) return;
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
  // past the mode-select step (or load eagerly above when defaultGroup
  // is set).
  const sessionsLoadedRef = useRef(false);
  useEffect(() => {
    if (sessionsLoadedRef.current) return;
    if (step === "mode" && !defaultGroup) return; // wait for advance
    sessionsLoadedRef.current = true;
    loadSessionsForGroups(defaultGroup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /** Shared by the eager (mount-with-defaultGroup) and lazy (post-mode-step)
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
    sshListTmuxSessions(sshHost.trim(), parseInt(sshPort) || 22, sshUser || undefined)
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
  }, [step, sshHost, sshPort, sshUser]);

  useEffect(() => {
    if (step === "projects") searchRef.current?.focus();
    if (step === "ai") {
      aiStepRef.current?.focus();
      const allItems = [...AI_PROVIDERS, { id: null }] as const;
      const currentIdx = allItems.findIndex((p) => p.id === aiProvider);
      setHighlightedProviderIndex(currentIdx >= 0 ? currentIdx : allItems.length - 1);
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
      if (prev.includes(id)) return prev.filter((r) => r !== id);
      if (isShellOnly) return [id];
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
      const sshLabel = selectedTmuxSession
        ? `${sshUser || "ssh"}@${sshHost} [${selectedTmuxSession}]`
        : `${sshUser || "ssh"}@${sshHost}`;

      // Local path = agent or terminal mode.  SSH path is its own branch.
      const isLocal = mode !== "ssh";
      const isAgent = mode === "agent";
      // Pass aiProvider only for terminal mode; agent mode is implicitly Claude.
      const providerForCreate = isLocal && !isAgent ? aiProvider || undefined : isAgent ? "claude" : undefined;

      await onCreate({
        label: label || (mode === "ssh" ? sshLabel : undefined),
        description: description || undefined,
        group: selectedGroup || undefined,
        color: selectedColor,
        aiProvider: providerForCreate,
        // Agent mode skips permission/prefix/suffix entirely.
        autoApprove: isLocal && !isAgent ? (autoApprove || undefined) : undefined,
        permissionMode: isLocal && !isAgent && aiProvider ? permissionMode : undefined,
        customPrefix: isLocal && !isAgent && aiProvider && customPrefix.trim() ? customPrefix.trim() : undefined,
        customSuffix: isLocal && !isAgent && aiProvider && customSuffix.trim() ? customSuffix.trim() : undefined,
        // Channels still apply in agent mode (Telegram etc).
        channels: isLocal && (isAgent || aiProvider === "claude") && selectedChannels.length > 0 ? selectedChannels : undefined,
        projectIds: isLocal && selectedProjectIds.length > 0 ? selectedProjectIds : undefined,
        workingDirectory: isLocal ? firstProjectPath : undefined,
        branchSelections: isLocal && Object.keys(branchSelections).length > 0 ? branchSelections : undefined,
        worktreeBasePath: worktreeBasePath.trim() || undefined,
        mode: resolvedSessionMode,
        sshHost: mode === "ssh" ? sshHost : undefined,
        sshPort: mode === "ssh" ? (parseInt(sshPort) || 22) : undefined,
        sshUser: mode === "ssh" ? (sshUser || undefined) : undefined,
        tmuxSession: mode === "ssh" ? (selectedTmuxSession || undefined) : undefined,
        sshIdentityFile: mode === "ssh" ? (sshIdentityFile || undefined) : undefined,
      });

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

  const enabledProviders = useMemo(
    () => [...AI_PROVIDERS.map((p) => p.id), null] as const,
    []
  );

  const selectProviderAndAdvance = (idx: number) => {
    const id = enabledProviders[idx] ?? null;
    setAiProvider(id as string | null);
    if (!id) { setAutoApprove(false); setPermissionMode("default"); }
    if (id !== "claude") setSelectedChannels([]);
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
        goNext();
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

  // Wording helpers — playbook §8 "mode-conditional vocabulary".
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
          <button className="close-btn settings-close" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>x</button>
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

        {/* ── Step 1: cardinal mode picker ──────────────────────────── */}
        {step === "mode" && (
          <div className="session-creator-body">
            <SessionCreatorModeStep
              selected={mode}
              onSelect={(m) => setMode(m)}
            />
            <div className="session-creator-actions">
              <button
                className="session-creator-btn-primary"
                onClick={() => {
                  // Jump straight to the first content step for the chosen mode.
                  if (mode === "ssh") setStep("ssh");
                  else if (mode === "terminal") setStep("ai");
                  else setStep("projects");
                }}
              >
                {t("common.continue")}
              </button>
            </div>
          </div>
        )}

        {/* ── SSH connection form (mode=ssh) ────────────────────────── */}
        {step === "ssh" && mode === "ssh" && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">SSH</div>
            <div className="session-creator-ssh-deferred-note">
              Agent mode for remote sessions arrives in v1.1.
            </div>
            <div className="session-creator-ssh-fields">
              {sshSavedHosts.length > 0 && !sshHost && (
                <div className="session-creator-ssh-history">
                  <span className="session-creator-ssh-history-label">{t("session.saved")}</span>
                  <div className="session-creator-ssh-history-list">
                    {sshSavedHosts.map((h) => (
                      <button
                        key={h.id}
                        className="session-creator-ssh-history-item"
                        onClick={() => {
                          setSshHost(h.host);
                          setSshUser(h.user);
                          setSshPort(String(h.port));
                          setSshIdentityFile(h.identity_file || "");
                        }}
                      >
                        <span className="session-creator-ssh-history-host">
                          {h.label}
                        </span>
                        <span className="session-creator-ssh-history-port" style={{ opacity: 0.6 }}>
                          {h.user}@{h.host}{h.port !== 22 ? `:${h.port}` : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {sshHistory.length > 0 && !sshHost && (
                <div className="session-creator-ssh-history">
                  <span className="session-creator-ssh-history-label">{t("session.recent")}</span>
                  <div className="session-creator-ssh-history-list">
                    {sshHistory.map((h, i) => (
                      <button
                        key={`${h.host}-${h.user}-${h.port}-${i}`}
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
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <input
                ref={searchRef}
                className="command-palette-input"
                placeholder={t("session.sshHostPlaceholder")}
                value={sshHost}
                onChange={(e) => setSshHost(e.target.value)}
                autoComplete="off"
                autoFocus
              />
              <div className="session-creator-ssh-row">
                <input
                  className="command-palette-input session-creator-ssh-user"
                  placeholder={t("session.sshUserPlaceholder")}
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  autoComplete="off"
                />
                <input
                  className="command-palette-input session-creator-ssh-port"
                  placeholder={t("session.sshPortPlaceholder")}
                  value={sshPort}
                  onChange={(e) => setSshPort(e.target.value.replace(/\D/g, ""))}
                  autoComplete="off"
                />
              </div>
              <input
                className="command-palette-input"
                placeholder={t("session.sshIdentityFilePlaceholder")}
                value={sshIdentityFile}
                onChange={(e) => setSshIdentityFile(e.target.value)}
                autoComplete="off"
              />
              <input
                className="command-palette-input"
                placeholder={t("session.sshJumpHostPlaceholder")}
                value={sshJumpHost}
                onChange={(e) => setSshJumpHost(e.target.value)}
                autoComplete="off"
              />
              <span className="settings-hint-inline">{t("session.sshConfigHint")}</span>
              <label className="session-creator-save-host-label">
                <input
                  type="checkbox"
                  checked={saveAsHost}
                  onChange={(e) => setSaveAsHost(e.target.checked)}
                />
                Save this host
                {saveAsHost && (
                  <input
                    className="session-creator-save-host-name"
                    placeholder={t("session.sshLabelExample")}
                    value={saveHostLabel}
                    onChange={(e) => setSaveHostLabel(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    autoComplete="off"
                  />
                )}
              </label>
            </div>
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={goBack}>{t("common.back")}</button>
              <button
                className="session-creator-btn-primary"
                onClick={goNext}
                disabled={!sshHost.trim()}
              >
                {t("common.next")}
              </button>
            </div>
          </div>
        )}

        {/* ── Folder picker (agent + terminal modes) ────────────────── */}
        {step === "projects" && mode !== "ssh" && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">{folderSectionTitle}</div>
            <div className="session-creator-subtitle">{folderSubtitle}</div>
            <input
              ref={searchRef}
              className="command-palette-input"
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
              {filtered.map((project, idx) => (
                <div
                  key={project.id}
                  className={`project-picker-item ${selectedProjectIds.includes(project.id) ? "project-picker-item-attached" : ""} ${highlightedIndex === idx ? "session-creator-highlighted" : ""} ${"path_exists" in project && !project.path_exists ? "project-picker-item-missing" : ""}`}
                  onClick={() => {
                    if ("path_exists" in project && !project.path_exists) return;
                    toggleProject(project.id);
                  }}
                >
                  <span className="project-picker-check">
                    {"path_exists" in project && !project.path_exists
                      ? "(!)"
                      : isShellOnly
                        ? (selectedProjectIds.includes(project.id) ? "(*)" : "( )")
                        : (selectedProjectIds.includes(project.id) ? "[x]" : "[ ]")}
                  </span>
                  <div className="project-picker-info">
                    <div className="project-picker-name">
                      {project.name}
                      {!isShellOnly && selectedProjectIds[0] === project.id && selectedProjectIds.length > 0 && (
                        <span className="session-creator-cwd-badge">CWD</span>
                      )}
                    </div>
                    <div className="project-picker-path">{shortPath(project.path)}</div>
                    {"path_exists" in project && !project.path_exists && (
                      <div className="project-picker-missing-label">{t("session.folderNotFound")}</div>
                    )}
                    {(project.languages.length > 0 || project.frameworks.length > 0) && (
                      <div className="project-picker-tags">
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
                      </div>
                    )}
                  </div>
                  <button
                    className="session-creator-remove-btn"
                    onClick={(e) => { e.stopPropagation(); removeProject(project.id); }}
                    title="Remove folder"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
            <div className="project-picker-footer">
              <input
                className="workspace-scan-input"
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
              <button
                className="workspace-scan-btn"
                onClick={handleBrowse}
                disabled={scanning}
              >
                {scanning ? "..." : t("common.browse")}
              </button>
              <button
                className="workspace-scan-btn"
                onClick={() => scanNewPath(scanPath)}
                disabled={scanning || !scanPath.trim()}
              >
                {t("common.scan")}
              </button>
            </div>
            <div className="session-creator-hints">
              <span><kbd>&uarr;&darr;</kbd> {t("common.navigate")}</span>
              <span><kbd>Space</kbd> {isShellOnly ? t("common.select") : t("common.toggle")}</span>
              <span><kbd>Enter</kbd> {t("common.next")}</span>
              <span><kbd>Esc</kbd> {t("session.closeHint")}</span>
            </div>
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={goBack}>
                {t("common.back")}
              </button>
              <button className="session-creator-btn-secondary" onClick={() => { setSelectedProjectIds([]); goNext(); }}>
                {t("common.skip")}
              </button>
              <button
                className="session-creator-btn-primary"
                onClick={goNext}
                disabled={checkingGit}
              >
                {checkingGit ? t("common.checking") : isShellOnly
                  ? t("common.next")
                  : t("common.selectedCount", { count: selectedProjectIds.length })}
              </button>
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
                          onBranchSelected={(name, isNew, fromRemote) => {
                            setBranchSelections((prev) => ({
                              ...prev,
                              [projectId]: { branch: name, createNew: isNew, fromRemote },
                            }));
                          }}
                          onSkip={() => {
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
              <button className="session-creator-btn-secondary" onClick={goBack}>
                {t("common.back")}
              </button>
              <button className="session-creator-btn-secondary" onClick={handleBranchSkipped}>
                {t("session.continueWithoutIsolation")}
              </button>
              <button
                className="session-creator-btn-primary"
                onClick={goNext}
              >
                {t("common.continue")}
              </button>
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
              <div className="session-creator-list">
                {tmuxSessions.map((ts) => (
                  <div
                    key={ts.name}
                    className={`project-picker-item ${selectedTmuxSession === ts.name ? "project-picker-item-attached" : ""}`}
                    onClick={() => { setSelectedTmuxSession(ts.name); setShowNewTmuxInput(false); }}
                  >
                    <span className="project-picker-check">
                      {selectedTmuxSession === ts.name ? "[x]" : "[ ]"}
                    </span>
                    <div className="project-picker-info">
                      <div className="project-picker-name">{ts.name}</div>
                      <div className="project-picker-path">
                        {ts.windows} window{ts.windows !== 1 ? "s" : ""}
                        {ts.attached ? " (attached)" : ""}
                      </div>
                    </div>
                  </div>
                ))}
                {!showNewTmuxInput ? (
                  <div
                    className="project-picker-item"
                    onClick={() => { setShowNewTmuxInput(true); setNewTmuxSessionName(""); }}
                  >
                    <span className="project-picker-check" style={{ opacity: 0.5 }}>+</span>
                    <div className="project-picker-info">
                      <div className="project-picker-name">{t("session.newTmuxSession")}</div>
                      <div className="project-picker-path">{t("session.newTmuxSessionHint")}</div>
                    </div>
                  </div>
                ) : (
                  <div className="project-picker-item project-picker-item-attached">
                    <span className="project-picker-check">[x]</span>
                    <div className="project-picker-info" style={{ width: "100%" }}>
                      <input
                        className="command-palette-input"
                        autoFocus
                        placeholder="Session name..."
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
                    </div>
                  </div>
                )}
              </div>
              <span className="settings-hint-inline">
                tmux sessions persist on the server — reconnect anytime to pick up where you left off
              </span>
              </>
            )}
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={goBack}>
                Back
              </button>
              <button
                className="session-creator-btn-primary"
                onClick={goNext}
                disabled={tmuxLoading || !selectedTmuxSession}
              >
                {tmuxLoading ? "Discovering..." : "Next"}
              </button>
            </div>
          </div>
        )}

        {/* ── Provider picker (terminal mode only) ──────────────────── */}
        {step === "ai" && mode === "terminal" && (
          <div className="session-creator-body" ref={aiStepRef} tabIndex={-1} style={{ outline: "none" }}>
            <div className="session-creator-provider-grid">
              {AI_PROVIDERS.map((p) => {
                const providerIdx = enabledProviders.indexOf(p.id);
                const isAvailable = !availabilityLoaded || providerAvailability[p.id];
                return (
                  <button
                    key={p.id}
                    className={`session-creator-provider-card ${aiProvider === p.id ? "selected" : ""} ${highlightedProviderIndex === providerIdx ? "selected" : ""} ${availabilityLoaded && !isAvailable ? "session-creator-provider-unavailable" : ""}`}
                    onClick={() => { setAiProvider(p.id); setHighlightedProviderIndex(providerIdx); if (p.id !== "claude") setSelectedChannels([]); }}
                  >
                    <span className="session-creator-provider-name">
                      {p.label}
                      {availabilityLoaded && !isAvailable && (
                        <span className="session-creator-provider-status-badge">{t("session.notDetected")}</span>
                      )}
                    </span>
                    <span className="session-creator-provider-desc">{p.description}</span>
                    {availabilityLoaded && !isAvailable && (
                      <a
                        className="session-creator-provider-install-link"
                        onClick={(e) => { e.stopPropagation(); shellOpen(p.installUrl); }}
                      >
                        How to install
                      </a>
                    )}
                  </button>
                );
              })}
              <button
                className={`session-creator-provider-card ${aiProvider === null ? "selected" : ""} ${highlightedProviderIndex === enabledProviders.length - 1 ? "selected" : ""}`}
                onClick={() => { setAiProvider(null); setAutoApprove(false); setSelectedChannels([]); setHighlightedProviderIndex(enabledProviders.length - 1); }}
              >
                <span className="session-creator-provider-name">{t("session.plainShell")}</span>
                <span className="session-creator-provider-desc">{t("session.noAiAgent")}</span>
              </button>
            </div>
            {aiProvider && availabilityLoaded && !providerAvailability[aiProvider] && (
              <div className="session-creator-install-hint">
                <div className="session-creator-install-hint-title">
                  {t("session.cliNotDetected", { cli: getProviderInfo(aiProvider)?.label ?? aiProvider })}
                </div>
                <code className="session-creator-install-hint-cmd">{getProviderInfo(aiProvider)?.installCmd}</code>
                <div className="session-creator-install-hint-auth">{getProviderInfo(aiProvider)?.authHint}</div>
              </div>
            )}
            {aiProvider && (
              <div className="session-creator-permission-mode">
                <div className="session-creator-permission-mode-label">{t("session.approvalFlow")}</div>
                <div className="session-creator-permission-mode-pills">
                  {getAvailableModes(aiProvider).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`session-creator-permission-pill${permissionMode === m ? " session-creator-permission-pill-active" : ""}${m === "bypassPermissions" ? " session-creator-permission-pill-danger" : ""}`}
                      onClick={() => {
                        setPermissionMode(m);
                        setAutoApprove(m === "bypassPermissions");
                      }}
                    >
                      {permissionShortLabel(m)}
                    </button>
                  ))}
                </div>
                <div className="session-creator-permission-mode-info">
                  <span className="session-creator-permission-mode-desc">
                    {permissionDescription(permissionMode)}
                  </span>
                  {PERMISSION_MODE_FLAGS[aiProvider]?.[permissionMode]?.flag && (
                    <code className="session-creator-permission-mode-flag">
                      {PERMISSION_MODE_FLAGS[aiProvider][permissionMode]!.flag}
                    </code>
                  )}
                </div>
              </div>
            )}
            {aiProvider && (
              <div className="session-creator-custom-suffix">
                <div className="session-creator-custom-suffix-label">{t("session.prefixCommand")}</div>
                <input
                  type="text"
                  className="session-creator-custom-suffix-input"
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
                      <button
                        key={ex.value}
                        type="button"
                        className="session-creator-prefix-chip"
                        title={ex.hint}
                        onClick={() => setCustomPrefix(ex.value)}
                      >
                        {ex.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {aiProvider && (
              <div className="session-creator-custom-suffix">
                <div className="session-creator-custom-suffix-label">{t("session.customFlags")}</div>
                <input
                  type="text"
                  className="session-creator-custom-suffix-input"
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
            {aiProvider && (
              <div
                className="session-creator-launch-preview"
                aria-live="polite"
              >
                <span className="session-creator-launch-preview-label">{t("session.preview")}</span>
                <code className="session-creator-launch-preview-cmd">
                  {buildLaunchPreview(aiProvider, permissionMode, customPrefix, customSuffix)}
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
                    <label key={ch.id} className="session-creator-channel-item">
                      <input
                        type="checkbox"
                        checked={selectedChannels.includes(ch.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedChannels((prev) => [...prev, ch.id]);
                          } else {
                            setSelectedChannels((prev) => prev.filter((c) => c !== ch.id));
                          }
                        }}
                      />
                      <span className="session-creator-channel-icon">{ch.icon}</span>
                      <span className="session-creator-channel-name">{ch.label}</span>
                    </label>
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
              <button className="session-creator-btn-secondary" onClick={goBack}>
                {t("common.back")}
              </button>
              <button className="session-creator-btn-primary" onClick={goNext}>
                {t("common.next")}
              </button>
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
                    <span className="session-creator-summary-value">{sshUser ? `${sshUser}@` : ""}{sshHost}{sshPort !== "22" ? `:${sshPort}` : ""}</span>
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
                        ? t("mode.agent.label")
                        : aiProvider
                          ? AI_PROVIDERS.find((p) => p.id === aiProvider)?.label ?? aiProvider
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
            <input
              ref={labelRef}
              className="command-palette-input"
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
            <input
              className="command-palette-input"
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

            {mode !== "ssh" && (
              <div className="session-creator-worktree-override">
                <div className="settings-input-with-btn">
                  <input
                    className="command-palette-input"
                    placeholder="Worktree base path override (optional)"
                    value={worktreeBasePath}
                    onChange={(e) => setWorktreeBasePath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !creating) handleConfirm();
                    }}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  <button
                    className="session-creator-btn-browse"
                    onClick={async () => {
                      const selected = await open({
                        directory: true,
                        multiple: false,
                        title: "Select Worktree Base Directory",
                      });
                      if (selected && typeof selected === "string") {
                        setWorktreeBasePath(selected);
                      }
                    }}
                  >
                    Browse
                  </button>
                </div>
                <div className="session-creator-hint">
                  Default: {selectedProjectIds.length > 0 && allProjects.find(p => p.id === selectedProjectIds[0])?.worktree_base_path ? "Project base" : "App data"}
                </div>
              </div>
            )}

            {/* Inline project assignment */}
            <div className="session-creator-project-picker">
              <span className="session-creator-project-picker-label">{t("session.project")}</span>
              <div className="session-creator-project-chips">
                <button
                  className={`session-creator-project-chip ${selectedGroup === null ? "selected" : ""}`}
                  onClick={() => setSelectedGroup(null)}
                >
                  {t("common.none")}
                </button>
                {existingGroups.map((group) => (
                  <button
                    key={group}
                    className={`session-creator-project-chip ${selectedGroup === group ? "selected" : ""}`}
                    onClick={() => { setSelectedGroup(group); if (groupColors[group]) setSelectedColor(groupColors[group]); }}
                  >
                    {groupColors[group] && (
                      <span className="session-creator-project-chip-dot" style={{ background: groupColors[group] }} />
                    )}
                    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
                      <path d="M2 5C2 3.9 2.9 3 4 3H7L9 5H14C15.1 5 16 5.9 16 7V13C16 14.1 15.1 15 14 15H4C2.9 15 2 14.1 2 13V5Z" />
                    </svg>
                    {group}
                  </button>
                ))}
                {!showNewProjectInput ? (
                  <button
                    className="session-creator-project-chip session-creator-project-chip-new"
                    onClick={() => { setShowNewProjectInput(true); setNewProjectName(""); }}
                  >
                    {t("session.newProject")}
                  </button>
                ) : (
                  <input
                    className="session-creator-project-chip-input"
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
              <div className="session-creator-color-swatches">
                <button
                  className={`session-creator-color-swatch session-creator-color-swatch-none ${selectedColor === "" ? "selected" : ""}`}
                  onClick={() => setSelectedColor("")}
                  title="No color"
                >
                  <svg viewBox="0 0 16 16" width="10" height="10" stroke="currentColor" strokeWidth="2" fill="none">
                    <line x1="2" y1="2" x2="14" y2="14" />
                  </svg>
                </button>
                {SESSION_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`session-creator-color-swatch ${selectedColor === c ? "selected" : ""}`}
                    style={{ background: c }}
                    onClick={() => setSelectedColor(c)}
                    title={c}
                  />
                ))}
              </div>
            </div>

            {/* Channels (agent mode shows them here too — playbook §6 spec) */}
            {mode === "agent" && (
              <div className="session-creator-channels">
                <div className="session-creator-channels-label">{t("session.channels")}</div>
                <div className="session-creator-channels-desc">
                  {t("session.channelsHint")}
                </div>
                <div className="session-creator-channels-list">
                  {CLAUDE_CHANNELS.map((ch) => (
                    <label key={ch.id} className="session-creator-channel-item">
                      <input
                        type="checkbox"
                        checked={selectedChannels.includes(ch.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedChannels((prev) => [...prev, ch.id]);
                          } else {
                            setSelectedChannels((prev) => prev.filter((c) => c !== ch.id));
                          }
                        }}
                      />
                      <span className="session-creator-channel-icon">{ch.icon}</span>
                      <span className="session-creator-channel-name">{ch.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="session-creator-hints">
              <span><kbd>Enter</kbd> {t("session.createHint")}</span>
              <span><kbd>Esc</kbd> {t("session.closeHint")}</span>
            </div>
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={goBack}>
                {t("common.back")}
              </button>
              <button
                className="session-creator-btn-primary"
                onClick={handleConfirm}
                disabled={creating}
              >
                {creating ? t("common.creating") : t("session.createSession")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
