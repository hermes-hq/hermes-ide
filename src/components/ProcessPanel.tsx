import { useState, useMemo, useCallback, useRef, memo } from "react";
import "../styles/components/ProcessPanel.css";
import { useProcesses } from "../hooks/useProcesses";
import { killProcess, killProcessTree, getProcessDetail, revealProcessInFinder } from "../api/processes";
import type { ProcessInfo, ProcessSortField, SortDirection, ProcessFilter } from "../types/process";
import { useContextMenu, buildProcessMenuItems } from "../hooks/useContextMenu";

// ─── Constants ──────────────────────────────────────────────────────

const PANEL_MIN_WIDTH = 240;
const PANEL_MAX_WIDTH = 600;
const PANEL_DEFAULT_WIDTH = 320;

// ─── Constants ──────────────────────────────────────────────────────

const ROW_HEIGHT = 32;
const EXPANDED_ROW_HEIGHT = 120;
const OVERSCAN = 2;

// ─── Sort & Filter Helpers (exported for testing) ───────────────────

export function sortProcesses(
  processes: ProcessInfo[],
  field: ProcessSortField,
  direction: SortDirection,
): ProcessInfo[] {
  const sorted = [...processes];
  const dir = direction === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    const aVal = a[field];
    const bVal = b[field];
    if (typeof aVal === "number" && typeof bVal === "number") return (aVal - bVal) * dir;
    if (typeof aVal === "string" && typeof bVal === "string") return aVal.localeCompare(bVal) * dir;
    return 0;
  });
  return sorted;
}

export function filterProcesses(processes: ProcessInfo[], filter: ProcessFilter): ProcessInfo[] {
  return processes.filter((p) => {
    if (filter.search) {
      const s = filter.search.toLowerCase();
      const matchesName = p.name.toLowerCase().includes(s);
      const matchesPid = /^\d+$/.test(filter.search) && p.pid === parseInt(filter.search, 10);
      if (!matchesName && !matchesPid) return false;
    }
    if (filter.cpuThreshold > 0 && p.cpu_percent < filter.cpuThreshold) return false;
    if (filter.memThreshold > 0 && p.memory_percent < filter.memThreshold) return false;
    if (filter.showHermesOnly && !p.is_hermes_session) return false;
    if (filter.showZombiesOnly && !p.is_zombie) return false;
    return true;
  });
}

export function computeNewPids(prev: Set<number>, current: Set<number>): Set<number> {
  const added = new Set<number>();
  for (const pid of current) {
    if (!prev.has(pid)) added.add(pid);
  }
  return added;
}

export function computeRemovedPids(prev: Set<number>, current: Set<number>): Set<number> {
  const removed = new Set<number>();
  for (const pid of prev) {
    if (!current.has(pid)) removed.add(pid);
  }
  return removed;
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatUptime(startTime: number): string {
  if (!startTime) return "-";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - startTime;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d`;
}

function cpuColor(pct: number): string {
  if (pct > 70) return "var(--red)";
  if (pct > 30) return "var(--yellow)";
  return "var(--green)";
}

function memColor(pct: number): string {
  return cpuColor(pct);
}

// ─── ProcessRow ─────────────────────────────────────────────────────

interface ProcessRowProps {
  process: ProcessInfo;
  isExpanded: boolean;
  isNew: boolean;
  top: number;
  height: number;
  advancedMode: boolean;
  onToggleExpand: (pid: number) => void;
  onKill: (pid: number, signal: string, name: string) => void;
  onKillTree: (pid: number, signal: string, name: string) => void;
  onReveal: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, process: ProcessInfo) => void;
}

const ProcessRow = memo(function ProcessRow({
  process, isExpanded, isNew, top, height, advancedMode,
  onToggleExpand, onKill, onKillTree, onReveal, onContextMenu,
}: ProcessRowProps) {
  const [detail, setDetail] = useState<ProcessInfo | null>(null);

  const handleExpand = useCallback(() => {
    onToggleExpand(process.pid);
    if (!isExpanded && !detail) {
      getProcessDetail(process.pid).then(setDetail).catch(() => {});
    }
  }, [process.pid, isExpanded, detail, onToggleExpand]);

  return (
    <div
      className={`process-row${isExpanded ? " process-row-expanded" : ""}${process.is_hermes_session ? " process-row-hermes" : ""}${process.is_zombie ? " process-row-zombie" : ""}${isNew ? " process-row-new" : ""}`}
      style={{ position: "absolute", top, height, width: "100%" }}
      onClick={handleExpand}
      onContextMenu={(e) => onContextMenu(e, process)}
    >
      <div className="process-row-main">
        <span className="process-col process-col-name" title={`${process.name} (PID ${process.pid})`}>
          {process.is_protected && <span className="process-lock" title="Protected">&#128274;</span>}
          {process.name}
        </span>
        <span className="process-col process-col-cpu" style={{ color: cpuColor(process.cpu_percent) }}>
          {process.cpu_percent.toFixed(1)}%
        </span>
        <span className="process-col process-col-mem">
          {formatBytes(process.memory_bytes)}
        </span>
        <span className={`process-col process-col-status process-status-${process.status}`}>{process.status}</span>
      </div>
      {isExpanded && (
        <div className="process-row-detail" onClick={(e) => e.stopPropagation()}>
          <div className="process-detail-info">
            <div><strong>PID:</strong> {process.pid} &nbsp; <strong>PPID:</strong> {process.ppid} &nbsp; <strong>User:</strong> {process.user}</div>
            <div><strong>Mem%:</strong> <span style={{ color: memColor(process.memory_percent) }}>{process.memory_percent.toFixed(1)}%</span> &nbsp; <strong>Threads:</strong> {process.threads} &nbsp; <strong>Uptime:</strong> {formatUptime(process.start_time)}</div>
            <div><strong>Path:</strong> {(detail || process).exe_path || "-"}</div>
            <div><strong>CMD:</strong> {(detail || process).cmd_line.join(" ") || "-"}</div>
            {detail?.fd_count != null && <div><strong>FDs:</strong> {detail.fd_count}</div>}
          </div>
          <div className="process-detail-actions">
            <button
              className="process-action-btn"
              disabled={process.is_protected}
              title={process.is_protected ? "Protected process" : "Send SIGTERM"}
              onClick={() => onKill(process.pid, "SIGTERM", process.name)}
            >
              SIGTERM
            </button>
            {advancedMode && (
              <>
                <button
                  className="process-action-btn process-action-danger"
                  disabled={process.is_protected}
                  title={process.is_protected ? "Protected process" : "Send SIGKILL (force)"}
                  onClick={() => onKill(process.pid, "SIGKILL", process.name)}
                >
                  SIGKILL
                </button>
                <button
                  className="process-action-btn process-action-danger"
                  disabled={process.is_protected}
                  title={process.is_protected ? "Protected process" : "Kill process tree"}
                  onClick={() => onKillTree(process.pid, "SIGTERM", process.name)}
                >
                  Kill Tree
                </button>
              </>
            )}
            <button
              className="process-action-btn"
              onClick={() => navigator.clipboard.writeText(String(process.pid)).catch(console.error)}
              title="Copy PID"
            >
              Copy PID
            </button>
            {(detail || process).exe_path && (
              <button
                className="process-action-btn"
                onClick={() => onReveal((detail || process).exe_path)}
                title="Reveal in Finder"
              >
                Finder
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  // Custom comparator — only re-render on meaningful changes
  return (
    prev.process.cpu_percent === next.process.cpu_percent &&
    prev.process.memory_bytes === next.process.memory_bytes &&
    prev.process.memory_percent === next.process.memory_percent &&
    prev.process.status === next.process.status &&
    prev.process.threads === next.process.threads &&
    prev.process.is_hermes_session === next.process.is_hermes_session &&
    prev.isExpanded === next.isExpanded &&
    prev.isNew === next.isNew &&
    prev.top === next.top &&
    prev.height === next.height &&
    prev.advancedMode === next.advancedMode &&
    prev.onKill === next.onKill &&
    prev.onKillTree === next.onKillTree &&
    prev.onReveal === next.onReveal &&
    prev.onContextMenu === next.onContextMenu
  );
});

// ─── KillConfirmDialog ──────────────────────────────────────────────

interface KillConfirmDialogProps {
  processName: string;
  pid: number;
  signal: string;
  isTree: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  skipConfirm: boolean;
  onToggleSkip: () => void;
}

function KillConfirmDialog({ processName, pid, signal, isTree, onConfirm, onCancel, skipConfirm, onToggleSkip }: KillConfirmDialogProps) {
  const isDangerous = signal === "SIGKILL" || isTree;
  return (
    <div className="close-dialog-backdrop" onClick={onCancel}>
      <div className="close-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="close-dialog-title">
          {isTree ? "Kill Process Tree" : "Kill Process"}
        </div>
        <div className="close-dialog-body">
          {isTree
            ? `Kill "${processName}" (PID ${pid}) and all its children with ${signal}?`
            : `Send ${signal} to "${processName}" (PID ${pid})?`
          }
          {isDangerous && (
            <div className="process-kill-warning">
              This may cause data loss. The process will be terminated immediately.
            </div>
          )}
        </div>
        <label className="close-dialog-checkbox">
          <input type="checkbox" checked={skipConfirm} onChange={onToggleSkip} />
          Don't ask again this session
        </label>
        <div className="close-dialog-actions">
          <button className="close-dialog-btn" onClick={onCancel}>Cancel</button>
          <button className="close-dialog-btn close-dialog-btn-confirm" onClick={onConfirm}>
            {isTree ? "Kill Tree" : "Kill"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ProcessPanel ───────────────────────────────────────────────────

interface ProcessPanelProps {
  visible: boolean;
}

export function ProcessPanel({ visible }: ProcessPanelProps) {
  const { snapshot, error, newPids } = useProcesses(visible);

  // Local state
  const [sortField, setSortField] = useState<ProcessSortField>("cpu_percent");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [filter, setFilter] = useState<ProcessFilter>({
    search: "", cpuThreshold: 0, memThreshold: 0, showHermesOnly: false, showZombiesOnly: false,
  });
  const [expandedPids, setExpandedPids] = useState<Set<number>>(new Set());
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advancedWarningShown, setAdvancedWarningShown] = useState(false);
  const [skipKillConfirm, setSkipKillConfirm] = useState(false);
  const [pendingKill, setPendingKill] = useState<{ pid: number; signal: string; name: string; isTree: boolean } | null>(null);

  // Resize state
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const resizeRafRef = useRef<number | null>(null);

  // Context menu (native popup)
  const contextProcessRef = useRef<ProcessInfo | null>(null);

  // Virtualization
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // Process + sort + filter
  const filteredProcesses = useMemo(() => {
    if (!snapshot) return [];
    const filtered = filterProcesses(snapshot.processes, filter);
    return sortProcesses(filtered, sortField, sortDirection);
  }, [snapshot, filter, sortField, sortDirection]);

  // Row positions (accounts for expanded rows)
  const rowPositions = useMemo(() => {
    const positions: { top: number; height: number }[] = [];
    let y = 0;
    for (const p of filteredProcesses) {
      const h = expandedPids.has(p.pid) ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT;
      positions.push({ top: y, height: h });
      y += h;
    }
    return positions;
  }, [filteredProcesses, expandedPids]);

  const totalHeight = rowPositions.length > 0
    ? rowPositions[rowPositions.length - 1].top + rowPositions[rowPositions.length - 1].height
    : 0;

  // Visible range
  const containerHeight = scrollRef.current?.clientHeight || 600;
  const visibleRange = useMemo(() => {
    let startIdx = 0;
    let endIdx = filteredProcesses.length - 1;
    // Binary search for start
    for (let i = 0; i < rowPositions.length; i++) {
      if (rowPositions[i].top + rowPositions[i].height > scrollTop) {
        startIdx = Math.max(0, i - OVERSCAN);
        break;
      }
    }
    // Find end
    for (let i = startIdx; i < rowPositions.length; i++) {
      if (rowPositions[i].top > scrollTop + containerHeight) {
        endIdx = Math.min(filteredProcesses.length - 1, i + OVERSCAN);
        break;
      }
    }
    return { startIdx, endIdx };
  }, [scrollTop, containerHeight, rowPositions, filteredProcesses.length]);

  const handleSort = useCallback((field: ProcessSortField) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setSortDirection("desc");
      return field;
    });
  }, []);

  const toggleExpand = useCallback((pid: number) => {
    setExpandedPids((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid); else next.add(pid);
      return next;
    });
  }, []);

  const handleKillRequest = useCallback((pid: number, signal: string, name: string, isTree: boolean) => {
    if (skipKillConfirm) {
      (isTree ? killProcessTree(pid, signal) : killProcess(pid, signal)).catch(console.error);
    } else {
      setPendingKill({ pid, signal, name, isTree });
    }
  }, [skipKillConfirm]);

  const confirmKill = useCallback(() => {
    if (!pendingKill) return;
    const { pid, signal, isTree } = pendingKill;
    (isTree ? killProcessTree(pid, signal) : killProcess(pid, signal)).catch(console.error);
    setPendingKill(null);
  }, [pendingKill]);

  const handleAdvancedToggle = useCallback(() => {
    if (!advancedMode && !advancedWarningShown) {
      setAdvancedWarningShown(true);
    }
    setAdvancedMode((v) => !v);
  }, [advancedMode, advancedWarningShown]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = null;
        const delta = ev.clientX - startX;
        const newWidth = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, startWidth + delta));
        setPanelWidth(newWidth);
      });
    };

    const onMouseUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [panelWidth]);

  const handleContextAction = useCallback((actionId: string) => {
    const proc = contextProcessRef.current;
    if (!proc) return;
    switch (actionId) {
      case "process.copy-pid":
        navigator.clipboard.writeText(String(proc.pid)).catch(console.error);
        break;
      case "process.sigterm":
        handleKillRequest(proc.pid, "SIGTERM", proc.name, false);
        break;
      case "process.sigkill":
        handleKillRequest(proc.pid, "SIGKILL", proc.name, false);
        break;
      case "process.kill-tree":
        handleKillRequest(proc.pid, "SIGTERM", proc.name, true);
        break;
      case "process.reveal":
        if (proc.exe_path) revealProcessInFinder(proc.exe_path).catch(console.error);
        break;
    }
  }, [handleKillRequest]);

  const { showMenu } = useContextMenu(handleContextAction);

  const handleRowContextMenu = useCallback((e: React.MouseEvent, process: ProcessInfo) => {
    contextProcessRef.current = process;
    const items = buildProcessMenuItems(
      { pid: process.pid, is_protected: process.is_protected, exe_path: process.exe_path || undefined },
      advancedMode,
    );
    showMenu(e, items);
  }, [advancedMode, showMenu]);

  if (!visible) return null;

  return (
    <div className="process-panel" style={{ width: panelWidth }}>
      {/* Toolbar */}
      <div className="process-toolbar">
        <span className="process-panel-title">PROCESSES</span>
        <input
          className="process-search"
          type="text"
          placeholder="Search by name or PID..."
          value={filter.search}
          onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))}
        />
        <div className="process-toolbar-toggles">
          <button
            className={`process-toggle${filter.showHermesOnly ? " process-toggle-active" : ""}`}
            onClick={() => setFilter((f) => ({ ...f, showHermesOnly: !f.showHermesOnly }))}
            title="Show Hermes sessions only"
            aria-pressed={filter.showHermesOnly}
          >
            Hermes
          </button>
          <button
            className={`process-toggle${filter.showZombiesOnly ? " process-toggle-active" : ""}`}
            onClick={() => setFilter((f) => ({ ...f, showZombiesOnly: !f.showZombiesOnly }))}
            title="Show zombie processes only"
            aria-pressed={filter.showZombiesOnly}
          >
            Zombies
          </button>
          <button
            className={`process-toggle${advancedMode ? " process-toggle-active process-toggle-danger" : ""}`}
            onClick={handleAdvancedToggle}
            title="Advanced mode: enables SIGKILL and Kill Tree"
            aria-pressed={advancedMode}
          >
            Advanced
          </button>
        </div>
      </div>

      {/* Summary */}
      {snapshot && (
        <div className="process-summary">
          <span>
            CPU: <span style={{ color: cpuColor(snapshot.total_cpu_percent) }}>
              {snapshot.total_cpu_percent.toFixed(1)}%
            </span>
          </span>
          <span>
            Mem: <span style={{ color: memColor((snapshot.total_memory_bytes / snapshot.total_memory_available) * 100) }}>
              {formatBytes(snapshot.total_memory_bytes)}
            </span>
            {" / "}
            {formatBytes(snapshot.total_memory_available)}
          </span>
          <span>{filteredProcesses.length} processes</span>
        </div>
      )}

      {error && <div className="process-error">{error}</div>}

      {/* Horizontally scrollable table area */}
      <div className="process-table-hscroll">
        {/* Table Header */}
        <div className="process-table-header">
          {([
            ["name", "Name"],
            ["cpu_percent", "CPU%"],
            ["memory_bytes", "Mem"],
            ["status", "Status"],
          ] as [ProcessSortField, string][]).map(([field, label]) => (
            <button
              key={field}
              className={`process-col-header process-col-${field === "memory_bytes" ? "mem" : field}${sortField === field ? " process-col-sorted" : ""}`}
              onClick={() => handleSort(field)}
            >
              {label}
              {sortField === field && (
                <span className="process-sort-arrow">{sortDirection === "asc" ? " \u25B2" : " \u25BC"}</span>
              )}
            </button>
          ))}
        </div>

        {/* Virtualized Table */}
        <div
          className="process-table-scroll"
          ref={scrollRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div style={{ height: totalHeight, position: "relative" }}>
            {filteredProcesses.slice(visibleRange.startIdx, visibleRange.endIdx + 1).map((proc, i) => {
              const idx = visibleRange.startIdx + i;
              const pos = rowPositions[idx];
              return (
                <ProcessRow
                  key={proc.pid}
                  process={proc}
                  isExpanded={expandedPids.has(proc.pid)}
                  isNew={newPids.has(proc.pid)}
                  top={pos.top}
                  height={pos.height}
                  advancedMode={advancedMode}
                  onToggleExpand={toggleExpand}
                  onKill={(pid, signal, name) => handleKillRequest(pid, signal, name, false)}
                  onKillTree={(pid, signal, name) => handleKillRequest(pid, signal, name, true)}
                  onReveal={revealProcessInFinder}
                  onContextMenu={handleRowContextMenu}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Resize handle */}
      <div className="process-panel-resize-handle" onMouseDown={handleResizeMouseDown} />

      {/* Kill Confirm Dialog */}
      {pendingKill && (
        <KillConfirmDialog
          processName={pendingKill.name}
          pid={pendingKill.pid}
          signal={pendingKill.signal}
          isTree={pendingKill.isTree}
          onConfirm={confirmKill}
          onCancel={() => setPendingKill(null)}
          skipConfirm={skipKillConfirm}
          onToggleSkip={() => setSkipKillConfirm((v) => !v)}
        />
      )}
    </div>
  );
}
