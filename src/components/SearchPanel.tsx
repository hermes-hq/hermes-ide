import { useState, useEffect, useRef, useCallback } from "react";
import { useSession } from "../state/SessionContext";
import { searchProject } from "../api/git";
import { getSessionProjects } from "../api/projects";
import type { SearchResponse, SearchFileResult } from "../types/git";
import "../styles/components/SearchPanel.css";
import { useContextMenu, buildSearchResultMenuItems } from "../hooks/useContextMenu";
import { useTextContextMenu } from "../hooks/useTextContextMenu";

// ─── Pure Helpers (exported for testing) ──────────────────────────────

export function highlightMatch(
  line: string,
  startChar: number,
  endChar: number,
): { before: string; match: string; after: string } {
  return {
    before: line.slice(0, startChar),
    match: line.slice(startChar, endChar),
    after: line.slice(endChar),
  };
}

export function formatResultCount(total: number, fileCount: number): string {
  const rWord = total === 1 ? "result" : "results";
  const fWord = fileCount === 1 ? "file" : "files";
  return `${total} ${rWord} in ${fileCount} ${fWord}`;
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  return debounced as unknown as T;
}

// ─── Component ────────────────────────────────────────────────────────

interface SearchPanelProps {
  visible: boolean;
}

export function SearchPanel({ visible }: SearchPanelProps) {
  const { state } = useSession();
  const [query, setQuery] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [realmId, setRealmId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState(320);
  const resizing = useRef(false);

  const contextPathRef = useRef<string>("");
  const handleSearchAction = useCallback((actionId: string) => {
    const path = contextPathRef.current;
    if (!path) return;
    switch (actionId) {
      case "search.copy-path":
        navigator.clipboard.writeText(path).catch(console.error);
        break;
    }
  }, []);
  const { showMenu: showSearchMenu } = useContextMenu(handleSearchAction);
  const { onContextMenu: textContextMenu } = useTextContextMenu();

  const sessionId = state.activeSessionId;

  // Load primary project (realm) for active session
  useEffect(() => {
    if (!sessionId) {
      setRealmId(null);
      return;
    }
    getSessionProjects(sessionId)
      .then((projects) => {
        if (projects.length > 0) {
          setRealmId(projects[0].id);
        } else {
          setRealmId(null);
        }
      })
      .catch(() => setRealmId(null));
  }, [sessionId]);

  // Auto-focus input on mount
  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [visible]);

  // Debounced search effect
  // Uses a `cancelled` flag so that stale responses from previous renders
  // (or after unmount) are silently discarded.
  useEffect(() => {
    let cancelled = false;

    if (!sessionId || !realmId) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (query.length < 2) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setResults(null); // Clear stale results from previous query immediately

    const timer = setTimeout(() => {
      searchProject(sessionId, realmId, query, isRegex, caseSensitive)
        .then((res) => {
          if (cancelled) return;
          setResults(res);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(String(err));
          setLoading(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, isRegex, caseSensitive, sessionId, realmId]);

  // Resize handle
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const delta = ev.clientX - startX;
      setWidth(Math.max(240, Math.min(600, startW + delta)));
    };
    const onUp = () => {
      resizing.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width]);

  const toggleCollapse = (path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!visible) return null;

  return (
    <div className="search-panel" style={{ width }}>
      <div className="search-panel-resize-handle" onMouseDown={onResizeStart} />
      <div className="search-toolbar">
        <div className="search-panel-title">Search</div>
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          onContextMenu={textContextMenu}
        />
        <div className="search-toggles">
          <button
            className={`search-toggle${caseSensitive ? " search-toggle-active" : ""}`}
            onClick={() => setCaseSensitive((v) => !v)}
            title="Match Case"
            aria-label="Match case"
            aria-pressed={caseSensitive}
          >
            Aa
          </button>
          <button
            className={`search-toggle${isRegex ? " search-toggle-active" : ""}`}
            onClick={() => setIsRegex((v) => !v)}
            title="Use Regular Expression"
            aria-label="Use regular expression"
            aria-pressed={isRegex}
          >
            .*
          </button>
        </div>
      </div>

      {/* Summary */}
      {(!sessionId || !realmId) && (
        <div className="search-no-session">Open a session to search</div>
      )}
      {sessionId && realmId && loading && (
        <div className="search-summary">Searching…</div>
      )}
      {sessionId && realmId && !loading && error && (
        <div className="search-error">{error}</div>
      )}
      {sessionId && realmId && !loading && !error && results && (
        <div className="search-summary">
          {formatResultCount(results.total_matches, results.results.length)}
        </div>
      )}
      {sessionId && realmId && !loading && !error && results && results.truncated && (
        <div className="search-truncated">Results capped at 500. Narrow your search.</div>
      )}
      {sessionId && realmId && !loading && !error && query.length >= 2 && results && results.total_matches === 0 && (
        <div className="search-empty">No results found</div>
      )}

      {/* Results */}
      <div className="search-results">
        {results?.results.map((file) => (
          <FileGroup
            key={file.path}
            file={file}
            collapsed={collapsedFiles.has(file.path)}
            onToggle={() => toggleCollapse(file.path)}
            onContextMenu={(e) => {
              contextPathRef.current = file.path;
              showSearchMenu(e, buildSearchResultMenuItems({ path: file.path }));
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── FileGroup sub-component ──────────────────────────────────────────

function FileGroup({
  file,
  collapsed,
  onToggle,
  onContextMenu,
}: {
  file: SearchFileResult;
  collapsed: boolean;
  onToggle: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="search-file-group">
      <div className="search-file-header" onClick={onToggle} onContextMenu={onContextMenu}>
        <span className="search-file-chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="search-file-path" title={file.path}>{file.path}</span>
        <span className="search-match-count">{file.matches.length}</span>
      </div>
      {!collapsed &&
        file.matches.map((m, i) => {
          const parts = highlightMatch(m.line_content, m.match_start, m.match_end);
          return (
            <div key={`${m.line_number}-${i}`} className="search-match-row">
              <span className="search-match-line-num">{m.line_number}</span>
              <span className="search-match-content">
                {parts.before}
                <span className="search-match-highlight">{parts.match}</span>
                {parts.after}
              </span>
            </div>
          );
        })}
    </div>
  );
}
