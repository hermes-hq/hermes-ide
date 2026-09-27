import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import { lazyView } from "../utils/lazyView";
import "../styles/components/FilePreview.css";
import { readFileContent, openFileInEditor, sshReadFile } from "../api/git";
import { writeToSession } from "../api/sessions";
import { getSetting } from "../api/settings";
import { useSession } from "../state/SessionContext";
import { useFileEditor } from "../hooks/useFileEditor";
import type { CursorInfo, IndentConfig } from "../editor/EditorPane";
import type { FileContent } from "../types/git";

// The code editor (CodeMirror) loads the first time a file is edited.
const EditorPane = lazyView("EditorPane", () => import("../editor/EditorPane").then((m) => m.EditorPane));

import type { FileHandlerProps } from "../plugins/types";

interface FilePreviewPanelProps {
  sessionId: string;
  projectId: string;
  filePath: string;
  onBack: () => void;
  fileHandler?: React.ComponentType<FileHandlerProps>;
  fileHandlerPluginId?: string;
}

// ─── Lightweight syntax highlighter ─────────────────────────────────

type TokenRule = [RegExp, string];

const COMMON_RULES: TokenRule[] = [
  [/\/\/.*$/gm, "syn-comment"],
  [/\/\*[\s\S]*?\*\//gm, "syn-comment"],
  [/"(?:[^"\\]|\\.)*"/g, "syn-string"],
  [/'(?:[^'\\]|\\.)*'/g, "syn-string"],
  [/`(?:[^`\\]|\\.)*`/g, "syn-string"],
  [/\b\d+\.?\d*(?:e[+-]?\d+)?\b/gi, "syn-number"],
  [/\b0x[0-9a-f]+\b/gi, "syn-number"],
];

// Languages where # starts a line comment
const HASH_COMMENT_LANGUAGES = new Set(["python", "bash", "yaml", "r"]);

const KEYWORD_SETS: Record<string, string> = {
  typescript: "abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|return|static|super|switch|this|throw|try|type|typeof|var|void|while|with|yield",
  javascript: "async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield",
  rust: "as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while",
  python: "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield",
  go: "break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var",
  html: "html|head|body|div|span|a|p|h1|h2|h3|h4|h5|h6|ul|ol|li|table|tr|td|th|form|input|button|select|option|img|link|script|style|meta|title|section|article|nav|header|footer|main|aside",
  css: "color|background|border|margin|padding|font|display|position|width|height|top|left|right|bottom|flex|grid|align|justify|overflow|transition|transform|opacity|z-index|content|cursor|outline|text|line|letter|word|white|box|list|float|clear|visibility|animation|max|min",
  json: "",
  yaml: "true|false|null|yes|no|on|off",
  sql: "select|from|where|insert|update|delete|create|drop|alter|table|index|into|values|set|and|or|not|null|is|in|like|between|join|inner|outer|left|right|on|as|order|by|group|having|limit|offset|union|distinct|count|sum|avg|min|max|case|when|then|else|end|exists|primary|key|foreign|references|constraint|default|unique|check|view|trigger|procedure|function|begin|commit|rollback",
  bash: "if|then|else|elif|fi|for|while|do|done|case|esac|function|return|exit|echo|printf|read|local|export|source|alias|unalias|set|unset|shift|trap|exec|eval|cd|pwd|test",
  markdown: "",
  plaintext: "",
};

// Map language aliases
function getKeywords(lang: string): string {
  if (lang === "tsx" || lang === "jsx") return KEYWORD_SETS.typescript || "";
  return KEYWORD_SETS[lang] || KEYWORD_SETS.javascript || "";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlightLine(line: string, language: string): string {
  if (!line) return "\n";
  if (language === "json" || language === "markdown" || language === "plaintext") {
    return escapeHtml(line);
  }

  // Build token map: position → { end, className }
  type Span = { start: number; end: number; cls: string };
  const spans: Span[] = [];

  const rules: TokenRule[] = [...COMMON_RULES];
  if (HASH_COMMENT_LANGUAGES.has(language)) {
    rules.push([/#.*$/gm, "syn-comment"]);
  }
  const keywords = getKeywords(language);
  if (keywords) {
    rules.push([new RegExp(`\\b(?:${keywords})\\b`, "g"), "syn-keyword"]);
  }
  // Type-like identifiers (PascalCase)
  rules.push([/\b[A-Z][a-zA-Z0-9_]*\b/g, "syn-type"]);
  // Function calls
  rules.push([/\b([a-zA-Z_]\w*)\s*(?=\()/g, "syn-function"]);

  for (const [regex, cls] of rules) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(line)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, cls });
    }
  }

  if (spans.length === 0) return escapeHtml(line);

  // Sort by start, then by longest first (so higher-priority tokens win)
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  // Remove overlapping spans (first match wins)
  const filtered: Span[] = [];
  let lastEnd = 0;
  for (const s of spans) {
    if (s.start >= lastEnd) {
      filtered.push(s);
      lastEnd = s.end;
    }
  }

  let result = "";
  let pos = 0;
  for (const s of filtered) {
    if (s.start > pos) {
      result += escapeHtml(line.slice(pos, s.start));
    }
    result += `<span class="${s.cls}">${escapeHtml(line.slice(s.start, s.end))}</span>`;
    pos = s.end;
  }
  if (pos < line.length) {
    result += escapeHtml(line.slice(pos));
  }
  return result;
}

// ─── Component ──────────────────────────────────────────────────────

const EDITOR_LABELS: Record<string, string> = {
  code: "VS Code",
  cursor: "Cursor",
  zed: "Zed",
  subl: "Sublime Text",
  idea: "IntelliJ",
  webstorm: "WebStorm",
  atom: "Atom",
  emacs: "Emacs",
  vim: "Vim",
  nvim: "Neovim",
};

const SSH_EDITOR_LABELS: Record<string, string> = {
  vim: "Vim",
  nvim: "Neovim",
  nano: "Nano",
  emacs: "Emacs",
  vi: "Vi",
  code: "VS Code (Remote)",
  cursor: "Cursor (Remote)",
  zed: "Zed (Remote)",
};

// GUI editors that open remotely from the local machine (not via PTY)
const SSH_GUI_EDITORS = new Set(["code", "cursor", "zed"]);

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary);
}

const MAX_DISPLAY_SIZE = 1_048_576;

export function FilePreviewPanel({ sessionId, projectId, filePath, onBack, fileHandler: FileHandler, fileHandlerPluginId }: FilePreviewPanelProps) {
  const { state } = useSession();
  const isSSH = projectId === "__ssh__";
  const sshInfo = isSSH ? state.sessions[sessionId]?.ssh_info : null;
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorLabel, setEditorLabel] = useState(isSSH ? "Vim" : "System Default");
  const [editMode, setEditMode] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [cursorInfo, setCursorInfo] = useState<CursorInfo>({ line: 1, col: 1, lineLength: 0, selected: 0, totalLines: 0 });
  const [wordWrap, setWordWrap] = useState(false);
  const [showMinimap, setShowMinimap] = useState(false);
  const [indentConfig, setIndentConfig] = useState<IndentConfig>({ useTabs: false, size: 2 });
  const [showIndentMenu, setShowIndentMenu] = useState(false);
  const indentMenuRef = useRef<HTMLDivElement>(null);

  const editor = useFileEditor({
    sessionId,
    projectId,
    filePath,
    initialContent: file?.content ?? "",
    initialMtime: (file as FileContent)?.mtime ?? 0,
    isSSH,
  });

  // Keep a ref so the disk-change handler always sees the latest dirty state
  const editorDirtyRef = useRef(editor.isDirty);
  editorDirtyRef.current = editor.isDirty;

  useEffect(() => {
    setLoading(true);
    setError(null);
    const promise = isSSH
      ? sshReadFile(sessionId, filePath).then((r) => ({ ...r, mtime: 0 }))
      : readFileContent(sessionId, projectId, filePath);
    promise
      .then(setFile)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [sessionId, projectId, filePath, isSSH]);

  // Reload file when it changes on disk (e.g., git discard)
  // If user has unsaved edits, skip the reload — their in-editor work takes priority
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectId: string; filePath: string };
      if (detail.projectId === projectId && detail.filePath === filePath) {
        if (editorDirtyRef.current) return;
        const promise = isSSH
          ? sshReadFile(sessionId, filePath).then((r) => ({ ...r, mtime: 0 }))
          : readFileContent(sessionId, projectId, filePath);
        promise.then(setFile).catch(console.error);
      }
    };
    window.addEventListener("hermes:file-changed-on-disk", handler);
    return () => window.removeEventListener("hermes:file-changed-on-disk", handler);
  }, [sessionId, projectId, filePath, isSSH]);

  useEffect(() => {
    const key = isSSH ? "preferred_ssh_editor" : "preferred_editor";
    getSetting(key).then((ed) => {
      if (isSSH) {
        setEditorLabel(SSH_EDITOR_LABELS[ed] || "Vim");
      } else {
        setEditorLabel(EDITOR_LABELS[ed] || "System Default");
      }
    }).catch(() => {});
  }, [isSSH]);

  const handleOpenInEditor = useCallback(() => {
    if (isSSH) {
      getSetting("preferred_ssh_editor")
        .then((ed) => {
          const cmd = ed || "vim";

          if (SSH_GUI_EDITORS.has(cmd) && sshInfo) {
            // GUI editors: run locally with remote connection args
            // Blank user → bare host/alias, so ~/.ssh/config decides the user.
            const dest = sshInfo.user ? `${sshInfo.user}@${sshInfo.host}` : sshInfo.host;
            const host = sshInfo.port !== 22 ? `${dest}:${sshInfo.port}` : dest;

            if (cmd === "zed") {
              // zed ssh://user@host:port/path
              const port = sshInfo.port !== 22 ? `:${sshInfo.port}` : "";
              return openFileInEditor(sessionId, "__ssh_local__", `ssh://${dest}${port}${filePath}`, "zed");
            } else {
              // VS Code / Cursor: --remote ssh-remote+user@host:port /path
              return openFileInEditor(sessionId, "__ssh_local__", filePath, `${cmd} --remote ssh-remote+${host}`);
            }
          } else {
            // Terminal editors: write command to PTY
            const escaped = filePath.replace(/'/g, "'\\''");
            const fullCmd = `${cmd} '${escaped}'\r`;
            return writeToSession(sessionId, utf8ToBase64(fullCmd));
          }
        })
        .then(() => onBack())
        .catch(console.error);
    } else {
      getSetting("preferred_editor")
        .then((ed) => openFileInEditor(sessionId, projectId, filePath, ed || null))
        .catch(console.error);
    }
  }, [sessionId, projectId, filePath, isSSH, sshInfo, onBack]);

  // Auto-enter edit mode for non-binary, non-large text files
  useEffect(() => {
    if (file && !file.is_binary && file.content && file.size <= MAX_DISPLAY_SIZE) {
      setEditMode(true);
    } else {
      setEditMode(false);
    }
  }, [file]);

  // Close indent menu on click outside
  useEffect(() => {
    if (!showIndentMenu) return;
    const handler = (e: MouseEvent) => {
      if (indentMenuRef.current && !indentMenuRef.current.contains(e.target as Node)) {
        setShowIndentMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showIndentMenu]);

  // Cmd+S handled by EditorPane natively; no extra keyboard shortcuts needed

  const handleBack = useCallback(() => {
    if (editor.isDirty) {
      setShowCloseConfirm(true);
    } else {
      onBack();
    }
  }, [editor.isDirty, onBack]);

  const lines = useMemo(() => {
    if (!file || !file.content) return [];
    return file.content.split("\n");
  }, [file]);

  const highlightedLines = useMemo(() => {
    if (!file) return [];
    return lines.map((line) => highlightLine(line, file.language));
  }, [lines, file]);

  if (loading) {
    return (
      <div className="file-preview">
        <div className="file-preview-header">
          <button className="file-preview-back" onClick={onBack} title="Back to files">&#9666;</button>
          <span className="file-preview-filename">Loading...</span>
        </div>
        <div className="file-preview-placeholder">Loading file...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-preview">
        <div className="file-preview-header">
          <button className="file-preview-back" onClick={onBack} title="Back to files">&#9666;</button>
          <span className="file-preview-filename">Error</span>
        </div>
        <div className="file-preview-placeholder">{error}</div>
      </div>
    );
  }

  if (!file) return null;

  // Delegate to plugin file handler if registered
  if (FileHandler && file.content != null && fileHandlerPluginId) {
    return (
      <FileHandler
        pluginId={fileHandlerPluginId}
        filePath={filePath}
        content={file.content}
        sessionId={sessionId}
        onBack={onBack}
      />
    );
  }

  const isTooLarge = file.size > MAX_DISPLAY_SIZE && !file.content;

  return (
    <div className="file-preview">
      <div className="file-preview-header">
        <button className="file-preview-back" onClick={handleBack} title="Back to files">&#9666;</button>
        <span className="file-preview-filename" title={filePath}>{file.file_name}</span>
        {editMode && editor.isDirty && <span className="file-editor-dirty-dot" title="Unsaved changes" />}
        {editMode && editor.isSaving && <span className="file-editor-saving">Saving...</span>}
        {editMode && editor.saveError && <span className="file-editor-error" title={editor.saveError}>Save failed</span>}
        <span className="file-preview-lang">{file.language}</span>
        {editMode && (
          <button className="file-preview-open-btn" onClick={() => editor.save()} disabled={!editor.isDirty} title="Save (Cmd+S)">
            Save
          </button>
        )}
        <button className="file-preview-open-btn" onClick={handleOpenInEditor} title={`Open in ${editorLabel}`}>
          {editorLabel}
        </button>
      </div>

      {file.is_binary ? (
        <div className="file-preview-placeholder">
          Binary file ({formatSize(file.size)})
          <br />
          Cannot preview binary files.
        </div>
      ) : isTooLarge ? (
        <div className="file-preview-placeholder">
          File too large ({formatSize(file.size)})
          <br />
          Maximum preview size is 1 MB.
        </div>
      ) : editMode ? (
        <>
          <div className="file-preview-content file-editor-content">
            <Suspense fallback={null}>
              <EditorPane
                content={editor.content}
                language={file.language}
                onContentChange={editor.setContent}
                onSave={editor.save}
                onCursorChange={setCursorInfo}
                wordWrap={wordWrap}
                indentConfig={indentConfig}
                minimap={showMinimap}
              />
            </Suspense>
          </div>
          <div className="editor-statusbar">
            <div className="editor-statusbar-left">
              <span className="editor-statusbar-item" title="Cursor position">
                Ln {cursorInfo.line}, Col {cursorInfo.col}
              </span>
              <span className="editor-statusbar-divider" />
              <span className="editor-statusbar-item editor-statusbar-dim" title="Characters in current line">
                {cursorInfo.lineLength} chars
              </span>
              {cursorInfo.selected > 0 && (
                <>
                  <span className="editor-statusbar-divider" />
                  <span className="editor-statusbar-item editor-statusbar-accent" title="Selected characters">
                    {cursorInfo.selected} selected
                  </span>
                </>
              )}
              <span className="editor-statusbar-divider" />
              <span className="editor-statusbar-item editor-statusbar-dim" title="Total lines">
                {cursorInfo.totalLines} lines
              </span>
            </div>
            <div className="editor-statusbar-right">
              <button
                className={`editor-statusbar-btn${showMinimap ? " editor-statusbar-btn-active" : ""}`}
                onClick={() => setShowMinimap((v) => !v)}
                title="Toggle minimap"
              >
                Minimap
              </button>
              <span className="editor-statusbar-divider" />
              <button
                className={`editor-statusbar-btn${wordWrap ? " editor-statusbar-btn-active" : ""}`}
                onClick={() => setWordWrap((v) => !v)}
                title="Toggle word wrap (Alt+Z)"
              >
                Word Wrap
              </button>
              <span className="editor-statusbar-divider" />
              <div className="editor-statusbar-indent-wrap" ref={indentMenuRef}>
                <button
                  className="editor-statusbar-btn"
                  onClick={() => setShowIndentMenu((v) => !v)}
                  title="Indentation settings"
                >
                  {indentConfig.useTabs ? `Tabs: ${indentConfig.size}` : `Spaces: ${indentConfig.size}`}
                </button>
                {showIndentMenu && (
                  <div className="editor-indent-menu">
                    <div className="editor-indent-menu-section">Indent Using</div>
                    <button
                      className={`editor-indent-menu-item${!indentConfig.useTabs ? " editor-indent-menu-item-active" : ""}`}
                      onClick={() => { setIndentConfig((c) => ({ ...c, useTabs: false })); }}
                    >
                      Spaces
                    </button>
                    <button
                      className={`editor-indent-menu-item${indentConfig.useTabs ? " editor-indent-menu-item-active" : ""}`}
                      onClick={() => { setIndentConfig((c) => ({ ...c, useTabs: true })); }}
                    >
                      Tabs
                    </button>
                    <div className="editor-indent-menu-section">Tab Size</div>
                    {[2, 4, 8].map((n) => (
                      <button
                        key={n}
                        className={`editor-indent-menu-item${indentConfig.size === n ? " editor-indent-menu-item-active" : ""}`}
                        onClick={() => { setIndentConfig((c) => ({ ...c, size: n })); setShowIndentMenu(false); }}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="file-preview-content">
          <pre className="file-preview-code">
            <div className="file-preview-line-numbers">
              {lines.map((_, i) => (
                <span key={i} className="file-preview-line-number">{i + 1}</span>
              ))}
            </div>
            <div className="file-preview-lines">
              {highlightedLines.map((html, i) => (
                <div
                  key={i}
                  className="file-preview-line"
                  dangerouslySetInnerHTML={{ __html: html || "\n" }}
                />
              ))}
            </div>
          </pre>
        </div>
      )}

      {showCloseConfirm && (
        <div className="file-editor-confirm-overlay">
          <div className="file-editor-confirm-dialog">
            <div className="file-editor-confirm-title">Unsaved Changes</div>
            <div className="file-editor-confirm-desc">
              You have unsaved changes in {file.file_name}. What would you like to do?
            </div>
            <div className="file-editor-confirm-actions">
              <button className="file-editor-confirm-btn" onClick={() => setShowCloseConfirm(false)}>Cancel</button>
              <button className="file-editor-confirm-btn file-editor-confirm-discard" onClick={() => { setShowCloseConfirm(false); onBack(); }}>Discard</button>
              <button className="file-editor-confirm-btn file-editor-confirm-save" onClick={async () => { const ok = await editor.save(); setShowCloseConfirm(false); if (ok) { onBack(); } }}>Save &amp; Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
