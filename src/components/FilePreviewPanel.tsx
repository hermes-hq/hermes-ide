import { useState, useEffect, useCallback, useMemo } from "react";
import "../styles/components/FilePreview.css";
import { readFileContent, openFileInEditor, sshReadFile } from "../api/git";
import { writeToSession } from "../api/sessions";
import { getSetting } from "../api/settings";
import { useSession } from "../state/SessionContext";
import type { FileContent } from "../types/git";

import type { FileHandlerProps } from "../plugins/types";

interface FilePreviewPanelProps {
  sessionId: string;
  realmId: string;
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
  [/#.*$/gm, "syn-comment"],
  [/"(?:[^"\\]|\\.)*"/g, "syn-string"],
  [/'(?:[^'\\]|\\.)*'/g, "syn-string"],
  [/`(?:[^`\\]|\\.)*`/g, "syn-string"],
  [/\b\d+\.?\d*(?:e[+-]?\d+)?\b/gi, "syn-number"],
  [/\b0x[0-9a-f]+\b/gi, "syn-number"],
];

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

export function FilePreviewPanel({ sessionId, realmId, filePath, onBack, fileHandler: FileHandler, fileHandlerPluginId }: FilePreviewPanelProps) {
  const { state } = useSession();
  const isSSH = realmId === "__ssh__";
  const sshInfo = isSSH ? state.sessions[sessionId]?.ssh_info : null;
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorLabel, setEditorLabel] = useState(isSSH ? "Vim" : "System Default");

  useEffect(() => {
    setLoading(true);
    setError(null);
    const promise = isSSH
      ? sshReadFile(sessionId, filePath)
      : readFileContent(sessionId, realmId, filePath);
    promise
      .then(setFile)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [sessionId, realmId, filePath, isSSH]);

  useEffect(() => {
    const key = isSSH ? "preferred_ssh_editor" : "preferred_editor";
    getSetting(key).then((editor) => {
      if (isSSH) {
        setEditorLabel(SSH_EDITOR_LABELS[editor] || "Vim");
      } else {
        setEditorLabel(EDITOR_LABELS[editor] || "System Default");
      }
    }).catch(() => {});
  }, [isSSH]);

  const handleOpenInEditor = useCallback(() => {
    if (isSSH) {
      getSetting("preferred_ssh_editor")
        .then((editor) => {
          const cmd = editor || "vim";

          if (SSH_GUI_EDITORS.has(cmd) && sshInfo) {
            // GUI editors: run locally with remote connection args
            const host = sshInfo.port !== 22
              ? `${sshInfo.user}@${sshInfo.host}:${sshInfo.port}`
              : `${sshInfo.user}@${sshInfo.host}`;

            if (cmd === "zed") {
              // zed ssh://user@host:port/path
              const port = sshInfo.port !== 22 ? `:${sshInfo.port}` : "";
              return openFileInEditor(sessionId, "__ssh_local__", `ssh://${sshInfo.user}@${sshInfo.host}${port}${filePath}`, "zed");
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
        .then((editor) => openFileInEditor(sessionId, realmId, filePath, editor || null))
        .catch(console.error);
    }
  }, [sessionId, realmId, filePath, isSSH, sshInfo, onBack]);

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
        <button className="file-preview-back" onClick={onBack} title="Back to files">&#9666;</button>
        <span className="file-preview-filename" title={filePath}>{file.file_name}</span>
        <span className="file-preview-lang">{file.language}</span>
        <button className="file-preview-open-btn" onClick={handleOpenInEditor} title={`Open in ${editorLabel}`}>
          Open in {editorLabel}
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
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
