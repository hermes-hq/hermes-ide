import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ExecutionNode } from "../state/SessionContext";

interface ExecutionTimelineProps {
  sessionId: string;
  color: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() / 1000) - ts);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function kindIcon(kind: string): string {
  switch (kind) {
    case "command": return "$";
    case "ai_interaction": return "~";
    default: return ">";
  }
}

export function ExecutionTimeline({ sessionId, color }: ExecutionTimelineProps) {
  const [nodes, setNodes] = useState<ExecutionNode[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const offsetRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load initial nodes
  useEffect(() => {
    setLoading(true);
    setNodes([]);
    offsetRef.current = 0;
    invoke("get_execution_nodes", { sessionId, limit: 50, offset: 0 })
      .then((result) => {
        const fetched = result as ExecutionNode[];
        setNodes(fetched);
        offsetRef.current = fetched.length;
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [sessionId]);

  // Listen for new execution nodes in real-time
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<ExecutionNode>(`execution-node-${sessionId}`, (event) => {
      setNodes((prev) => {
        // Prepend (newest first since query is DESC)
        const exists = prev.find((n) => n.id === event.payload.id);
        if (exists) return prev;
        return [event.payload, ...prev];
      });
      offsetRef.current += 1;
    }).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
  }, [sessionId]);

  // Load more on scroll to bottom
  const loadMore = useCallback(() => {
    invoke("get_execution_nodes", { sessionId, limit: 50, offset: offsetRef.current })
      .then((result) => {
        const fetched = result as ExecutionNode[];
        if (fetched.length > 0) {
          setNodes((prev) => {
            const existingIds = new Set(prev.map((n) => n.id));
            const newNodes = fetched.filter((n) => !existingIds.has(n.id));
            return [...prev, ...newNodes];
          });
          offsetRef.current += fetched.length;
        }
      })
      .catch(console.error);
  }, [sessionId]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 20) {
      loadMore();
    }
  }, [loadMore]);

  return (
    <div className="execution-timeline" ref={containerRef} onScroll={handleScroll}>
      {loading && nodes.length === 0 && (
        <div className="timeline-empty">Loading timeline...</div>
      )}
      {!loading && nodes.length === 0 && (
        <div className="timeline-empty">No execution nodes yet</div>
      )}
      {nodes.map((node) => (
        <div key={node.id}>
          <div
            className="timeline-node"
            onClick={() => setExpandedId(expandedId === node.id ? null : node.id)}
          >
            <span className="timeline-kind mono" style={{ color }}>{kindIcon(node.kind)}</span>
            <span className="timeline-input mono truncate">
              {node.input || node.kind}
            </span>
            {node.exit_code != null && (
              <span className={`timeline-exit-badge ${node.exit_code === 0 ? "timeline-exit-ok" : "timeline-exit-err"}`}>
                {node.exit_code}
              </span>
            )}
            {node.exit_code == null && (
              <span className="timeline-exit-badge" style={{ background: "var(--bg-3)", color: "var(--text-3)" }}>—</span>
            )}
            <span className="timeline-duration mono">{formatDuration(node.duration_ms)}</span>
            <span className="timeline-time">{timeAgo(node.timestamp)}</span>
          </div>
          {expandedId === node.id && (
            <div className="timeline-output mono">
              {node.output_summary ? (
                node.output_summary
              ) : (
                <span className="text-muted">No output captured</span>
              )}
              <div className="timeline-output-meta">
                <span>{node.kind}</span>
                {node.working_dir && <span className="truncate">{node.working_dir}</span>}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
