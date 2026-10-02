import { useState, useEffect, useRef, useCallback } from "react";
import { useSession } from "../state/SessionContext";
import { searchProject } from "../api/git";
import { useSessionProjects } from "../hooks/useSessionProjects";
import { useI18n } from "../i18n/I18nProvider";
import { Button } from "./ui";
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

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function formatResultCount(total: number, fileCount: number, t?: Translate): string {
  if (t) {
    const results = t(total === 1 ? "search.result" : "search.results", { count: total });
    const files = t(fileCount === 1 ? "search.file" : "search.files", { count: fileCount });
    return t("search.resultCount", { results, files });
  }
  const rWord = total === 1 ? "result" : "results";
  const fWord = fileCount === 1 ? "file" : "files";
  return `${total} ${rWord} in ${fileCount} ${fWord}`;
}

/**
 * What the panel needs before it can search: a session, then a project in
 * it. "loading" while the session's projects are read: nothing is said
 * yet and the field stays usable (it has the keyboard on open).
 */
export function searchBlocker(sessionId: string | null, projectId: string | null, projectsLoaded = true): "no-session" | "loading" | "no-project" | null {
  if (!sessionId) return "no-session";
  if (!projectsLoaded) return "loading";
  if (!projectId) return "no-project";
  return null;
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
  /** Opens the picker that adds a project to the active session. */
  onAddProject?: () => void;
}

export function SearchPanel({ visible, onAddProject }: SearchPanelProps) {
  const { t } = useI18n();
  const { state } = useSession();
  const [query, setQuery] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
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
  // The session's primary project; follows a project added or removed
  // while the panel is open.
  const { projects, loaded: projectsLoaded } = useSessionProjects(sessionId);
  const projectId = projectsLoaded ? projects[0]?.id ?? null : null;
  const blocker = searchBlocker(sessionId, projectId, projectsLoaded);

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

    if (!sessionId || !projectId) {
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
      searchProject(sessionId, projectId, query, isRegex, caseSensitive)
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
  }, [query, isRegex, caseSensitive, sessionId, projectId]);

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
        <div className="search-panel-title">{t("search.title")}</div>
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder={t("search.placeholder")}
          aria-label={t("search.placeholder")}
          disabled={blocker === "no-session" || blocker === "no-project"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          onContextMenu={textContextMenu}
        />
        <div className="search-toggles">
          <button
            className={`search-toggle${caseSensitive ? " search-toggle-active" : ""}`}
            onClick={() => setCaseSensitive((v) => !v)}
            title={t("search.matchCase")}
            aria-label={t("search.matchCase")}
            aria-pressed={caseSensitive}
          >
            <span aria-hidden="true">{"Aa"}</span>
          </button>
          <button
            className={`search-toggle${isRegex ? " search-toggle-active" : ""}`}
            onClick={() => setIsRegex((v) => !v)}
            title={t("search.regex")}
            aria-label={t("search.regex")}
            aria-pressed={isRegex}
          >
            .*
          </button>
        </div>
      </div>

      {/* Summary */}
      {blocker === "no-session" && <div className="search-no-session">{t("search.noSession")}</div>}
      {blocker === "no-project" && (
        <div className="search-no-session search-no-project">
          <span>{t("search.noProject")}</span>
          {onAddProject && (
            <Button size="sm" className="search-add-project" onClick={onAddProject}>
              {t("search.addProject")}
            </Button>
          )}
        </div>
      )}
      {sessionId && projectId && loading && (
        <div className="search-summary">{t("search.searching")}</div>
      )}
      {sessionId && projectId && !loading && error && (
        <div className="search-error">{error}</div>
      )}
      {sessionId && projectId && !loading && !error && results && (
        <div className="search-summary">
          {formatResultCount(results.total_matches, results.results.length, t)}
        </div>
      )}
      {sessionId && projectId && !loading && !error && results && results.truncated && (
        <div className="search-truncated">{t("search.truncated", { count: 500 })}</div>
      )}
      {sessionId && projectId && !loading && !error && query.length >= 2 && results && results.total_matches === 0 && (
        <div className="search-empty">{t("search.noResults")}</div>
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
