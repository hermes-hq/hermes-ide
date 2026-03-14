import { useState, useEffect, useCallback, useRef } from "react";
import "../styles/components/FileExplorer.css";
import { useSession } from "../state/SessionContext";
import { getSessionProjects } from "../api/projects";
import { openFileInEditor, sshListDirectory } from "../api/git";
import { sshUploadFile, sshDownloadFile } from "../api/sessions";
import { getSettings } from "../api/settings";
import { useFileExplorer, filterEntries } from "../hooks/useFileTree";
import type { FileEntry, SshFileEntry } from "../types/git";
import { useContextMenu, buildFileExplorerMenuItems, buildEmptyAreaMenuItems } from "../hooks/useContextMenu";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { save } from "@tauri-apps/plugin-dialog";

// ─── File Icons by Extension ────────────────────────────────────────

const EXT_ICONS: Record<string, string> = {
  // JavaScript / TypeScript
  ts: "TS", tsx: "TX", js: "JS", jsx: "JX", mjs: "JS", cjs: "JS",
  // Rust
  rs: "RS",
  // Python
  py: "PY",
  // Go
  go: "GO",
  // Ruby
  rb: "RB",
  // Java / Kotlin
  java: "JA", kt: "KT", kts: "KT",
  // C / C++
  c: "C", h: "H", cpp: "C+", hpp: "H+", cc: "C+",
  // C#
  cs: "C#",
  // Swift
  swift: "SW",
  // Dart
  dart: "DA",
  // Web
  html: "HT", htm: "HT", css: "CS", scss: "SC", sass: "SA", less: "LE",
  // Data / Config
  json: "{}", yaml: "YA", yml: "YA", toml: "TO", xml: "XM", csv: "CS",
  // Markdown / Docs
  md: "MD", mdx: "MD", txt: "TX", rst: "RS",
  // Shell
  sh: "SH", bash: "SH", zsh: "SH", fish: "SH",
  // Docker
  dockerfile: "DK",
  // SQL
  sql: "SQ",
  // Lua
  lua: "LU",
  // PHP
  php: "PH",
  // Elixir / Erlang
  ex: "EX", exs: "EX", erl: "ER",
  // Images
  png: "IM", jpg: "IM", jpeg: "IM", gif: "IM", svg: "SV", webp: "IM", ico: "IM",
  // Lock / Config
  lock: "LK",
};

const EXT_COLORS: Record<string, string> = {
  ts: "file-icon-blue", tsx: "file-icon-blue", js: "file-icon-yellow", jsx: "file-icon-yellow",
  mjs: "file-icon-yellow", cjs: "file-icon-yellow",
  rs: "file-icon-orange", py: "file-icon-green", go: "file-icon-cyan",
  rb: "file-icon-red", java: "file-icon-red", kt: "file-icon-purple",
  c: "file-icon-blue", h: "file-icon-blue", cpp: "file-icon-blue", hpp: "file-icon-blue",
  cs: "file-icon-purple", swift: "file-icon-orange", dart: "file-icon-cyan",
  html: "file-icon-orange", htm: "file-icon-orange",
  css: "file-icon-blue", scss: "file-icon-pink", sass: "file-icon-pink",
  json: "file-icon-yellow", yaml: "file-icon-green", yml: "file-icon-green",
  toml: "file-icon-orange", xml: "file-icon-orange",
  md: "file-icon-blue", mdx: "file-icon-blue",
  sh: "file-icon-green", bash: "file-icon-green", zsh: "file-icon-green",
  sql: "file-icon-blue", lua: "file-icon-blue", php: "file-icon-purple",
  ex: "file-icon-purple", exs: "file-icon-purple",
  svg: "file-icon-yellow", lock: "file-icon-dim",
};

function getFileIcon(name: string, isDir: boolean): { label: string; colorClass: string } {
  if (isDir) return { label: "\uD83D\uDCC1", colorClass: "" };
  const ext = name.split(".").pop()?.toLowerCase() || "";
  // Special names
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return { label: "DK", colorClass: "file-icon-cyan" };
  if (lower === "makefile") return { label: "MK", colorClass: "file-icon-orange" };
  if (lower === "license" || lower === "licence") return { label: "LI", colorClass: "file-icon-dim" };

  const label = EXT_ICONS[ext];
  if (label) return { label, colorClass: EXT_COLORS[ext] || "file-icon-dim" };
  return { label: "\uD83D\uDCC4", colorClass: "" };
}

// ─── Components ─────────────────────────────────────────────────────

interface FileExplorerPanelProps {
  visible: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  modified: "git-status-modified",
  added: "git-status-added",
  deleted: "git-status-deleted",
  renamed: "git-status-renamed",
  untracked: "git-status-untracked",
  conflicted: "git-status-conflicted",
};

const STATUS_LETTERS: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "!",
};

interface ProjectTreeProps {
  sessionId: string;
  realmId: string;
  projectName: string;
  showHidden: boolean;
  searchQuery: string;
  onFileContextMenu?: (e: React.MouseEvent, entry: FileEntry) => void;
  onFilePreview?: (realmId: string, filePath: string) => void;
}

function ProjectTree({ sessionId, realmId, projectName, showHidden, searchQuery, onFileContextMenu, onFilePreview }: ProjectTreeProps) {
  const { expandedDirs, loadingDirs, error, loadDirectory, toggleDir, refresh, getEntries } = useFileExplorer(sessionId, realmId);

  // Load root on mount
  useEffect(() => {
    loadDirectory("");
  }, [loadDirectory]);

  const rootEntries = getEntries("");
  const filtered = rootEntries ? filterEntries(rootEntries, searchQuery, showHidden) : null;

  const handleFileClick = useCallback((entry: FileEntry) => {
    if (entry.is_dir) {
      toggleDir(entry.path);
    } else if (onFilePreview) {
      onFilePreview(realmId, entry.path);
    }
  }, [realmId, toggleDir, onFilePreview]);

  return (
    <div className="file-explorer-project">
      <div className="file-explorer-project-header">
        <span className="file-explorer-project-name">{projectName}</span>
        <button className="file-explorer-refresh" onClick={refresh} title="Refresh">&#8635;</button>
      </div>
      {error && <div className="file-explorer-error">{error}</div>}
      {!filtered && !error && <div className="file-explorer-empty">Loading...</div>}
      {filtered && filtered.length === 0 && <div className="file-explorer-empty">No files</div>}
      {filtered && filtered.map((entry) => (
        <FileTreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          expandedDirs={expandedDirs}
          loadingDirs={loadingDirs}
          getEntries={getEntries}
          showHidden={showHidden}
          searchQuery={searchQuery}
          onToggleDir={toggleDir}
          onFileClick={handleFileClick}
          onContextMenu={onFileContextMenu}
        />
      ))}
    </div>
  );
}

interface FileTreeNodeProps {
  entry: FileEntry;
  depth: number;
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  getEntries: (path: string) => FileEntry[] | null;
  showHidden: boolean;
  searchQuery: string;
  onToggleDir: (path: string) => void;
  onFileClick: (entry: FileEntry) => void;
  onContextMenu?: (e: React.MouseEvent, entry: FileEntry) => void;
}

function FileTreeNode({ entry, depth, expandedDirs, loadingDirs, getEntries, showHidden, searchQuery, onToggleDir, onFileClick, onContextMenu }: FileTreeNodeProps) {
  const isExpanded = expandedDirs.has(entry.path);
  const isLoading = loadingDirs.has(entry.path);
  const children = entry.is_dir && isExpanded ? getEntries(entry.path) : null;
  const filteredChildren = children ? filterEntries(children, searchQuery, showHidden) : null;

  const statusClass = entry.git_status ? STATUS_COLORS[entry.git_status] || "" : "";
  const statusLetter = entry.git_status ? STATUS_LETTERS[entry.git_status] || "" : "";
  const icon = getFileIcon(entry.name, entry.is_dir);

  return (
    <>
      <div
        className={`file-tree-node ${entry.is_hidden ? "file-tree-hidden" : ""}`}
        style={{ paddingLeft: `${(depth * 16) + 8}px` }}
        onClick={() => onFileClick(entry)}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, entry) : undefined}
        title={entry.path}
      >
        {entry.is_dir ? (
          <span className={`file-tree-chevron ${isExpanded ? "file-tree-chevron-open" : ""}`}>&#9656;</span>
        ) : (
          <span className="file-tree-chevron-spacer" />
        )}
        {icon.colorClass ? (
          <span className={`file-tree-icon-badge ${icon.colorClass}`}>{icon.label}</span>
        ) : (
          <span className="file-tree-icon">{icon.label}</span>
        )}
        <span className="file-tree-name">{entry.name}</span>
        {statusLetter && (
          <span className={`file-tree-git-badge ${statusClass}`}>{statusLetter}</span>
        )}
      </div>
      {entry.is_dir && isExpanded && (
        <>
          {isLoading && <div className="file-explorer-empty" style={{ paddingLeft: `${((depth + 1) * 16) + 8}px` }}>Loading...</div>}
          {filteredChildren && filteredChildren.map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              loadingDirs={loadingDirs}
              getEntries={getEntries}
              showHidden={showHidden}
              searchQuery={searchQuery}
              onToggleDir={onToggleDir}
              onFileClick={onFileClick}
              onContextMenu={onContextMenu}
            />
          ))}
        </>
      )}
    </>
  );
}

// ─── SSH Remote File Tree ────────────────────────────────────────────

/** Ref handle exposed by SshTree so the parent can trigger uploads. */
interface SshTreeHandle {
  rootPath: string | null;
  refresh: () => void;
}

interface SshTreeProps {
  sessionId: string;
  hostLabel: string;
  showHidden: boolean;
  searchQuery: string;
  onFilePreview?: (filePath: string) => void;
  onDownload?: (remotePath: string, fileName: string) => void;
  /** Called when rootPath or refresh changes so parent can drive uploads. */
  onHandleReady?: (handle: SshTreeHandle) => void;
  uploadStatus?: string | null;
  dropActive?: boolean;
}

function SshTree({ sessionId, hostLabel, showHidden, searchQuery, onFilePreview, onDownload, onHandleReady, uploadStatus, dropActive }: SshTreeProps) {
  const [entries, setEntries] = useState<Record<string, SshFileEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load root directory
  useEffect(() => {
    setError(null);
    setLoadingDirs(new Set(["__root__"]));
    sshListDirectory(sessionId)
      .then((items) => {
        // Infer root path from first entry
        if (items.length > 0) {
          const first = items[0].path;
          const parent = first.substring(0, first.lastIndexOf("/")) || "/";
          setRootPath(parent);
          setEntries({ [parent]: items });
        } else {
          setRootPath("/");
          setEntries({ "/": [] });
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingDirs(new Set()));
  }, [sessionId]);

  const loadDirectory = useCallback((path: string) => {
    setLoadingDirs((prev) => new Set(prev).add(path));
    sshListDirectory(sessionId, path)
      .then((items) => {
        setEntries((prev) => ({ ...prev, [path]: items }));
      })
      .catch(console.error)
      .finally(() => {
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      });
  }, [sessionId]);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!entries[path]) loadDirectory(path);
      }
      return next;
    });
  }, [entries, loadDirectory]);

  const handleFileClick = useCallback((entry: SshFileEntry) => {
    if (entry.is_dir) {
      toggleDir(entry.path);
    } else if (onFilePreview) {
      onFilePreview(entry.path);
    }
  }, [toggleDir, onFilePreview]);

  const rootEntries = rootPath ? entries[rootPath] : null;
  const filteredRoot = rootEntries ? filterSshEntries(rootEntries, searchQuery, showHidden) : null;

  const refresh = useCallback(() => {
    setEntries({});
    setExpandedDirs(new Set());
    setLoadingDirs(new Set(["__root__"]));
    sshListDirectory(sessionId)
      .then((items) => {
        if (items.length > 0) {
          const first = items[0].path;
          const parent = first.substring(0, first.lastIndexOf("/")) || "/";
          setRootPath(parent);
          setEntries({ [parent]: items });
        }
      })
      .catch(console.error)
      .finally(() => setLoadingDirs(new Set()));
  }, [sessionId]);

  // Notify parent of rootPath/refresh so it can drive uploads
  useEffect(() => {
    onHandleReady?.({ rootPath, refresh });
  }, [rootPath, refresh, onHandleReady]);

  return (
    <div className={`file-explorer-project${dropActive ? " file-explorer-drop-active" : ""}`}>
      <div className="file-explorer-project-header">
        <span className="file-explorer-project-name">{hostLabel}</span>
        <button className="file-explorer-refresh" onClick={refresh} title="Refresh">&#8635;</button>
      </div>
      {uploadStatus && <div className="file-explorer-upload-status">{uploadStatus}</div>}
      {dropActive && <div className="file-explorer-drop-overlay">Drop files to upload</div>}
      {error && <div className="file-explorer-error">{error}</div>}
      {!filteredRoot && !error && loadingDirs.size > 0 && <div className="file-explorer-empty">Loading...</div>}
      {filteredRoot && filteredRoot.length === 0 && <div className="file-explorer-empty">No files</div>}
      {filteredRoot && filteredRoot.map((entry) => (
        <SshFileTreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          expandedDirs={expandedDirs}
          loadingDirs={loadingDirs}
          entries={entries}
          showHidden={showHidden}
          searchQuery={searchQuery}
          onFileClick={handleFileClick}
          onDownload={onDownload}
        />
      ))}
    </div>
  );
}

interface SshFileTreeNodeProps {
  entry: SshFileEntry;
  depth: number;
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  entries: Record<string, SshFileEntry[]>;
  showHidden: boolean;
  searchQuery: string;
  onFileClick: (entry: SshFileEntry) => void;
  onDownload?: (remotePath: string, fileName: string) => void;
}

function SshFileTreeNode({ entry, depth, expandedDirs, loadingDirs, entries, showHidden, searchQuery, onFileClick, onDownload }: SshFileTreeNodeProps) {
  const isExpanded = expandedDirs.has(entry.path);
  const isLoading = loadingDirs.has(entry.path);
  const children = entry.is_dir && isExpanded ? entries[entry.path] : null;
  const filteredChildren = children ? filterSshEntries(children, searchQuery, showHidden) : null;
  const icon = getFileIcon(entry.name, entry.is_dir);

  return (
    <>
      <div
        className={`file-tree-node ${entry.is_hidden ? "file-tree-hidden" : ""}`}
        style={{ paddingLeft: `${(depth * 16) + 8}px` }}
        onClick={() => onFileClick(entry)}
        title={entry.path}
      >
        {entry.is_dir ? (
          <span className={`file-tree-chevron ${isExpanded ? "file-tree-chevron-open" : ""}`}>&#9656;</span>
        ) : (
          <span className="file-tree-chevron-spacer" />
        )}
        {icon.colorClass ? (
          <span className={`file-tree-icon-badge ${icon.colorClass}`}>{icon.label}</span>
        ) : (
          <span className="file-tree-icon">{icon.label}</span>
        )}
        <span className="file-tree-name">{entry.name}</span>
        {!entry.is_dir && onDownload && (
          <button
            className="file-tree-download-btn"
            onClick={(e) => { e.stopPropagation(); onDownload(entry.path, entry.name); }}
            title="Download file"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06Z" />
            </svg>
          </button>
        )}
      </div>
      {entry.is_dir && isExpanded && (
        <>
          {isLoading && <div className="file-explorer-empty" style={{ paddingLeft: `${((depth + 1) * 16) + 8}px` }}>Loading...</div>}
          {filteredChildren && filteredChildren.map((child) => (
            <SshFileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              loadingDirs={loadingDirs}
              entries={entries}
              showHidden={showHidden}
              searchQuery={searchQuery}
              onFileClick={onFileClick}
              onDownload={onDownload}
            />
          ))}
        </>
      )}
    </>
  );
}

function filterSshEntries(entries: SshFileEntry[], query: string, showHidden: boolean): SshFileEntry[] {
  return entries.filter((e) => {
    if (!showHidden && e.is_hidden) return false;
    if (query && !e.name.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
}

// ─── Types ──────────────────────────────────────────────────────────

interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

export function FileExplorerPanel({ visible }: FileExplorerPanelProps) {
  const { state, dispatch } = useSession();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [showHidden, setShowHidden] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const activeSession = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
  const isSSH = !!(activeSession?.ssh_info);

  const contextEntryRef = useRef<FileEntry | null>(null);
  const contextRealmRef = useRef<string>("");

  const handleFileExplorerAction = useCallback((actionId: string) => {
    const entry = contextEntryRef.current;
    if (!entry) return;
    switch (actionId) {
      case "file-explorer.copy-path":
        navigator.clipboard.writeText(entry.path).catch(console.error);
        break;
      case "file-explorer.open-terminal":
        // Open terminal at the entry's directory
        break;
      case "file-explorer.open-in-editor": {
        const realmId = contextRealmRef.current;
        const sessionId = state.activeSessionId;
        if (!sessionId || !realmId) break;
        getSettings()
          .then((s) => openFileInEditor(sessionId, realmId, entry.path, s.preferred_editor || null))
          .catch(console.error);
        break;
      }
    }
  }, [state.activeSessionId]);

  const { showMenu: showFileMenu } = useContextMenu(handleFileExplorerAction);

  const handleEmptyAreaAction = useCallback((_actionId: string) => {
    // Empty area actions (new file, new folder, etc.)
  }, []);

  const { showMenu: showEmptyMenu } = useContextMenu(handleEmptyAreaAction);

  const handleFileContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry, realmId?: string) => {
    contextEntryRef.current = entry;
    if (realmId) contextRealmRef.current = realmId;
    showFileMenu(e, buildFileExplorerMenuItems({ name: entry.name, is_dir: entry.is_dir, path: entry.path }));
  }, [showFileMenu]);

  const handleFilePreview = useCallback((realmId: string, filePath: string) => {
    dispatch({ type: "SET_FILE_PREVIEW", realmId, filePath });
  }, [dispatch]);

  const handleSshFilePreview = useCallback((filePath: string) => {
    // For SSH, use "__ssh__" as a sentinel realmId
    dispatch({ type: "SET_FILE_PREVIEW", realmId: "__ssh__", filePath });
  }, [dispatch]);

  const handleSshDownload = useCallback(async (remotePath: string, fileName: string) => {
    if (!state.activeSessionId) return;
    const localPath = await save({
      defaultPath: fileName,
    });
    if (!localPath) return;
    try {
      await sshDownloadFile(state.activeSessionId, remotePath, localPath);
    } catch (err) {
      console.error("[FileExplorer] Download failed:", err);
    }
  }, [state.activeSessionId]);

  // ─── SSH drag-drop upload ──────────────────────────────────────────
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const sshHandleRef = useRef<SshTreeHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleSshHandleReady = useCallback((handle: SshTreeHandle) => {
    sshHandleRef.current = handle;
  }, []);

  useEffect(() => {
    if (!isSSH || !visible || !state.activeSessionId) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const sid = state.activeSessionId;

    getCurrentWebview().onDragDropEvent(async (event) => {
      if (cancelled) return;
      const { type } = event.payload;

      // Only handle actual file drops (paths > 0), not session drags
      if (type === "enter" && event.payload.paths.length > 0) {
        // Hit-test: only activate when over the file explorer panel
        if (scrollRef.current) {
          const dpr = window.devicePixelRatio || 1;
          const x = event.payload.position.x / dpr;
          const y = event.payload.position.y / dpr;
          const rect = scrollRef.current.getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            setDropActive(true);
          }
        }
      } else if (type === "leave") {
        setDropActive(false);
      } else if (type === "over") {
        // Continuously hit-test during drag-over
        if (scrollRef.current) {
          const dpr = window.devicePixelRatio || 1;
          const x = event.payload.position.x / dpr;
          const y = event.payload.position.y / dpr;
          const rect = scrollRef.current.getBoundingClientRect();
          const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
          setDropActive(inside);
        }
      } else if (type === "drop" && event.payload.paths.length > 0) {
        setDropActive(false);

        // Hit-test on drop
        if (!scrollRef.current) return;
        const dpr = window.devicePixelRatio || 1;
        const x = event.payload.position.x / dpr;
        const y = event.payload.position.y / dpr;
        const rect = scrollRef.current.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;

        const targetDir = sshHandleRef.current?.rootPath || "/";
        const paths = event.payload.paths;
        setUploadStatus(`Uploading ${paths.length} file${paths.length > 1 ? "s" : ""}...`);

        let succeeded = 0;
        let lastError = "";
        for (const localPath of paths) {
          try {
            await sshUploadFile(sid, localPath, targetDir);
            succeeded++;
          } catch (err) {
            lastError = String(err);
            console.error("[FileExplorer] Upload failed:", localPath, err);
          }
        }
        setUploadStatus(
          succeeded === paths.length
            ? `Uploaded ${succeeded} file${succeeded > 1 ? "s" : ""}`
            : `Failed ${paths.length - succeeded}/${paths.length}: ${lastError}`
        );
        sshHandleRef.current?.refresh();
        setTimeout(() => setUploadStatus(null), 3000);
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; });

    return () => {
      cancelled = true;
      setDropActive(false);
      unlisten?.();
    };
  }, [isSSH, visible, state.activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load projects for active session
  useEffect(() => {
    if (!state.activeSessionId || !visible) {
      setProjects([]);
      return;
    }
    getSessionProjects(state.activeSessionId)
      .then((realms) => {
        setProjects(realms.map((r) => ({ id: r.id, name: r.name, path: r.path })));
      })
      .catch(() => setProjects([]));
  }, [state.activeSessionId, visible]);

  // Clear search when session changes
  useEffect(() => {
    setSearchQuery("");
  }, [state.activeSessionId]);

  if (!visible) return null;

  return (
    <div className="file-explorer">
      <div className="file-explorer-toolbar">
        <span className="file-explorer-title">FILES</span>
        <div className="file-explorer-actions">
          <button
            className={`file-explorer-toggle ${showHidden ? "file-explorer-toggle-active" : ""}`}
            onClick={() => setShowHidden((v) => !v)}
            title={showHidden ? "Hide hidden files" : "Show hidden files"}
            aria-pressed={showHidden}
          >.*</button>
        </div>
      </div>

      <input
        className="file-explorer-search"
        placeholder="Search files..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />

      <div ref={scrollRef} className="file-explorer-scroll" onContextMenu={(e) => {
        if (e.target === e.currentTarget) {
          showEmptyMenu(e, buildEmptyAreaMenuItems("file-explorer"));
        }
      }}>
        {isSSH && state.activeSessionId ? (
          <SshTree
            sessionId={state.activeSessionId}
            hostLabel={`${activeSession!.ssh_info!.user}@${activeSession!.ssh_info!.host}`}
            showHidden={showHidden}
            searchQuery={searchQuery}
            onFilePreview={handleSshFilePreview}
            onDownload={handleSshDownload}
            onHandleReady={handleSshHandleReady}
            uploadStatus={uploadStatus}
            dropActive={dropActive}
          />
        ) : (
          <>
            {projects.length === 0 && (
              <div className="file-explorer-empty-state">
                No projects attached to this session.
                <br />
                Attach a project to browse files.
              </div>
            )}
            {state.activeSessionId && projects.map((p) => (
              <ProjectTree
                key={p.id}
                sessionId={state.activeSessionId!}
                realmId={p.id}
                projectName={p.name}
                showHidden={showHidden}
                searchQuery={searchQuery}
                onFileContextMenu={(e, entry) => handleFileContextMenu(e, entry, p.id)}
                onFilePreview={handleFilePreview}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
