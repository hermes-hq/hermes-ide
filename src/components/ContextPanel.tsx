import "../styles/components/ContextPanel.css";
import React, { useState, useCallback, useMemo, useEffect, useRef, memo } from "react";
import { fmt } from "../utils/platform";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { SessionData, useExecutionMode, useSession } from "../state/SessionContext";
import { addWorkspacePath as apiAddWorkspacePath } from "../api/sessions";
import { getSessionProjects } from "../api/projects";
import { addContextPin, removeContextPin } from "../api/context";
import { getAllMemory, saveMemory, deleteMemory } from "../api/memory";
import { useFileTree, FileTreeNode } from "../hooks/useFileTree";
import { useContextState } from "../hooks/useContextState";
import { ContextStatusBar } from "./ContextStatusBar";
import { ContextPreview } from "./ContextPreview";
import type { PersistedMemory } from "../types";

interface ContextPanelProps {
  session: SessionData;
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

const Sparkline = memo(function Sparkline({ data, color, width = 120, height = 24 }: { data: number[]; color: string; width?: number; height?: number }) {
  if (data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg width={width} height={height} className="sparkline">
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  );
});

function ToolBar({ tool, count, maxCount }: { tool: string; count: number; maxCount: number }) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
  return (
    <div className="ctx-tool-row">
      <span className="ctx-tool-name">{tool}</span>
      <div className="ctx-tool-bar-track">
        <div className="ctx-tool-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="ctx-tool-count mono">{count}</span>
    </div>
  );
}

// File Tree component (F5)
function FileTreeView({ nodes, onPin }: { nodes: FileTreeNode[]; onPin: (path: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const render = (nodes: FileTreeNode[], depth: number): React.JSX.Element[] => {
    return nodes.map((node) => {
      if (node.isFile) {
        return (
          <div key={node.path} className="ctx-file-tree-file" style={{ paddingLeft: depth * 12 }}>
            <span className="ctx-file mono truncate">{node.name}</span>
            <button className="ctx-pin-btn" onClick={() => onPin(node.path)} title="Pin file">pin</button>
          </div>
        );
      }
      const isOpen = !collapsed.has(node.path);
      return (
        <div key={node.path}>
          <div
            className="ctx-file-tree-dir"
            role="button"
            tabIndex={0}
            style={{ paddingLeft: depth * 12 }}
            onClick={() => toggle(node.path)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(node.path); } }}
          >
            {isOpen ? "▾" : "▸"} {node.name}/
          </div>
          {isOpen && render(node.children, depth + 1)}
        </div>
      );
    });
  };

  return <>{render(nodes, 0)}</>;
}

// Tool Timeline dots (F5)
function ToolTimeline({ toolCalls }: { toolCalls: { tool: string; args: string; timestamp: string }[] }) {
  const last20 = toolCalls.slice(-20);
  const toolColors: Record<string, string> = {
    Read: "var(--accent)", Write: "var(--green)", Edit: "var(--yellow)",
    Bash: "var(--red)", Glob: "var(--text-2)", Grep: "var(--text-2)",
    Task: "var(--accent)", Search: "var(--accent)",
  };

  return (
    <div className="ctx-tool-timeline">
      {last20.map((tc, i) => (
        <div
          key={`${tc.timestamp}-${tc.tool}-${i}`}
          className="ctx-tool-dot"
          style={{ background: toolColors[tc.tool] || "var(--text-3)" }}
          title={`${tc.tool}(${tc.args}) - ${tc.timestamp}`}
        />
      ))}
    </div>
  );
}

// ─── Domain Section (Attached Projects) ──────────────────────────────
function DomainSection({ sessionId }: { sessionId: string }) {
  const [projects, setProjects] = useState<{
    id: string; name: string; path: string; languages: string[];
    scan_status: string; architecture: { pattern: string; layers: string[] } | null;
    conventions: { rule: string; source: string; confidence: number }[];
  }[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const fetchProjects = () => {
      getSessionProjects(sessionId)
        .then((r) => { if (mounted) { setProjects(r as typeof projects); setLoading(false); } })
        .catch((err) => { console.warn("[ContextPanel] Failed to load projects:", err); if (mounted) setLoading(false); });
    };

    setLoading(true);
    fetchProjects();

    let unlisten: (() => void) | null = null;
    let unlistenGlobal: (() => void) | null = null;

    listen(`session-realms-updated-${sessionId}`, fetchProjects)
      .then((u) => { if (mounted) unlisten = u; else u(); });
    listen("realm-updated", fetchProjects)
      .then((u) => { if (mounted) unlistenGlobal = u; else u(); });

    return () => {
      mounted = false;
      unlisten?.();
      unlistenGlobal?.();
    };
  }, [sessionId]);

  if (loading) return (
    <div className="ctx-section">
      <div className="ctx-section-title">Projects</div>
      <div className="text-muted">Loading...</div>
    </div>
  );
  if (projects.length === 0) return null;

  return (
    <div className="ctx-section">
      <div className="ctx-section-title">Projects</div>
      {projects.map((project) => (
        <div key={project.id} className="ctx-domain-project">
          <div
            className="ctx-domain-project-header"
            role="button"
            tabIndex={0}
            onClick={() => setExpanded(expanded === project.id ? null : project.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(expanded === project.id ? null : project.id); } }}
          >
            <span className="ctx-domain-project-name">{project.name}</span>
            <span className="project-scan-badge" data-status={project.scan_status}>
              {project.scan_status}
            </span>
          </div>
          {expanded === project.id && (
            <div className="ctx-domain-project-detail">
              {project.architecture && (
                <div className="ctx-kv">
                  <span>Architecture</span>
                  <span className="mono">{project.architecture.pattern}</span>
                </div>
              )}
              {project.architecture && project.architecture.layers.length > 0 && (
                <div className="ctx-kv">
                  <span>Layers</span>
                  <span className="mono">{project.architecture.layers.join(", ")}</span>
                </div>
              )}
              {project.languages.length > 0 && (
                <div className="ctx-kv">
                  <span>Languages</span>
                  <span className="mono">{project.languages.join(", ")}</span>
                </div>
              )}
              {project.conventions.length > 0 && (
                <div className="ctx-domain-conventions">
                  {project.conventions.slice(0, 8).map((conv) => (
                    <div key={conv.rule} className="ctx-domain-conv">{conv.rule}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function WorkspaceCompact({ cwd, extraPaths, workspaceInput, setWorkspaceInput, onAddPath }: {
  cwd: string; extraPaths: string[];
  workspaceInput: string; setWorkspaceInput: (v: string) => void; onAddPath: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const basename = cwd.replace(/\\/g, "/").split("/").pop() || cwd;

  return (
    <div className="ctx-section">
      <div className="ctx-section-title">Workspace</div>
      <div className="ctx-workspace-compact" role="button" tabIndex={0} onClick={() => setExpanded(!expanded)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(!expanded); } }} title={cwd}>
        <span className="mono">{basename}</span>
        {extraPaths.length > 0 && (
          <span className="ctx-workspace-expand-badge">+{extraPaths.length}</span>
        )}
      </div>
      {expanded && (
        <>
          <div className="ctx-workspace-path mono" style={{ fontSize: "var(--text-sm)", color: "var(--text-3)" }}>{cwd}</div>
          {extraPaths.map((p) => (
            <div key={p} className="ctx-workspace-path ctx-workspace-extra mono">+ {p}</div>
          ))}
          <div className="ctx-workspace-add">
            <input
              className="ctx-workspace-input"
              placeholder="Add project path..."
              value={workspaceInput}
              onChange={(e) => setWorkspaceInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onAddPath(); }}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ─── Constants ──────────────────────────────────────────────────────
const COPY_FEEDBACK_MS = 2000;
export function ContextPanel({ session }: ContextPanelProps) {
  const { metrics, detected_agent } = session;
  const mode = useExecutionMode(session.id);
  const { state: sessionState, dispatch } = useSession();
  const contextManager = useContextState(session, mode);
  const [workspaceInput, setWorkspaceInput] = useState("");
  const [persistedMemory, setPersistedMemory] = useState<PersistedMemory[]>([]);
  const [memoryKeyInput, setMemoryKeyInput] = useState("");
  const [memoryValueInput, setMemoryValueInput] = useState("");
  const [showMemoryAdd, setShowMemoryAdd] = useState(false);
  const [showPinAdd, setShowPinAdd] = useState(false);
  const [pinKind, setPinKind] = useState<string>("file");
  const [pinTarget, setPinTarget] = useState("");
  const [pinScope, setPinScope] = useState<"project" | "session">("project");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [memoryScopeInput, setMemoryScopeInput] = useState<"project" | "global">("project");
  const [copyDone, setCopyDone] = useState(false);

  // Derive primary project id for project-scoped operations
  const primaryProjectId = contextManager.context.realms.length > 0
    ? contextManager.context.realms[0].realm_id
    : null;

  // Pins come from contextManager (single source of truth via backend events)
  const pins = contextManager.context.pinnedItems;

  const fileTree = useFileTree(metrics.files_touched);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup copy-done timer on unmount
  useEffect(() => {
    return () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); };
  }, []);

  const handleCopyContext = useCallback(async () => {
    await contextManager.copyToClipboard();
    setCopyDone(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyDone(false), COPY_FEEDBACK_MS);
  }, [contextManager.copyToClipboard]);

  // Load persisted memory on mount and when session/project changes
  useEffect(() => {
    const loadMemory = async () => {
      try {
        const globalEntries = await getAllMemory("global", "global");
        if (primaryProjectId) {
          const projectEntries = await getAllMemory("project", primaryProjectId);
          setPersistedMemory([...projectEntries, ...globalEntries]);
        } else {
          setPersistedMemory(globalEntries);
        }
      } catch (err) {
        console.warn("[ContextPanel] Failed to load persisted memory:", err);
      }
    };
    loadMemory();
  }, [session.id, primaryProjectId]);

  const addPin = useCallback(async () => {
    if (!pinTarget.trim()) return;
    try {
      const isProject = pinScope === "project" && primaryProjectId;
      await addContextPin({
        sessionId: isProject ? null : session.id,
        projectId: isProject ? primaryProjectId : null,
        kind: pinKind, target: pinTarget.trim(), label: null, priority: null,
      });
      setPinTarget("");
      setShowPinAdd(false);
    } catch (err) {
      console.warn("[ContextPanel] Failed to add pin:", err);
    }
  }, [session.id, pinKind, pinTarget, pinScope, primaryProjectId]);

  const browseAndPinFile = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        defaultPath: session.working_directory,
      });
      if (selected) {
        const isProject = pinScope === "project" && primaryProjectId;
        await addContextPin({
          sessionId: isProject ? null : session.id,
          projectId: isProject ? primaryProjectId : null,
          kind: "file", target: selected, label: null, priority: null,
        });
        setShowPinAdd(false);
      }
    } catch (err) {
      console.warn("[ContextPanel] Failed to browse/pin file:", err);
    }
  }, [session.id, session.working_directory, pinScope, primaryProjectId]);

  const removePin = useCallback(async (id: number) => {
    try {
      await removeContextPin(id);
      // State update handled by context-pins-changed event → useContextState
    } catch (err) {
      console.warn("[ContextPanel] Failed to remove pin:", err);
    }
  }, []);

  const pinFile = useCallback(async (filePath: string) => {
    try {
      // Files pinned from the file tree default to project scope
      const isProject = primaryProjectId != null;
      await addContextPin({
        sessionId: isProject ? null : session.id,
        projectId: isProject ? primaryProjectId : null,
        kind: "file", target: filePath, label: null, priority: null,
      });
      // State update handled by context-pins-changed event → useContextState
    } catch (err) {
      console.warn("[ContextPanel] Failed to pin file:", err);
    }
  }, [session.id, primaryProjectId]);

  const pinMemory = useCallback(async (key: string, value: string) => {
    try {
      const isProject = primaryProjectId != null;
      await addContextPin({
        sessionId: isProject ? null : session.id,
        projectId: isProject ? primaryProjectId : null,
        kind: "memory", target: `${key}=${value}`, label: key, priority: null,
      });
      // State update handled by context-pins-changed event → useContextState
    } catch (err) {
      console.warn("[ContextPanel] Failed to pin memory:", err);
    }
  }, [session.id, primaryProjectId]);

  const addMemoryFact = useCallback(async () => {
    if (!memoryKeyInput.trim() || !memoryValueInput.trim()) return;
    try {
      const isProject = memoryScopeInput === "project" && primaryProjectId;
      await saveMemory({
        scope: isProject ? "project" : "global",
        scopeId: isProject ? primaryProjectId! : "global",
        key: memoryKeyInput.trim(),
        value: memoryValueInput.trim(),
        source: "user",
        category: "manual",
        confidence: 1.0,
      });
      setMemoryKeyInput("");
      setMemoryValueInput("");
      setShowMemoryAdd(false);
      // Reload both project and global memory
      const globalEntries = await getAllMemory("global", "global");
      if (primaryProjectId) {
        const projectEntries = await getAllMemory("project", primaryProjectId);
        setPersistedMemory([...projectEntries, ...globalEntries]);
      } else {
        setPersistedMemory(globalEntries);
      }
    } catch (err) {
      console.warn("[ContextPanel] Failed to save memory:", err);
    }
  }, [memoryKeyInput, memoryValueInput, memoryScopeInput, primaryProjectId]);

  const deleteMemoryFact = useCallback(async (key: string) => {
    try {
      // Find the entry to determine its scope
      const entry = persistedMemory.find((m) => m.key === key);
      const scope = entry?.scope ?? "global";
      const scopeId = entry?.scope_id ?? "global";
      await deleteMemory(scope, scopeId, key);
      setPersistedMemory((prev) => prev.filter((m) => m.key !== key));
    } catch (err) {
      console.warn("[ContextPanel] Failed to delete memory:", err);
    }
  }, [persistedMemory]);

  const addWorkspacePath = useCallback(async () => {
    if (!workspaceInput.trim()) return;
    try {
      await apiAddWorkspacePath(session.id, workspaceInput.trim());
      setWorkspaceInput("");
    } catch (err) {
      console.warn("[ContextPanel] Failed to add workspace path:", err);
    }
  }, [session.id, workspaceInput]);

  const { totalInput, totalOutput, totalCost, totalTokens } = useMemo(() => {
    let inp = 0, out = 0, cost = 0;
    for (const t of Object.values(metrics.token_usage)) {
      inp += t.input_tokens;
      out += t.output_tokens;
      cost += t.estimated_cost_usd;
    }
    return { totalInput: inp, totalOutput: out, totalCost: cost, totalTokens: inp + out };
  }, [metrics.token_usage]);

  const { toolEntries, maxToolCount, totalToolCalls } = useMemo(() => {
    const entries = Object.entries(metrics.tool_call_summary).sort((a, b) => b[1] - a[1]);
    const max = entries.length > 0 ? entries[0][1] : 0;
    const total = entries.reduce((sum, [, c]) => sum + c, 0);
    return { toolEntries: entries, maxToolCount: max, totalToolCalls: total };
  }, [metrics.tool_call_summary]);

  // Memoize memory dedup: persisted memory excluding keys already present in live facts
  const { persistedOnly, memoryTotalCount } = useMemo(() => {
    const liveKeys = new Set(metrics.memory_facts.map((f) => f.key));
    const filtered = persistedMemory.filter((m) => !liveKeys.has(m.key));
    return { persistedOnly: filtered, memoryTotalCount: metrics.memory_facts.length + filtered.length };
  }, [metrics.memory_facts, persistedMemory]);

  const sparkData = useMemo(
    () => metrics.token_history?.map(([i, o]) => i + o) || [],
    [metrics.token_history]
  );

  // Performance bar helpers (F5)
  const perfColor = (ms: number | null) => {
    if (ms == null) return "";
    if (ms < 2000) return "ctx-perf-fast";
    if (ms < 5000) return "ctx-perf-med";
    return "ctx-perf-slow";
  };

  const perfWidth = (ms: number | null) => {
    if (ms == null) return 0;
    return Math.min(100, (ms / 10000) * 100);
  };

  const handleToggleAutoApply = useCallback(() => {
    dispatch({ type: "TOGGLE_AUTO_APPLY" });
  }, [dispatch]);

  // Session-level injection lock: prevents multi-pane duplicate apply
  const lockedApplyContext = useCallback(async () => {
    if (sessionState.injectionLocks[session.id]) return; // Another pane already applying
    dispatch({ type: "ACQUIRE_INJECTION_LOCK", sessionId: session.id });
    try {
      await contextManager.applyContext();
    } finally {
      dispatch({ type: "RELEASE_INJECTION_LOCK", sessionId: session.id });
    }
  }, [session.id, sessionState.injectionLocks, dispatch, contextManager]);

  // Auto-apply on execution: fires ONCE per busy period when EITHER:
  // 1. Session phase transitions non-busy → busy while context is dirty
  // 2. Context lifecycle transitions to dirty while session is already busy
  // The autoAppliedRef guard prevents a loop: apply → clean → metrics change →
  // dirty → apply → clean → ... by limiting to one auto-apply per busy period.
  const prevPhase = useRef(session.phase);
  const prevLifecycle = useRef(contextManager.lifecycle);
  const autoAppliedRef = useRef(false);
  useEffect(() => {
    const wasBusy = prevPhase.current === "busy";
    const wasDirty = prevLifecycle.current === "dirty";
    prevPhase.current = session.phase;
    prevLifecycle.current = contextManager.lifecycle;

    // Reset guard when session leaves busy state
    if (session.phase !== "busy" && wasBusy) {
      autoAppliedRef.current = false;
    }

    // Trigger 1: Phase transition non-busy → busy while context is dirty
    const phaseTrigger =
      session.phase === "busy" &&
      !wasBusy &&
      contextManager.lifecycle === 'dirty' &&
      contextManager.currentVersion > contextManager.injectedVersion;

    // Trigger 2: Lifecycle transition to dirty while session is already busy
    const lifecycleTrigger =
      session.phase === "busy" &&
      contextManager.lifecycle === 'dirty' &&
      !wasDirty &&
      contextManager.currentVersion > contextManager.injectedVersion;

    const shouldApply =
      sessionState.autoApplyEnabled &&
      !autoAppliedRef.current &&
      (phaseTrigger || lifecycleTrigger);

    if (shouldApply) {
      autoAppliedRef.current = true;
      if (contextManager.injectedVersion === 0) {
        // The backend startup command already includes $HERMES_CONTEXT —
        // the agent has already read the context file. Acknowledge the
        // injection without sending a redundant nudge.
        contextManager.acknowledgeInjection();
      } else {
        lockedApplyContext().catch(console.error);
      }
    }
  }, [session.phase, sessionState.autoApplyEnabled, contextManager.lifecycle, contextManager.currentVersion, contextManager.injectedVersion, lockedApplyContext, contextManager.acknowledgeInjection]);

  return (
    <div className={`context-panel ${contextManager.lifecycle === 'dirty' || contextManager.lifecycle === 'apply_failed' ? "context-panel-outofsync" : ""}`}>
      <div className="context-panel-header">
        <span className="context-panel-title">CONTEXT</span>
        <div className="ctx-header-actions">
          <button className="ctx-header-action-btn" onClick={() => setShowPinAdd(!showPinAdd)} title="Add pin">&#x1F4CC;</button>
          <button className="ctx-header-action-btn" onClick={() => setShowMemoryAdd(!showMemoryAdd)} title="Add memory fact">&#x1F4DD;</button>
          <button
            className={`ctx-copy-btn ${copyDone ? "ctx-copy-btn-done" : ""}`}
            onClick={handleCopyContext}
            title={`Copy context bundle (${fmt("{mod}{shift}C")})`}
          >
            {copyDone ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <ContextStatusBar
        manager={contextManager}
        autoApplyEnabled={sessionState.autoApplyEnabled}
        onToggleAutoApply={handleToggleAutoApply}
        onApply={lockedApplyContext}
      />
      <ContextPreview manager={contextManager} />
      <div className="context-panel-body">

        {/* Agent */}
        {detected_agent && (
          <div className="ctx-section">
            <div className="ctx-section-title">Agent</div>
            <div className="ctx-agent">
              <span className="ctx-agent-icon" style={{ background: session.color + "33", color: session.color }}>
                {detected_agent.name.charAt(0)}
              </span>
              <div className="ctx-agent-info">
                <div className="ctx-agent-name">{detected_agent.name}</div>
                <div className="ctx-agent-detail">
                  {detected_agent.model || detected_agent.provider}
                  <span className={`ctx-phase-dot ctx-phase-${session.phase}`} />
                  {session.phase}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tokens */}
        {totalTokens > 0 && (
          <div className="ctx-section">
            <div className="ctx-section-title">Tokens <span className="ctx-cost">{formatCost(totalCost)}</span></div>
            {sparkData.length >= 2 && (
              <div className="ctx-sparkline-wrap">
                <Sparkline data={sparkData} color={session.color} width={260} height={28} />
              </div>
            )}
            <div className="ctx-tokens-row">
              <span className="ctx-token-in">{formatTokens(totalInput)} in</span>
              <span className="ctx-token-out">{formatTokens(totalOutput)} out</span>
            </div>
            {Object.entries(metrics.token_usage).map(([provider, tokens]) => {
              const provCost = tokens.estimated_cost_usd;
              const pct = totalCost > 0 ? Math.round((provCost / totalCost) * 100) : 0;
              return (
                <div key={provider} className="ctx-provider-row">
                  <span className="ctx-provider-name">{provider}</span>
                  <span className="ctx-provider-model mono">{tokens.model}</span>
                  <span className="ctx-provider-cost">{formatCost(provCost)}</span>
                  <span className="ctx-provider-pct">{pct}%</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Pinned Context — only render when there are pins or adding */}
        {(pins.length > 0 || showPinAdd) && (
          <div className="ctx-section">
            <div className="ctx-section-title">
              Pinned <span className="ctx-cost">{pins.length}</span>
            </div>
            {pins.map((pin) => (
              <div key={pin.id} className="ctx-pin-row">
                <span className={`ctx-pin-badge ctx-pin-${pin.kind}`}>{pin.kind}</span>
                <span className="ctx-pin-target mono truncate">{pin.label || pin.target}</span>
                <span className={`ctx-pin-scope-badge ${pin.session_id === null ? "ctx-pin-scope-project" : "ctx-pin-scope-session"}`}>
                  {pin.session_id === null ? "project" : "session"}
                </span>
                <button className="ctx-memory-delete" onClick={() => removePin(pin.id)} title="Unpin">&times;</button>
              </div>
            ))}
            {showPinAdd && (
              <div className="ctx-memory-add-form">
                <div className="ctx-pin-form-row">
                  <select className="ctx-pin-select" value={pinKind} onChange={(e) => setPinKind(e.target.value)}>
                    <option value="file">File</option>
                    <option value="directory">Directory</option>
                    <option value="memory">Memory</option>
                    <option value="text">Text</option>
                  </select>
                  <select className="ctx-pin-scope-select" value={pinScope} onChange={(e) => setPinScope(e.target.value as "project" | "session")}>
                    <option value="project">Project</option>
                    <option value="session">Session only</option>
                  </select>
                </div>
                {pinKind === "file" ? (
                  <div className="ctx-pin-file-row">
                    <input
                      className="ctx-memory-input"
                      placeholder="File path"
                      value={pinTarget}
                      onChange={(e) => setPinTarget(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addPin(); }}
                    />
                    <button className="ctx-pin-browse-btn" onClick={browseAndPinFile} title="Browse files">Browse</button>
                  </div>
                ) : (
                  <input
                    className="ctx-memory-input"
                    placeholder={pinKind === "memory" ? "Key=Value" : "Text to pin"}
                    value={pinTarget}
                    onChange={(e) => setPinTarget(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addPin(); }}
                  />
                )}
                <div className="ctx-memory-add-actions">
                  <button className="ctx-memory-save-btn" onClick={addPin}>Pin</button>
                  <button className="ctx-memory-cancel-btn" onClick={() => setShowPinAdd(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Response Time */}
        {metrics.latency_p50_ms != null && (
          <div className="ctx-section">
            <div className="ctx-section-title">Response Time</div>
            <div className="ctx-kv">
              <span>Typical</span>
              <span className="mono">
                {(metrics.latency_p50_ms / 1000).toFixed(1)}s
                {metrics.latency_p50_ms > 3000 && <span className="text-yellow"> slow</span>}
                {metrics.latency_p50_ms > 8000 && <span className="text-red"> very slow</span>}
              </span>
            </div>
            <div className="ctx-perf-bar">
              <div className={`ctx-perf-fill ${perfColor(metrics.latency_p50_ms)}`} style={{ width: `${perfWidth(metrics.latency_p50_ms)}%` }} />
            </div>
          </div>
        )}

        {/* Health — hide when nothing to report */}
        {metrics.output_lines > 0 && (
          <div className="ctx-section">
            <div className="ctx-section-title">Health</div>
            <div className="ctx-kv">
              <span>Output</span>
              <span className="mono">{metrics.output_lines.toLocaleString()} lines</span>
            </div>
          </div>
        )}

        {/* Tool Calls */}
        {toolEntries.length > 0 && (
          <div className="ctx-section">
            <div className="ctx-section-title">Tools <span className="ctx-cost">{totalToolCalls} calls</span></div>
            {toolEntries.map(([tool, count]) => (
              <ToolBar key={tool} tool={tool} count={count} maxCount={maxToolCount} />
            ))}
            {metrics.tool_calls.length > 0 && (
              <div className="ctx-last-tool mono">
                Last: {metrics.tool_calls[0].tool}({metrics.tool_calls[0].args})
              </div>
            )}
          </div>
        )}

        {/* Recent Actions (simplified since F4 actions bar handles execution) */}
        {metrics.recent_actions.length > 0 && (
          <div className="ctx-section">
            <div className="ctx-section-title">Recent Actions</div>
            <div className="ctx-action-history">
              {metrics.recent_actions.slice(-5).map((a, i) => (
                <div key={`${a.command}-${i}`} className="ctx-action-entry mono">
                  {a.command} <span className="text-muted">{a.is_suggestion ? "suggested" : "executed"}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Memory (merged: live-detected + persisted) — hidden when empty */}
        {(memoryTotalCount > 0 || showMemoryAdd) && (
            <div className="ctx-section">
              <div className="ctx-section-title">
                Memory <span className="ctx-cost">{memoryTotalCount} facts</span>
              </div>
              {metrics.memory_facts.map((fact) => (
                <div key={fact.key} className="ctx-memory-row">
                  <span className="ctx-memory-key">{fact.key}</span>
                  <span className="ctx-memory-value mono">{fact.value}</span>
                  <span className="ctx-memory-source" title="Auto-detected from session">auto</span>
                  <button className="ctx-pin-btn" onClick={() => pinMemory(fact.key, fact.value)} title="Pin">pin</button>
                </div>
              ))}
              {persistedOnly.map((m) => (
                <div key={m.key} className="ctx-memory-row">
                  <span className="ctx-memory-key">{m.key}</span>
                  <span className="ctx-memory-value mono">{m.value}</span>
                  <span className={`ctx-pin-scope-badge ${m.scope === "project" ? "ctx-pin-scope-project" : "ctx-pin-scope-global"}`}>
                    {m.scope === "project" ? "project" : "global"}
                  </span>
                  <button className="ctx-memory-delete" onClick={() => deleteMemoryFact(m.key)} title="Delete">&times;</button>
                </div>
              ))}
              {showMemoryAdd && (
                <div className="ctx-memory-add-form">
                  <input className="ctx-memory-input" placeholder="Key (e.g. db_host)" value={memoryKeyInput} onChange={(e) => setMemoryKeyInput(e.target.value)} />
                  <input className="ctx-memory-input" placeholder="Value" value={memoryValueInput} onChange={(e) => setMemoryValueInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addMemoryFact(); }} />
                  <div className="ctx-memory-add-actions">
                    <select className="ctx-pin-scope-select" value={memoryScopeInput} onChange={(e) => setMemoryScopeInput(e.target.value as "project" | "global")}>
                      <option value="project">Project</option>
                      <option value="global">Global</option>
                    </select>
                    <button className="ctx-memory-save-btn" onClick={addMemoryFact}>Save</button>
                    <button className="ctx-memory-cancel-btn" onClick={() => setShowMemoryAdd(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
        )}

        {/* Recent Errors + Error Intelligence + Correlations (F6) — Tiered Display */}
        {/* Files (F5 — tree view) */}
        {metrics.files_touched.length > 0 && (
          <div className="ctx-section">
            <div className="ctx-section-title">
              Files ({metrics.files_touched.length})
            </div>
            <div className="ctx-file-list">
              <FileTreeView nodes={fileTree} onPin={pinFile} />
            </div>
          </div>
        )}

        {/* Domain — Attached Realms */}
        <DomainSection sessionId={session.id} />

        {/* Workspace — compact CWD with click-to-expand */}
        <WorkspaceCompact
          cwd={session.working_directory}
          extraPaths={session.workspace_paths}
          workspaceInput={workspaceInput}
          setWorkspaceInput={setWorkspaceInput}
          onAddPath={addWorkspacePath}
        />

        {/* Advanced — collapsible diagnostics */}
        <div className="ctx-section ctx-advanced-section">
          <button
            className="ctx-advanced-toggle"
            onClick={() => setShowAdvanced(!showAdvanced)}
            title="Toggle advanced diagnostics"
          >
            {showAdvanced ? "\u25BE" : "\u25B8"} Advanced
          </button>
          {showAdvanced && (
            <div className="ctx-advanced-body">
              <div className="ctx-kv">
                <span>Context version</span>
                <span className="mono">v{contextManager.currentVersion}</span>
              </div>
              <div className="ctx-kv">
                <span>Injected version</span>
                <span className="mono">
                  {contextManager.injectedVersion > 0 ? `v${contextManager.injectedVersion}` : "—"}
                </span>
              </div>
              {metrics.latency_p95_ms != null && (
                <div className="ctx-kv">
                  <span>Worst 5% response</span>
                  <span className="mono">{(metrics.latency_p95_ms / 1000).toFixed(1)}s</span>
                </div>
              )}
              {metrics.latency_samples && metrics.latency_samples.length >= 2 && (
                <div className="ctx-sparkline-wrap">
                  <Sparkline data={metrics.latency_samples} color="var(--accent)" width={260} height={24} />
                </div>
              )}
              {metrics.tool_calls.length > 1 && (
                <ToolTimeline toolCalls={metrics.tool_calls} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
