import { useState, useEffect, useCallback } from "react";
import "../styles/components/FileExplorer.css";
import { useSession } from "../state/SessionContext";
import { getSessionProjects } from "../api/projects";
import { gitOpenFile } from "../api/git";
import { useFileExplorer, filterEntries } from "../hooks/useFileTree";
import type { FileEntry } from "../types/git";

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
  projectPath: string;
  projectName: string;
  showHidden: boolean;
  searchQuery: string;
}

function ProjectTree({ projectPath, projectName, showHidden, searchQuery }: ProjectTreeProps) {
  const { expandedDirs, loadingDirs, error, loadDirectory, toggleDir, refresh, getEntries } = useFileExplorer(projectPath);

  // Load root on mount
  useEffect(() => {
    loadDirectory("");
  }, [loadDirectory]);

  const rootEntries = getEntries("");
  const filtered = rootEntries ? filterEntries(rootEntries, searchQuery, showHidden) : null;

  const handleFileClick = useCallback((entry: FileEntry) => {
    if (entry.is_dir) {
      toggleDir(entry.path);
    } else {
      gitOpenFile(projectPath, entry.path).catch(console.error);
    }
  }, [projectPath, toggleDir]);

  return (
    <div className="file-explorer-project">
      <div className="file-explorer-project-header">
        <span className="file-explorer-project-name">{projectName}</span>
        <button className="git-panel-refresh" onClick={refresh} title="Refresh">&#8635;</button>
      </div>
      {error && <div className="git-error" style={{ margin: "4px 8px" }}>{error}</div>}
      {!filtered && !error && <div className="git-empty">Loading...</div>}
      {filtered && filtered.length === 0 && <div className="git-empty">No files</div>}
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
}

function FileTreeNode({ entry, depth, expandedDirs, loadingDirs, getEntries, showHidden, searchQuery, onToggleDir, onFileClick }: FileTreeNodeProps) {
  const isExpanded = expandedDirs.has(entry.path);
  const isLoading = loadingDirs.has(entry.path);
  const children = entry.is_dir && isExpanded ? getEntries(entry.path) : null;
  const filteredChildren = children ? filterEntries(children, searchQuery, showHidden) : null;

  const statusClass = entry.git_status ? STATUS_COLORS[entry.git_status] || "" : "";
  const statusLetter = entry.git_status ? STATUS_LETTERS[entry.git_status] || "" : "";

  return (
    <>
      <div
        className={`file-tree-node ${entry.is_hidden ? "file-tree-hidden" : ""}`}
        style={{ paddingLeft: `${(depth * 16) + 8}px` }}
        onClick={() => onFileClick(entry)}
      >
        {entry.is_dir ? (
          <span className={`file-tree-chevron ${isExpanded ? "file-tree-chevron-open" : ""}`}>&#9656;</span>
        ) : (
          <span className="file-tree-chevron-spacer" />
        )}
        <span className="file-tree-icon">{entry.is_dir ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}</span>
        <span className="file-tree-name">{entry.name}</span>
        {statusLetter && (
          <span className={`file-tree-git-badge ${statusClass}`}>{statusLetter}</span>
        )}
      </div>
      {entry.is_dir && isExpanded && (
        <>
          {isLoading && <div className="git-empty" style={{ paddingLeft: `${((depth + 1) * 16) + 8}px` }}>Loading...</div>}
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
              onFileClick={(e) => {
                if (e.is_dir) {
                  onToggleDir(e.path);
                } else {
                  onFileClick(e);
                }
              }}
            />
          ))}
        </>
      )}
    </>
  );
}

interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

export function FileExplorerPanel({ visible }: FileExplorerPanelProps) {
  const { state } = useSession();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

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
          >.*</button>
        </div>
      </div>

      <input
        className="file-explorer-search"
        placeholder="Search files..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />

      <div className="file-explorer-scroll">
        {projects.length === 0 && (
          <div className="git-empty-state">
            No projects attached to this session.
            <br />
            Attach a project to browse files.
          </div>
        )}
        {projects.map((p) => (
          <ProjectTree
            key={p.id}
            projectPath={p.path}
            projectName={p.name}
            showHidden={showHidden}
            searchQuery={searchQuery}
          />
        ))}
      </div>
    </div>
  );
}
