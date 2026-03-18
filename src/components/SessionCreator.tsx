import "../styles/components/SessionCreator.css";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Project } from "../hooks/useSessionProjects";
import { CreateSessionOpts } from "../state/SessionContext";
import { getProjects, createProject, deleteProject } from "../api/projects";
import { getSessions, sshListTmuxSessions } from "../api/sessions";
import { getSetting, setSetting } from "../api/settings";
import { listSshSavedHosts, upsertSshSavedHost, type SshSavedHost } from "../api/ssh";
import type { TmuxSessionEntry } from "../types/session";
import { isGitRepo as checkIsGitRepo } from "../api/git";
import { LANG_COLORS } from "../utils/langColors";
import { SessionBranchSelector } from "./SessionBranchSelector";
import { SESSION_COLORS } from "./SessionList";

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

const AI_PROVIDERS = [
  { id: "claude", label: "Claude", description: "Claude Code CLI", enabled: true },
  { id: "gemini", label: "Gemini", description: "Google Gemini CLI", enabled: true },
  { id: "aider", label: "Aider", description: "Aider AI pair programming", enabled: true },
  { id: "codex", label: "Codex", description: "OpenAI Codex CLI", enabled: true },
  { id: "copilot", label: "Copilot", description: "GitHub Copilot CLI", enabled: true },
] as const;

const AUTO_APPROVE_FLAGS: Record<string, { flag: string; description: string }> = {
  claude: { flag: "--dangerously-skip-permissions", description: "The AI agent can read, write, and execute without asking for confirmation." },
  gemini: { flag: "--yolo", description: "The AI agent can execute shell commands and write files without permission prompts." },
  aider: { flag: "--yes", description: "The AI agent will apply all suggested changes without asking for confirmation." },
  codex: { flag: "--full-auto", description: "The AI agent runs in fully autonomous mode without confirmation prompts." },
};

// Internal step identifiers (not displayed to user)
type Step = "projects" | "branch" | "ai" | "tmux" | "confirm";

interface SessionCreatorProps {
  onClose: () => void;
  onCreate: (opts: CreateSessionOpts) => Promise<void>;
  /** Pre-select a project group when creating from a project's "+" button */
  defaultGroup?: string;
}

export function SessionCreator({ onClose, onCreate, defaultGroup }: SessionCreatorProps) {
  const [step, setStep] = useState<Step>("ai");
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [scanPath, setScanPath] = useState("");
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [highlightedProviderIndex, setHighlightedProviderIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const aiStepRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  // Live New Session box size state (persisted separately from the window size)
  const [panelWidth, setPanelWidth] = useState<number>(480);
  const [panelHeight, setPanelHeight] = useState<number>(620);
  const latestPanelWidthRef = useRef(panelWidth);
  const latestPanelHeightRef = useRef(panelHeight);
  const resizingRef = useRef(false);
  const panelPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeListenersRef = useRef<{
    onMove: (event: MouseEvent) => void;
    onUp: () => void;
  } | null>(null);
  const resizeBodyStylesRef = useRef<{ cursor: string; userSelect: string }>({
    cursor: "",
    userSelect: "",
  });

  // Project (group) assignment state
  const [selectedGroup, setSelectedGroup] = useState<string | null>(defaultGroup ?? null);
  const [newProjectName, setNewProjectName] = useState("");
  const [showNewProjectInput, setShowNewProjectInput] = useState(false);

  // Connection type state (local or SSH remote)
  const [connectionType, setConnectionType] = useState<"local" | "ssh">("local");
  const [sshHost, setSshHost] = useState("");
  const [sshUser, setSshUser] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshHistory, setSshHistory] = useState<SshHistoryEntry[]>([]);
  const [sshSavedHosts, setSshSavedHosts] = useState<SshSavedHost[]>([]);

  // Identity file and jump host
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

  // Color selection state — no color by default
  const [selectedColor, setSelectedColor] = useState<string>("");

  // Auto-approve (skip permissions) state
  const [autoApprove, setAutoApprove] = useState(false);

  // Branch selection state — per-project
  type BranchSelection = { branch: string; createNew: boolean };
  const [gitRealmIds, setGitRealmIds] = useState<string[]>([]);
  const [checkingGit, setCheckingGit] = useState(false);
  const [branchSelections, setBranchSelections] = useState<Record<string, BranchSelection>>({});
  const [expandedRealmId, setExpandedRealmId] = useState<string | null>(null);

  // Auto-expand first git project only when first entering the branch step
  const prevStepRef = useRef(step);
  useEffect(() => {
    if (step === "branch" && prevStepRef.current !== "branch" && gitRealmIds.length > 0) {
      const firstGit = selectedProjectIds.find((id) => gitRealmIds.includes(id));
      if (firstGit) setExpandedRealmId(firstGit);
    }
    prevStepRef.current = step;
  }, [step, gitRealmIds, selectedProjectIds]);

  // Auto-advance to the next unselected git project when branchSelections changes
  useEffect(() => {
    if (step !== 'branch') return;
    const nextUnselected = selectedProjectIds.find(
      (id) => gitRealmIds.includes(id) && !branchSelections[id]
    );
    if (nextUnselected) {
      setExpandedRealmId(nextUnselected);
    } else if (Object.keys(branchSelections).length > 0 && selectedProjectIds.every(
      (id) => !gitRealmIds.includes(id) || branchSelections[id]
    )) {
      // All git projects have selections — collapse
      setExpandedRealmId(null);
    }
  }, [branchSelections, step, selectedProjectIds, gitRealmIds]);

  // Determine whether to show the branch step
  const showBranchStep = gitRealmIds.length > 0 && selectedProjectIds.length > 0;

  // Existing project groups (from current sessions) with their colors
  const [existingGroups, setExistingGroups] = useState<string[]>([]);
  const [groupColors, setGroupColors] = useState<Record<string, string>>({});

  // Compute ordered steps for display
  const orderedSteps = useMemo<Step[]>(() => {
    if (connectionType === "ssh") return ["projects", "tmux", "confirm"];
    const steps: Step[] = ["ai", "projects"];
    if (showBranchStep) steps.push("branch");
    steps.push("confirm");
    return steps;
  }, [showBranchStep, connectionType]);

  // Navigate to first step when connection type changes
  const prevConnectionRef = useRef(connectionType);
  useEffect(() => {
    if (prevConnectionRef.current !== connectionType) {
      prevConnectionRef.current = connectionType;
      setStep(connectionType === "ssh" ? "projects" : "ai");
    }
  }, [connectionType]);

  // Truncate project selection when switching to Shell Only
  const isShellOnly = aiProvider === null;
  useEffect(() => {
    if (isShellOnly && selectedProjectIds.length > 1) {
      setSelectedProjectIds((prev) => prev.slice(0, 1));
    }
  }, [isShellOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalSteps = orderedSteps.length;
  const currentStepNumber = orderedSteps.indexOf(step) + 1;

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

  useEffect(() => {
    getProjects()
      .then((r) => setAllProjects(r))
      .catch((err) => console.warn("[SessionCreator] Failed to load projects:", err));
    getSetting(SSH_HISTORY_KEY)
      .then((json) => {
        const history = parseSshHistory(json);
        console.log("[SessionCreator] Loaded SSH history:", history.length, "entries");
        setSshHistory(history);
      })
      .catch((err) => console.warn("[SessionCreator] Failed to load SSH history:", err));
    listSshSavedHosts()
      .then(setSshSavedHosts)
      .catch((err) => console.warn("[SessionCreator] Failed to load saved SSH hosts:", err));
    getSessions()
      .then((sessions) => {
        const groups = [...new Set(sessions.map((s) => s.group).filter((g): g is string => !!g))].sort();
        setExistingGroups(groups);
        // Build group→color map (use first non-destroyed session's color)
        const colors: Record<string, string> = {};
        for (const g of groups) {
          const groupSession = sessions.find((s) => s.group === g && s.phase !== "destroyed")
            || sessions.find((s) => s.group === g);
          if (groupSession) colors[g] = groupSession.color;
        }
        setGroupColors(colors);
        // Pre-select color for defaultGroup
        if (defaultGroup && colors[defaultGroup]) {
          setSelectedColor(colors[defaultGroup]);
        }
      })
      .catch((err) => console.warn("[SessionCreator] Failed to load sessions:", err));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    latestPanelWidthRef.current = panelWidth;
  }, [panelWidth]);

  useEffect(() => {
    latestPanelHeightRef.current = panelHeight;
  }, [panelHeight]);

  const detachResizeSideEffects = useCallback(() => {
    if (resizeListenersRef.current) {
      document.removeEventListener("mousemove", resizeListenersRef.current.onMove);
      document.removeEventListener("mouseup", resizeListenersRef.current.onUp);
      resizeListenersRef.current = null;
    }

    document.body.style.cursor = resizeBodyStylesRef.current.cursor;
    document.body.style.userSelect = resizeBodyStylesRef.current.userSelect;
  }, []);

  useEffect(() => {
    return () => {
      if (panelPersistTimerRef.current) clearTimeout(panelPersistTimerRef.current);
      if (resizeResetTimerRef.current) clearTimeout(resizeResetTimerRef.current);
      detachResizeSideEffects();
      resizingRef.current = false;
    };
  }, [detachResizeSideEffects]);

  useEffect(() => {
    // Restore persisted panel size (if available)
    const read = async () => {
      try {
        const rawW = parseInt(await getSetting("session_creator_panel_width"), 10);
        const rawH = parseInt(await getSetting("session_creator_panel_height"), 10);

        const minW = 380;
        const minH = 360;
        const maxW = Math.max(minW, Math.floor(window.innerWidth * 0.92));
        const maxH = Math.max(minH, Math.floor(window.innerHeight * 0.78));

        if (!Number.isNaN(rawW) && rawW >= minW) setPanelWidth(Math.min(rawW, maxW));
        if (!Number.isNaN(rawH) && rawH >= minH) setPanelHeight(Math.min(rawH, maxH));
      } catch {
        // ignore: settings may not exist yet
      }
    };
    read();
  }, []);

  const persistPanelSize = useCallback((w: number, h: number) => {
    if (panelPersistTimerRef.current) clearTimeout(panelPersistTimerRef.current);
    panelPersistTimerRef.current = setTimeout(() => {
      setSetting("session_creator_panel_width", String(Math.round(w))).catch(console.error);
      setSetting("session_creator_panel_height", String(Math.round(h))).catch(console.error);
    }, 120);
  }, []);

  const onResizeWidthStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;

    const startX = e.clientX;
    const startW = latestPanelWidthRef.current;
    const minW = 380;
    const maxW = Math.max(minW, Math.floor(window.innerWidth * 0.92));

    detachResizeSideEffects();
    resizeBodyStylesRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const nextW = Math.max(minW, Math.min(maxW, startW + delta));
      setPanelWidth(nextW);
    };

    const onUp = () => {
      const w = latestPanelWidthRef.current;
      const h = latestPanelHeightRef.current;
      persistPanelSize(w, h);
      detachResizeSideEffects();

      // Delay clearing so an "outside click" caused by mouseup doesn't close the overlay.
      if (resizeResetTimerRef.current) clearTimeout(resizeResetTimerRef.current);
      resizeResetTimerRef.current = setTimeout(() => { resizingRef.current = false; }, 80);
    };

    resizeListenersRef.current = { onMove, onUp };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [detachResizeSideEffects, persistPanelSize]);

  const onResizeHeightStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizingRef.current = true;

    const startY = e.clientY;
    const startH = latestPanelHeightRef.current;
    const minH = 360;
    const maxH = Math.max(minH, Math.floor(window.innerHeight * 0.78));

    detachResizeSideEffects();
    resizeBodyStylesRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      const nextH = Math.max(minH, Math.min(maxH, startH + delta));
      setPanelHeight(nextH);
    };

    const onUp = () => {
      const w = latestPanelWidthRef.current;
      const h = latestPanelHeightRef.current;
      persistPanelSize(w, h);
      detachResizeSideEffects();

      if (resizeResetTimerRef.current) clearTimeout(resizeResetTimerRef.current);
      resizeResetTimerRef.current = setTimeout(() => { resizingRef.current = false; }, 80);
    };

    resizeListenersRef.current = { onMove, onUp };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [detachResizeSideEffects, persistPanelSize]);

  // Discover tmux sessions when entering the tmux step.
  // If tmux is not installed, skip straight to confirm.
  useEffect(() => {
    if (step !== "tmux" || !sshHost.trim()) return;
    setTmuxLoading(true);
    setTmuxError(null);
    setTmuxAvailable(true);
    sshListTmuxSessions(sshHost.trim(), parseInt(sshPort) || 22, sshUser || undefined)
      .then((sessions) => {
        console.log("[SessionCreator] Discovered tmux sessions:", sessions);
        setTmuxSessions(sessions);
        setTmuxLoading(false);
      })
      .catch((err) => {
        console.warn("[SessionCreator] tmux discovery failed:", err);
        const msg = String(err);
        if (msg.includes("not installed")) {
          // tmux not available — skip this step entirely
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
      const allItems = [...AI_PROVIDERS.filter((p) => p.enabled), { id: null }] as const;
      const currentIdx = allItems.findIndex((p) => p.id === aiProvider);
      setHighlightedProviderIndex(currentIdx >= 0 ? currentIdx : allItems.length - 1);
    }
    if (step === "confirm") {
      labelRef.current?.focus();
      setShowNewProjectInput(false);
    }
  }, [step]);

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
      setGitRealmIds([]);
      setBranchSelections({});
      return;
    }
    let cancelled = false;
    setCheckingGit(true);
    Promise.all(
      selectedProjectIds.map((realmId) =>
        checkIsGitRepo(realmId)
          .then((isGit) => ({ realmId, isGit }))
          .catch(() => ({ realmId, isGit: false }))
      )
    )
      .then((results) => {
        if (cancelled) return;
        const gitIds = results.filter((r) => r.isGit).map((r) => r.realmId);
        setGitRealmIds(gitIds);
        // Remove branch selections for projects no longer selected or no longer git repos
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
      // Shell Only: single-select (replace)
      if (isShellOnly) return [id];
      // AI session: multi-select (append)
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
      setAllProjects((prev) => [project, ...prev.filter((r) => r.id !== project.id)]);
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
      await onCreate({
        label: label || (connectionType === "ssh" ? sshLabel : undefined),
        description: description || undefined,
        group: selectedGroup || undefined,
        color: selectedColor,
        aiProvider: connectionType === "local" ? (aiProvider || undefined) : undefined,
        autoApprove: connectionType === "local" ? (autoApprove || undefined) : undefined,
        projectIds: connectionType === "local" && selectedProjectIds.length > 0 ? selectedProjectIds : undefined,
        workingDirectory: connectionType === "local" ? firstProjectPath : undefined,
        branchSelections: connectionType === "local" && Object.keys(branchSelections).length > 0 ? branchSelections : undefined,
        sshHost: connectionType === "ssh" ? sshHost : undefined,
        sshPort: connectionType === "ssh" ? (parseInt(sshPort) || 22) : undefined,
        sshUser: connectionType === "ssh" ? (sshUser || undefined) : undefined,
        tmuxSession: connectionType === "ssh" ? (selectedTmuxSession || undefined) : undefined,
        sshIdentityFile: connectionType === "ssh" ? (sshIdentityFile || undefined) : undefined,
      });
      // Save SSH connection to history
      if (connectionType === "ssh" && sshHost.trim()) {
        const entry: SshHistoryEntry = {
          host: sshHost.trim(),
          user: sshUser.trim() || "",
          port: parseInt(sshPort) || 22,
          lastUsed: new Date().toISOString(),
        };
        const updated = addToSshHistory(sshHistory, entry);
        console.log("[SessionCreator] Saving SSH history:", updated.length, "entries");
        setSetting(SSH_HISTORY_KEY, JSON.stringify(updated))
          .catch((err) => console.warn("[SessionCreator] Failed to save SSH history:", err));

        // Save as a saved host if requested
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
    () => [...AI_PROVIDERS.filter((p) => p.enabled).map((p) => p.id), null] as const,
    []
  );

  const selectProviderAndAdvance = (idx: number) => {
    const id = enabledProviders[idx] ?? null;
    setAiProvider(id as string | null);
    if (!id || !AUTO_APPROVE_FLAGS[id]) setAutoApprove(false);
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

  return (
    <div
      className="command-palette-overlay"
      onClick={() => { if (resizingRef.current) return; onClose(); }}
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
          <span className="session-creator-title">New Session</span>
          <span className="session-creator-step">Step {currentStepNumber} of {totalSteps}</span>
          <button className="close-btn settings-close" onClick={onClose} title="Close" aria-label="Close">x</button>
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

        {/* Step 1: Select Projects */}
        {step === "projects" && (
          <div className="session-creator-body">
            {connectionType === "ssh" && (
              <div className="session-creator-connection-type">
                <button
                  className="session-creator-type-btn"
                  onClick={() => setConnectionType("local")}
                >Local</button>
                <button
                  className="session-creator-type-btn session-creator-type-active"
                  onClick={() => setConnectionType("ssh")}
                >SSH Remote <span className="session-creator-alpha-tag">Alpha</span></button>
              </div>
            )}

            {connectionType === "ssh" && (
              <div className="session-creator-ssh-fields">
                {sshSavedHosts.length > 0 && !sshHost && (
                  <div className="session-creator-ssh-history">
                    <span className="session-creator-ssh-history-label">Saved</span>
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
                    <span className="session-creator-ssh-history-label">Recent</span>
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
                  placeholder="Host (e.g. 192.168.1.100 or myserver.com)"
                  value={sshHost}
                  onChange={(e) => setSshHost(e.target.value)}
                  autoComplete="off"
                  autoFocus
                />
                <div className="session-creator-ssh-row">
                  <input
                    className="command-palette-input session-creator-ssh-user"
                    placeholder="User (default: current user)"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    autoComplete="off"
                  />
                  <input
                    className="command-palette-input session-creator-ssh-port"
                    placeholder="Port"
                    value={sshPort}
                    onChange={(e) => setSshPort(e.target.value.replace(/\D/g, ""))}
                    autoComplete="off"
                  />
                </div>
                <input
                  className="command-palette-input"
                  placeholder="Identity file (optional, e.g. ~/.ssh/id_rsa)"
                  value={sshIdentityFile}
                  onChange={(e) => setSshIdentityFile(e.target.value)}
                  autoComplete="off"
                />
                <input
                  className="command-palette-input"
                  placeholder="Jump host (optional, e.g. bastion.example.com)"
                  value={sshJumpHost}
                  onChange={(e) => setSshJumpHost(e.target.value)}
                  autoComplete="off"
                />
                <span className="settings-hint-inline">Uses your system SSH config and agent for authentication</span>
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
                      placeholder="Label (e.g. My Server)"
                      value={saveHostLabel}
                      onChange={(e) => setSaveHostLabel(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      autoComplete="off"
                    />
                  )}
                </label>
              </div>
            )}

            {connectionType === "local" && <>
            <div className="session-creator-section-title">
              {isShellOnly ? "Working Directory" : "Select Folders"}
            </div>
            <div className="session-creator-subtitle">
              {isShellOnly
                ? "Your shell will open in this folder."
                : "The AI can work across all selected folders. The first folder is the working directory."}
            </div>
            <input
              ref={searchRef}
              className="command-palette-input"
              placeholder="Filter folders..."
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
                  No folders found. Scan a directory below to add one.
                </div>
              )}
              {filtered.length === 0 && query && (
                <div className="command-palette-empty">
                  No folders matching &ldquo;{query}&rdquo;
                </div>
              )}
              {filtered.map((project, idx) => (
                <div
                  key={project.id}
                  className={`project-picker-item ${selectedProjectIds.includes(project.id) ? "project-picker-item-attached" : ""} ${highlightedIndex === idx ? "session-creator-highlighted" : ""}`}
                  onClick={() => toggleProject(project.id)}
                >
                  <span className="project-picker-check">
                    {isShellOnly
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
                placeholder="Path or browse..."
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
                {scanning ? "..." : "Browse"}
              </button>
              <button
                className="workspace-scan-btn"
                onClick={() => scanNewPath(scanPath)}
                disabled={scanning || !scanPath.trim()}
              >
                Scan
              </button>
            </div>
            <div className="session-creator-hints">
              <span><kbd>&uarr;&darr;</kbd> navigate</span>
              <span><kbd>Space</kbd> {isShellOnly ? "select" : "toggle"}</span>
              <span><kbd>Enter</kbd> next</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={goBack}>
                Back
              </button>
              <button className="session-creator-btn-secondary" onClick={() => { setSelectedProjectIds([]); goNext(); }}>
                Skip
              </button>
              <button
                className="session-creator-btn-primary"
                onClick={goNext}
                disabled={checkingGit}
              >
                {checkingGit ? "Checking..." : isShellOnly
                  ? "Next"
                  : `Next (${selectedProjectIds.length} selected)`}
              </button>
            </div>
            </>}

            {connectionType === "ssh" && (
              <div className="session-creator-actions">
                <button
                  className="session-creator-btn-primary"
                  onClick={goNext}
                  disabled={!sshHost.trim()}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 2 (conditional): Select Branch — per-project */}
        {step === "branch" && gitRealmIds.length > 0 && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">Select Branches</div>
            <div className="session-creator-branch-multi">
              {selectedProjectIds.map((realmId) => {
                const isGit = gitRealmIds.includes(realmId);
                const realmName = allProjects.find((r) => r.id === realmId)?.name || realmId;
                const isExpanded = expandedRealmId === realmId;

                if (!isGit) {
                  return (
                    <div key={realmId} className="session-creator-branch-realm">
                      <div className="session-creator-branch-realm-header">
                        <span className="session-creator-branch-realm-name">{realmName}</span>
                        <span className="session-creator-branch-nonGit">Not a git repository</span>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={realmId} className={`session-creator-branch-realm ${isExpanded ? "expanded" : ""}`}>
                    <div
                      className="session-creator-branch-realm-header"
                      onClick={() => setExpandedRealmId(isExpanded ? null : realmId)}
                      style={{ cursor: "pointer" }}
                    >
                      <span className="session-creator-branch-realm-chevron">{isExpanded ? "\u25BC" : "\u25B6"}</span>
                      <span className="session-creator-branch-realm-name">{realmName}</span>
                      {branchSelections[realmId] && (
                        <span className="session-creator-branch-selected-label">
                          {branchSelections[realmId].branch}
                          {branchSelections[realmId].createNew ? " (new)" : ""}
                        </span>
                      )}
                    </div>
                    {isExpanded && (
                      <SessionBranchSelector
                        realmId={realmId}
                        onBranchSelected={(name, isNew) => {
                          setBranchSelections((prev) => ({
                            ...prev,
                            [realmId]: { branch: name, createNew: isNew },
                          }));
                        }}
                        onSkip={() => {
                          setBranchSelections((prev) => {
                            const next = { ...prev };
                            delete next[realmId];
                            return next;
                          });
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={goBack}>
                Back
              </button>
              <button className="session-creator-btn-secondary" onClick={handleBranchSkipped}>
                Skip branches
              </button>
              <button
                className="session-creator-btn-primary"
                onClick={goNext}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Tmux session picker (SSH only) */}
        {step === "tmux" && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">tmux Sessions</div>
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
                {/* Create new tmux session */}
                {!showNewTmuxInput ? (
                  <div
                    className="project-picker-item"
                    onClick={() => { setShowNewTmuxInput(true); setNewTmuxSessionName(""); }}
                  >
                    <span className="project-picker-check" style={{ opacity: 0.5 }}>+</span>
                    <div className="project-picker-info">
                      <div className="project-picker-name">New tmux session</div>
                      <div className="project-picker-path">Create a new persistent session</div>
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
                          // Keep selectedTmuxSession in sync so Next is enabled
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

        {/* Step 3: Pick AI Engine */}
        {step === "ai" && (
          <div className="session-creator-body" ref={aiStepRef} tabIndex={-1} style={{ outline: "none" }}>
            <div className="session-creator-connection-type">
              <button
                className={`session-creator-type-btn ${connectionType === "local" ? "session-creator-type-active" : ""}`}
                onClick={() => setConnectionType("local")}
              >Local</button>
              <button
                className={`session-creator-type-btn ${connectionType === "ssh" ? "session-creator-type-active" : ""}`}
                onClick={() => setConnectionType("ssh")}
              >SSH Remote <span className="session-creator-alpha-tag">Alpha</span></button>
            </div>
            <div className="session-creator-section-title">Session Type</div>
            <div className="session-creator-provider-grid">
              {AI_PROVIDERS.map((p) => {
                const providerIdx = enabledProviders.indexOf(p.id);
                return (
                  <button
                    key={p.id}
                    className={`session-creator-provider-card ${aiProvider === p.id ? "selected" : ""} ${!p.enabled ? "disabled" : ""} ${p.enabled && highlightedProviderIndex === providerIdx ? "selected" : ""}`}
                    onClick={() => { if (p.enabled) { setAiProvider(p.id); setHighlightedProviderIndex(providerIdx); } }}
                    disabled={!p.enabled}
                  >
                    <span className="session-creator-provider-name">{p.label}</span>
                    <span className="session-creator-provider-desc">
                      {p.enabled ? p.description : "Coming soon"}
                    </span>
                  </button>
                );
              })}
              <button
                className={`session-creator-provider-card ${aiProvider === null ? "selected" : ""} ${highlightedProviderIndex === enabledProviders.length - 1 ? "selected" : ""}`}
                onClick={() => { setAiProvider(null); setAutoApprove(false); setHighlightedProviderIndex(enabledProviders.length - 1); }}
              >
                <span className="session-creator-provider-name">Shell Only</span>
                <span className="session-creator-provider-desc">No AI agent</span>
              </button>
            </div>
            {aiProvider && AUTO_APPROVE_FLAGS[aiProvider] && (
              <label className="session-creator-auto-approve">
                <input
                  type="checkbox"
                  checked={autoApprove}
                  onChange={(e) => setAutoApprove(e.target.checked)}
                />
                <div className="session-creator-auto-approve-text">
                  <span className="session-creator-auto-approve-label">
                    Auto-approve all actions
                    <code>{AUTO_APPROVE_FLAGS[aiProvider].flag}</code>
                  </span>
                  <span className="session-creator-auto-approve-desc">
                    {AUTO_APPROVE_FLAGS[aiProvider].description}
                  </span>
                </div>
              </label>
            )}
            <div className="session-creator-hints">
              <span><kbd>&uarr;&darr;</kbd><kbd>&larr;&rarr;</kbd> navigate</span>
              <span><kbd>Enter</kbd> select</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
            <div className="session-creator-actions">
              {orderedSteps.indexOf("ai") > 0 && (
                <button className="session-creator-btn-secondary" onClick={goBack}>
                  Back
                </button>
              )}
              <button className="session-creator-btn-primary" onClick={goNext}>
                Next
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Confirm */}
        {step === "confirm" && (
          <div className="session-creator-body">
            <div className="session-creator-section-title">Confirm</div>
            <div className="session-creator-summary">
              {connectionType === "ssh" ? (
                <>
                  <div className="session-creator-summary-row">
                    <span className="session-creator-summary-label">Connection:</span>
                    <span className="session-creator-summary-value">SSH Remote</span>
                  </div>
                  <div className="session-creator-summary-row">
                    <span className="session-creator-summary-label">Host:</span>
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
                    <span className="session-creator-summary-label">{isShellOnly ? "Folder:" : "Folders:"}</span>
                    <span className="session-creator-summary-value">
                      {selectedProjectNames.length > 0 ? selectedProjectNames.join(", ") : "None"}
                    </span>
                  </div>
                  {Object.keys(branchSelections).length > 0 && (
                    <div className="session-creator-summary-row">
                      <span className="session-creator-summary-label">{Object.keys(branchSelections).length === 1 ? "Branch:" : "Branches:"}</span>
                      <span className="session-creator-summary-value">
                        {Object.entries(branchSelections).map(([realmId, sel], idx) => {
                          const name = allProjects.find((r) => r.id === realmId)?.name || realmId;
                          return (
                            <span key={realmId}>
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
                    <span className="session-creator-summary-label">{isShellOnly ? "Type:" : "AI Engine:"}</span>
                    <span className="session-creator-summary-value">
                      {aiProvider ? AI_PROVIDERS.find((p) => p.id === aiProvider)?.label ?? aiProvider : "Shell Only"}
                      {autoApprove && aiProvider && AUTO_APPROVE_FLAGS[aiProvider] && (
                        <span className="session-creator-summary-flag"> (auto-approve)</span>
                      )}
                    </span>
                  </div>
                </>
              )}
            </div>
            <input
              ref={labelRef}
              className="command-palette-input"
              placeholder="Session name (optional)"
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
              placeholder="Description (optional)"
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
              <span className="session-creator-project-picker-label">Project</span>
              <div className="session-creator-project-chips">
                <button
                  className={`session-creator-project-chip ${selectedGroup === null ? "selected" : ""}`}
                  onClick={() => setSelectedGroup(null)}
                >
                  None
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
                    + New
                  </button>
                ) : (
                  <input
                    className="session-creator-project-chip-input"
                    autoFocus
                    placeholder="Project name..."
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter" && newProjectName.trim()) {
                        const name = newProjectName.trim();
                        if (!existingGroups.includes(name)) {
                          setExistingGroups((prev) => [...prev, name].sort());
                        }
                        // Assign current color to the new project
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
              <span className="session-creator-color-picker-label">Color</span>
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

            <div className="session-creator-hints">
              <span><kbd>Enter</kbd> create</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
            <div className="session-creator-actions">
              <button className="session-creator-btn-secondary" onClick={goBack}>
                Back
              </button>
              <button
                className="session-creator-btn-primary"
                onClick={handleConfirm}
                disabled={creating}
              >
                {creating ? "Creating..." : "Create Session"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
