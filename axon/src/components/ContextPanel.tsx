import { useState, useCallback, useMemo, useEffect, useRef, memo } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { SessionData, useExecutionMode, useSession } from "../state/SessionContext";
import { writeToSession, addWorkspacePath as apiAddWorkspacePath } from "../api/sessions";
import { getSessionRealms } from "../api/realms";
import { addContextPin, removeContextPin, findErrorCorrelations } from "../api/context";
import { getAllMemory, saveMemory, deleteMemory } from "../api/memory";
import { useFileTree, FileTreeNode } from "../hooks/useFileTree";
import { useContextState } from "../hooks/useContextState";
import { ContextStatusBar } from "./ContextStatusBar";
import { ContextPreview } from "./ContextPreview";
import { utf8ToBase64 } from "../utils/encoding";
import type { PersistedMemory, ErrorMatchEvent, ErrorCorrelation } from "../types";

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

function timeAgo(ts: number): string {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
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

function sendCommand(sessionId: string, command: string) {
  const data = utf8ToBase64(command + "\r");
  writeToSession(sessionId, data).catch((err) => {
    console.warn(`[ContextPanel] Failed to send command "${command}":`, err);
  });
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

  const render = (nodes: FileTreeNode[], depth: number): JSX.Element[] => {
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
            style={{ paddingLeft: depth * 12 }}
            onClick={() => toggle(node.path)}
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
          key={i}
          className="ctx-tool-dot"
          style={{ background: toolColors[tc.tool] || "var(--text-3)" }}
          title={`${tc.tool}(${tc.args}) - ${tc.timestamp}`}
        />
      ))}
    </div>
  );
}

// ─── Domain Section (Attached Realms) ────────────────────────────────
function DomainSection({ sessionId }: { sessionId: string }) {
  const [realms, setRealms] = useState<{
    id: string; name: string; path: string; languages: string[];
    scan_status: string; architecture: { pattern: string; layers: string[] } | null;
    conventions: { rule: string; source: string; confidence: number }[];
  }[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const fetchRealms = () => {
      getSessionRealms(sessionId)
        .then((r) => { if (mounted) { setRealms(r as typeof realms); setLoading(false); } })
        .catch((err) => { console.warn("[ContextPanel] Failed to load realms:", err); if (mounted) setLoading(false); });
    };

    setLoading(true);
    fetchRealms();

    let unlisten: (() => void) | null = null;
    let unlistenGlobal: (() => void) | null = null;

    listen(`session-realms-updated-${sessionId}`, fetchRealms)
      .then((u) => { if (mounted) unlisten = u; else u(); });
    listen("realm-updated", fetchRealms)
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
  if (realms.length === 0) return null;

  return (
    <div className="ctx-section">
      <div className="ctx-section-title">Projects</div>
      {realms.map((realm) => (
        <div key={realm.id} className="ctx-domain-realm">
          <div
            className="ctx-domain-realm-header"
            onClick={() => setExpanded(expanded === realm.id ? null : realm.id)}
          >
            <span className="ctx-domain-realm-name">{realm.name}</span>
            <span className="realm-scan-badge" data-status={realm.scan_status}>
              {realm.scan_status}
            </span>
          </div>
          {expanded === realm.id && (
            <div className="ctx-domain-realm-detail">
              {realm.architecture && (
                <div className="ctx-kv">
                  <span>Architecture</span>
                  <span className="mono">{realm.architecture.pattern}</span>
                </div>
              )}
              {realm.architecture && realm.architecture.layers.length > 0 && (
                <div className="ctx-kv">
                  <span>Layers</span>
                  <span className="mono">{realm.architecture.layers.join(", ")}</span>
                </div>
              )}
              {realm.languages.length > 0 && (
                <div className="ctx-kv">
                  <span>Languages</span>
                  <span className="mono">{realm.languages.join(", ")}</span>
                </div>
              )}
              {realm.conventions.length > 0 && (
                <div className="ctx-domain-conventions">
                  {realm.conventions.slice(0, 8).map((conv, i) => (
                    <div key={i} className="ctx-domain-conv">{conv.rule}</div>
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

export function ContextPanel({ session }: ContextPanelProps) {
  const { metrics, detected_agent } = session;
  const mode = useExecutionMode(session.id);
  const { state: sessionState, setActive, dispatch } = useSession();
  const contextManager = useContextState(session, mode);
  const [workspaceInput, setWorkspaceInput] = useState("");
  const [persistedMemory, setPersistedMemory] = useState<PersistedMemory[]>([]);
  const [memoryKeyInput, setMemoryKeyInput] = useState("");
  const [memoryValueInput, setMemoryValueInput] = useState("");
  const [showMemoryAdd, setShowMemoryAdd] = useState(false);
  const [errorMatches, setErrorMatches] = useState<ErrorMatchEvent[]>([]);
  const [showPinAdd, setShowPinAdd] = useState(false);
  const [pinKind, setPinKind] = useState<string>("file");
  const [pinTarget, setPinTarget] = useState("");
  const [correlations, setCorrelations] = useState<Record<string, ErrorCorrelation[]>>({});
  const [copyDone, setCopyDone] = useState(false);
  const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set());

  // Pins come from contextManager (single source of truth via backend events)
  const pins = contextManager.context.pinnedItems;

  const fileTree = useFileTree(metrics.files_touched);

  const handleCopyContext = useCallback(async () => {
    await contextManager.copyToClipboard();
    setCopyDone(true);
    setTimeout(() => setCopyDone(false), 2000);
  }, [contextManager.copyToClipboard]);

  // Load persisted memory on mount and when session changes
  useEffect(() => {
    getAllMemory("global", "global")
      .then((entries) => setPersistedMemory(entries))
      .catch((err) => console.warn("[ContextPanel] Failed to load persisted memory:", err));
  }, [session.id]);

  // Listen for error-matched events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<ErrorMatchEvent>(`error-matched-${session.id}`, (event) => {
      setErrorMatches((prev) => {
        const existing = prev.findIndex((e) => e.fingerprint === event.payload.fingerprint);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = event.payload;
          return updated;
        }
        return [...prev.slice(-9), event.payload];
      });

      // Fetch correlations for this error (F6)
      findErrorCorrelations({
        fingerprint: event.payload.fingerprint,
        projectId: session.working_directory,
        excludeSession: session.id,
        limit: 3,
      }).then((corrs) => {
        if (corrs.length > 0) {
          setCorrelations((prev) => ({ ...prev, [event.payload.fingerprint]: corrs }));
        }
      }).catch((err) => console.warn("[ContextPanel] Failed to load error correlations:", err));
    }).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
  }, [session.id, session.working_directory]);

  const addPin = useCallback(async () => {
    if (!pinTarget.trim()) return;
    try {
      await addContextPin({
        sessionId: session.id, projectId: null,
        kind: pinKind, target: pinTarget.trim(), label: null, priority: null,
      });
      setPinTarget("");
      setShowPinAdd(false);
    } catch (err) {
      console.warn("[ContextPanel] Failed to add pin:", err);
    }
  }, [session.id, pinKind, pinTarget]);

  const browseAndPinFile = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        defaultPath: session.working_directory,
      });
      if (selected) {
        await addContextPin({
          sessionId: session.id, projectId: null,
          kind: "file", target: selected, label: null, priority: null,
        });
        setShowPinAdd(false);
      }
    } catch (err) {
      console.warn("[ContextPanel] Failed to browse/pin file:", err);
    }
  }, [session.id, session.working_directory]);

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
      await addContextPin({
        sessionId: session.id, projectId: null,
        kind: "file", target: filePath, label: null, priority: null,
      });
      // State update handled by context-pins-changed event → useContextState
    } catch (err) {
      console.warn("[ContextPanel] Failed to pin file:", err);
    }
  }, [session.id]);

  const pinMemory = useCallback(async (key: string, value: string) => {
    try {
      await addContextPin({
        sessionId: session.id, projectId: null,
        kind: "memory", target: `${key}=${value}`, label: key, priority: null,
      });
      // State update handled by context-pins-changed event → useContextState
    } catch (err) {
      console.warn("[ContextPanel] Failed to pin memory:", err);
    }
  }, [session.id]);

  const addMemoryFact = useCallback(async () => {
    if (!memoryKeyInput.trim() || !memoryValueInput.trim()) return;
    try {
      await saveMemory({
        scope: "global",
        scopeId: "global",
        key: memoryKeyInput.trim(),
        value: memoryValueInput.trim(),
        source: "user",
        category: "manual",
        confidence: 1.0,
      });
      setMemoryKeyInput("");
      setMemoryValueInput("");
      setShowMemoryAdd(false);
      const entries = await getAllMemory("global", "global");
      setPersistedMemory(entries);
    } catch (err) {
      console.warn("[ContextPanel] Failed to save memory:", err);
    }
  }, [memoryKeyInput, memoryValueInput]);

  const deleteMemoryFact = useCallback(async (key: string) => {
    try {
      await deleteMemory("global", "global", key);
      setPersistedMemory((prev) => prev.filter((m) => m.key !== key));
    } catch (err) {
      console.warn("[ContextPanel] Failed to delete memory:", err);
    }
  }, []);

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

  // Auto-apply on execution: when session becomes busy and context is dirty
  const prevPhase = useRef(session.phase);
  useEffect(() => {
    const wasBusy = prevPhase.current === "busy";
    prevPhase.current = session.phase;
    if (
      session.phase === "busy" &&
      !wasBusy &&
      sessionState.autoApplyEnabled &&
      contextManager.lifecycle === 'dirty'
    ) {
      void contextManager.applyContext();
    }
  }, [session.phase, sessionState.autoApplyEnabled, contextManager.lifecycle]);

  return (
    <div className={`context-panel ${contextManager.lifecycle === 'dirty' || contextManager.lifecycle === 'apply_failed' ? "context-panel-outofsync" : ""}`}>
      <div className="context-panel-header">
        <span className="context-panel-title">Context</span>
        <button
          className={`ctx-copy-btn ${copyDone ? "ctx-copy-btn-done" : ""}`}
          onClick={handleCopyContext}
          title="Copy context bundle (⌘⇧C)"
        >
          {copyDone ? "Copied" : "Copy"}
        </button>
      </div>
      <ContextStatusBar
        manager={contextManager}
        autoApplyEnabled={sessionState.autoApplyEnabled}
        onToggleAutoApply={handleToggleAutoApply}
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

        {/* Pinned Context */}
        {(pins.length > 0 || showPinAdd) && (
          <div className="ctx-section">
            <div className="ctx-section-title">
              Pinned <span className="ctx-cost">{pins.length}</span>
              <button className="ctx-memory-add-btn" onClick={() => setShowPinAdd(!showPinAdd)} title="Add pin">+</button>
            </div>
            {pins.map((pin) => (
              <div key={pin.id} className="ctx-pin-row">
                <span className={`ctx-pin-badge ctx-pin-${pin.kind}`}>{pin.kind}</span>
                <span className="ctx-pin-target mono truncate">{pin.label || pin.target}</span>
                <button className="ctx-memory-delete" onClick={() => removePin(pin.id)} title="Unpin">&times;</button>
              </div>
            ))}
            {showPinAdd && (
              <div className="ctx-memory-add-form">
                <select className="ctx-pin-select" value={pinKind} onChange={(e) => setPinKind(e.target.value)}>
                  <option value="file">File</option>
                  <option value="memory">Memory</option>
                  <option value="text">Text</option>
                </select>
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
        {pins.length === 0 && !showPinAdd && (
          <div className="ctx-section">
            <div className="ctx-section-title">
              Pinned
              <button className="ctx-memory-add-btn" onClick={() => setShowPinAdd(true)} title="Add pin">+</button>
            </div>
          </div>
        )}

        {/* Performance (F5) */}
        {(metrics.latency_p50_ms != null || metrics.latency_p95_ms != null) && (
          <div className="ctx-section">
            <div className="ctx-section-title">Performance</div>
            {metrics.latency_p50_ms != null && (
              <div className="ctx-kv">
                <span>p50</span>
                <span className="mono">{(metrics.latency_p50_ms / 1000).toFixed(1)}s</span>
              </div>
            )}
            {metrics.latency_p50_ms != null && (
              <div className="ctx-perf-bar">
                <div className={`ctx-perf-fill ${perfColor(metrics.latency_p50_ms)}`} style={{ width: `${perfWidth(metrics.latency_p50_ms)}%` }} />
              </div>
            )}
            {metrics.latency_p95_ms != null && (
              <div className="ctx-kv">
                <span>p95</span>
                <span className="mono">{(metrics.latency_p95_ms / 1000).toFixed(1)}s</span>
              </div>
            )}
            {metrics.latency_p95_ms != null && (
              <div className="ctx-perf-bar">
                <div className={`ctx-perf-fill ${perfColor(metrics.latency_p95_ms)}`} style={{ width: `${perfWidth(metrics.latency_p95_ms)}%` }} />
              </div>
            )}
            {metrics.latency_samples && metrics.latency_samples.length >= 2 && (
              <div className="ctx-sparkline-wrap">
                <Sparkline data={metrics.latency_samples} color="var(--accent)" width={260} height={24} />
              </div>
            )}
          </div>
        )}

        {/* Health */}
        <div className="ctx-section">
          <div className="ctx-section-title">Health</div>
          <div className="ctx-kv">
            <span>Output</span>
            <span className="mono">{metrics.output_lines.toLocaleString()} lines</span>
          </div>
          <div className="ctx-kv">
            <span>Errors</span>
            <span className={`mono ${metrics.error_count > 0 ? "text-red" : ""}`}>{metrics.error_count}</span>
          </div>
          {metrics.stuck_score > 0 && (
            <div className="ctx-stuck-bar">
              <div className="ctx-stuck-bar-fill"
                   data-level={metrics.stuck_score > 0.7 ? "high" : metrics.stuck_score > 0.4 ? "medium" : "low"}
                   style={{ width: `${metrics.stuck_score * 100}%` }} />
            </div>
          )}
        </div>

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
            {/* Tool Timeline (F5) */}
            {metrics.tool_calls.length > 1 && (
              <ToolTimeline toolCalls={metrics.tool_calls} />
            )}
          </div>
        )}

        {/* Recent Actions (simplified since F4 actions bar handles execution) */}
        {metrics.recent_actions.length > 0 && (
          <div className="ctx-section">
            <div className="ctx-section-title">Recent Actions</div>
            <div className="ctx-action-history">
              {metrics.recent_actions.slice(-5).map((a, i) => (
                <div key={i} className="ctx-action-entry mono">
                  {a.command} <span className="text-muted">{a.is_suggestion ? "suggested" : "executed"}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Memory (merged: live-detected + persisted) */}
        {(() => {
          const liveKeys = new Set(metrics.memory_facts.map((f) => f.key));
          const persistedOnly = persistedMemory.filter((m) => !liveKeys.has(m.key));
          const totalCount = metrics.memory_facts.length + persistedOnly.length;

          return (totalCount > 0 || showMemoryAdd) ? (
            <div className="ctx-section">
              <div className="ctx-section-title">
                Memory <span className="ctx-cost">{totalCount} facts</span>
                <button className="ctx-memory-add-btn" onClick={() => setShowMemoryAdd(!showMemoryAdd)} title="Add memory fact">+</button>
              </div>
              {metrics.memory_facts.map((fact) => (
                <div key={fact.key} className="ctx-memory-row">
                  <span className="ctx-memory-key">{fact.key}</span>
                  <span className="ctx-memory-value mono">{fact.value}</span>
                  <span className="ctx-memory-source" title={`Auto-detected (${Math.round(fact.confidence * 100)}%)`}>auto</span>
                  <button className="ctx-pin-btn" onClick={() => pinMemory(fact.key, fact.value)} title="Pin">pin</button>
                </div>
              ))}
              {persistedOnly.map((m) => (
                <div key={m.key} className="ctx-memory-row">
                  <span className="ctx-memory-key">{m.key}</span>
                  <span className="ctx-memory-value mono">{m.value}</span>
                  <button className="ctx-memory-delete" onClick={() => deleteMemoryFact(m.key)} title="Delete">&times;</button>
                </div>
              ))}
              {showMemoryAdd && (
                <div className="ctx-memory-add-form">
                  <input className="ctx-memory-input" placeholder="Key (e.g. db_host)" value={memoryKeyInput} onChange={(e) => setMemoryKeyInput(e.target.value)} />
                  <input className="ctx-memory-input" placeholder="Value" value={memoryValueInput} onChange={(e) => setMemoryValueInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addMemoryFact(); }} />
                  <div className="ctx-memory-add-actions">
                    <button className="ctx-memory-save-btn" onClick={addMemoryFact}>Save</button>
                    <button className="ctx-memory-cancel-btn" onClick={() => setShowMemoryAdd(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="ctx-section">
              <div className="ctx-section-title">
                Memory
                <button className="ctx-memory-add-btn" onClick={() => setShowMemoryAdd(true)} title="Add memory fact">+</button>
              </div>
              <div className="ctx-memory-empty">No memory facts recorded yet</div>
            </div>
          );
        })()}

        {/* Recent Errors + Error Intelligence + Correlations (F6) */}
        {(metrics.recent_errors.length > 0 || errorMatches.length > 0) && (
          <div className="ctx-section">
            <div className="ctx-section-title">Errors ({metrics.recent_errors.length})</div>
            {errorMatches.map((match) => (
              <div key={match.fingerprint}>
                <div className="ctx-error-match">
                  <div className="ctx-error-match-header">
                    <span className="ctx-error-match-count">Seen {match.occurrence_count}x</span>
                    {match.resolution && (
                      <span className="ctx-error-match-resolution">
                        Last fix: "{match.resolution}"
                        {mode === "assisted" && (
                          <button
                            className="ctx-error-apply-btn"
                            onClick={() => sendCommand(session.id, match.resolution!)}
                          >
                            Apply
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                </div>
                {/* Error Correlations (F6) */}
                {correlations[match.fingerprint]?.map((corr) => (
                  <div key={corr.session_id} className="ctx-error-correlation">
                    Also in:{" "}
                    <span
                      className="ctx-error-correlation-link"
                      onClick={() => setActive(corr.session_id)}
                    >
                      {corr.session_label}
                    </span>
                    {" "}({timeAgo(corr.last_seen)})
                  </div>
                ))}
              </div>
            ))}
            <div className="ctx-error-list">
              {metrics.recent_errors.slice(-5).map((err, i) => (
                <div
                  key={i}
                  className={`ctx-error-entry mono ${expandedErrors.has(i) ? "ctx-error-entry-expanded" : ""}`}
                  onClick={() => setExpandedErrors((prev) => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  })}
                >{err}</div>
              ))}
            </div>
          </div>
        )}

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

        {/* Workspace Paths */}
        <div className="ctx-section">
          <div className="ctx-section-title">Workspace</div>
          <div className="ctx-workspace-path mono">{session.working_directory}</div>
          {session.workspace_paths.map((p) => (
            <div key={p} className="ctx-workspace-path ctx-workspace-extra mono">+ {p}</div>
          ))}
          <div className="ctx-workspace-add">
            <input
              className="ctx-workspace-input"
              placeholder="Add project path..."
              value={workspaceInput}
              onChange={(e) => setWorkspaceInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addWorkspacePath(); }}
            />
          </div>
        </div>

        {/* Session Info */}
        <div className="ctx-section">
          <div className="ctx-section-title">Session</div>
          <div className="ctx-kv"><span>Shell</span><span className="mono">{session.shell.split("/").pop()}</span></div>
          <div className="ctx-kv"><span>Phase</span><span>{session.phase}</span></div>
          <div className="ctx-kv"><span>Created</span><span className="mono">{new Date(session.created_at).toLocaleTimeString()}</span></div>
        </div>
      </div>
    </div>
  );
}
