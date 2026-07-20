import "../styles/components/EditorPane.css";
import { useEffect, useRef, useState } from "react";
import { EditorState, Compartment, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, dropCursor, highlightActiveLine } from "@codemirror/view";
import {
  history, defaultKeymap, historyKeymap,
  indentMore, indentLess,
  toggleComment, toggleBlockComment,
  moveLineUp, moveLineDown,
  copyLineUp, copyLineDown,
  deleteLine,
  cursorMatchingBracket,
} from "@codemirror/commands";
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle, indentUnit } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap, openSearchPanel, gotoLine, selectNextOccurrence } from "@codemirror/search";
import { getLanguageSupport } from "./languageRegistry";
import { createSyntaxHighlighting } from "./editorTheme";
import { Minimap } from "./Minimap";
import {
  DEFAULT_EDITOR_FONT_PX,
  nextEditorFontSize,
  parseEditorFontSize,
} from "./editorFontSize";
import { getSetting, setSetting } from "../api/settings";

export interface CursorInfo {
  line: number;
  col: number;
  lineLength: number;
  selected: number;
  totalLines: number;
}

export interface IndentConfig {
  useTabs: boolean;
  size: number;
}

interface EditorPaneProps {
  content: string;
  language: string;
  onContentChange: (value: string) => void;
  onSave: () => void;
  onCursorChange?: (info: CursorInfo) => void;
  wordWrap?: boolean;
  indentConfig?: IndentConfig;
  minimap?: boolean;
}

const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    background: "transparent",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "var(--font-mono)",
    // fontSize is owned by the fontSizeCompartment so Mod+= / Mod+- /
    // Mod+0 can update it live without rebuilding the EditorState.
    scrollbarWidth: "thin",
    scrollbarColor: "var(--bg-active) transparent",
  },
  ".cm-scroller::-webkit-scrollbar": {
    width: "6px",
    height: "6px",
  },
  ".cm-scroller::-webkit-scrollbar-track": {
    background: "transparent",
  },
  ".cm-scroller::-webkit-scrollbar-thumb": {
    background: "var(--bg-active)",
    borderRadius: "3px",
  },
  ".cm-scroller::-webkit-scrollbar-thumb:hover": {
    background: "var(--text-3)",
  },
  ".cm-scroller::-webkit-scrollbar-corner": {
    background: "transparent",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    lineHeight: "1.5",
  },
  ".cm-gutters": {
    background: "var(--bg-0)",
    borderRight: "1px solid var(--border)",
    color: "var(--text-3)",
  },
  ".cm-activeLine": {
    background: "var(--bg-hover)",
  },
  ".cm-activeLineGutter": {
    background: "var(--bg-hover)",
  },
  ".cm-content ::selection": {
    background: "color-mix(in srgb, var(--accent) 45%, transparent)",
  },
  ".cm-matchingBracket": {
    background: "var(--accent-dim)",
    outline: "1px solid var(--accent)",
  },
  ".cm-searchMatch": {
    background: "color-mix(in srgb, var(--yellow) 25%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    background: "color-mix(in srgb, var(--yellow) 55%, transparent)",
    outline: "1px solid var(--yellow)",
  },
  /* ── Search / Replace panel ──────────────────────────────── */
  ".cm-panels": {
    background: "var(--bg-1)",
    borderBottom: "1px solid var(--border)",
    color: "var(--text-1)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
  },
  ".cm-panel.cm-search": {
    background: "var(--bg-1)",
    padding: "6px 10px",
  },
  ".cm-panel.cm-search label": {
    color: "var(--text-2)",
    fontSize: "var(--text-sm)",
  },
  ".cm-panel.cm-search input[type=checkbox]": {
    accentColor: "var(--accent)",
  },
  ".cm-textfield": {
    background: "var(--bg-0)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    color: "var(--text-0)",
    padding: "3px 6px",
    fontSize: "var(--text-sm)",
    fontFamily: "var(--font-mono)",
    outline: "none",
  },
  ".cm-textfield:focus": {
    borderColor: "var(--accent)",
  },
  ".cm-button": {
    background: "var(--bg-2)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    color: "var(--text-1)",
    padding: "3px 10px",
    fontSize: "var(--text-sm)",
    fontFamily: "var(--font-mono)",
    cursor: "pointer",
  },
  ".cm-button:hover": {
    background: "var(--bg-hover)",
    color: "var(--text-0)",
  },
  ".cm-button:active": {
    background: "var(--accent-dim)",
  },
  ".cm-panel button[name=close]": {
    color: "var(--text-3)",
    cursor: "pointer",
  },
  ".cm-panel button[name=close]:hover": {
    color: "var(--text-0)",
  },
  /* ── Go-to-line panel ────────────────────────────────────── */
  ".cm-panel.cm-gotoLine": {
    background: "var(--bg-1)",
    padding: "6px 10px",
  },
  ".cm-panel.cm-gotoLine label": {
    color: "var(--text-2)",
    fontSize: "var(--text-sm)",
  },
  ".cm-foldPlaceholder": {
    background: "var(--bg-2)",
    border: "1px solid var(--border)",
    color: "var(--text-3)",
  },
});

function buildFontSizeExtension(px: number) {
  return EditorView.theme({
    ".cm-scroller": { fontSize: `${px}px` },
  });
}

function buildIndentExtensions(config: IndentConfig) {
  const unit = config.useTabs ? "\t" : " ".repeat(config.size);
  const insertStr = unit;
  return [
    indentUnit.of(unit),
    EditorState.tabSize.of(config.size),
    keymap.of([
      {
        key: "Tab",
        run: (view) => {
          // If there's a multi-line selection, indent the selected lines
          const { from, to } = view.state.selection.main;
          if (from !== to && view.state.doc.lineAt(from).number !== view.state.doc.lineAt(to).number) {
            return indentMore(view);
          }
          // Otherwise insert indent characters at cursor
          view.dispatch(view.state.replaceSelection(insertStr));
          return true;
        },
      },
      {
        key: "Shift-Tab",
        run: indentLess,
      },
    ]),
  ];
}

export function EditorPane({ content, language, onContentChange, onSave, onCursorChange, wordWrap, indentConfig, minimap }: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const onContentChangeRef = useRef(onContentChange);
  const onSaveRef = useRef(onSave);
  const onCursorChangeRef = useRef(onCursorChange);
  const minimapNotifyRef = useRef<(() => void) | null>(null);
  const languageCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const indentCompartment = useRef(new Compartment());
  const fontSizeCompartment = useRef(new Compartment());
  // Live font size, mutated by Mod+= / Mod+- / Mod+0 inside the keymap.
  // Held in a ref (not React state) so shortcut handlers can update it
  // without triggering a re-creation of the EditorView in the useEffect
  // below that depends on `language`.
  const fontSizePxRef = useRef<number>(DEFAULT_EDITOR_FONT_PX);

  // Keep callback refs up to date
  onContentChangeRef.current = onContentChange;
  onSaveRef.current = onSave;
  onCursorChangeRef.current = onCursorChange;

  const effectiveIndent: IndentConfig = indentConfig ?? { useTabs: false, size: 2 };

  /** Apply a font-size change to the live EditorView and persist it. */
  const applyFontSizeAction = (action: "increase" | "decrease" | "reset"): boolean => {
    const view = viewRef.current;
    if (!view) return false;
    const next = nextEditorFontSize(fontSizePxRef.current, action);
    if (next === fontSizePxRef.current) return true; // already clamped at bound
    fontSizePxRef.current = next;
    view.dispatch({
      effects: fontSizeCompartment.current.reconfigure(buildFontSizeExtension(next)),
    });
    setSetting("editor_font_size", String(next)).catch((err) =>
      console.warn("[EditorPane] Failed to persist editor_font_size:", err),
    );
    return true;
  };

  // Create and destroy EditorView
  useEffect(() => {
    if (!containerRef.current) return;

    const langSupport = getLanguageSupport(language);

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        dropCursor(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        search({ top: true }),
        wrapCompartment.current.of(wordWrap ? EditorView.lineWrapping : []),
        indentCompartment.current.of(buildIndentExtensions(effectiveIndent)),
        fontSizeCompartment.current.of(buildFontSizeExtension(fontSizePxRef.current)),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          // ── Save ──
          { key: "Mod-s", run: () => { onSaveRef.current(); return true; } },
          // ── Font size (issue #193). Bind both `=` and `+` so users with
          //    a US layout don't have to press Shift to grow the font. ──
          { key: "Mod-=", run: () => applyFontSizeAction("increase") },
          { key: "Mod-+", run: () => applyFontSizeAction("increase") },
          { key: "Mod--", run: () => applyFontSizeAction("decrease") },
          { key: "Mod-0", run: () => applyFontSizeAction("reset") },
          // ── Search / Replace / Go-to-line ──
          {
            key: "Mod-r",
            run: (view) => {
              openSearchPanel(view);
              requestAnimationFrame(() => {
                const replace = view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]");
                replace?.focus();
              });
              return true;
            },
          },
          { key: "Mod-g", run: gotoLine },
          { key: "Mod-d", run: selectNextOccurrence },
          // ── Comments ──
          { key: "Mod-/", run: toggleComment },
          { key: "Mod-Shift-/", run: toggleBlockComment },
          // ── Line operations ──
          { key: "Alt-ArrowUp", run: moveLineUp },
          { key: "Alt-ArrowDown", run: moveLineDown },
          { key: "Shift-Alt-ArrowUp", run: copyLineUp },
          { key: "Shift-Alt-ArrowDown", run: copyLineDown },
          { key: "Mod-Shift-k", run: deleteLine },
          // ── Insert blank line ──
          {
            key: "Mod-Enter",
            run: (view) => {
              const line = view.state.doc.lineAt(view.state.selection.main.head);
              view.dispatch({
                changes: { from: line.to, insert: "\n" },
                selection: { anchor: line.to + 1 },
              });
              return true;
            },
          },
          {
            key: "Mod-Shift-Enter",
            run: (view) => {
              const line = view.state.doc.lineAt(view.state.selection.main.head);
              view.dispatch({
                changes: { from: line.from, insert: "\n" },
                selection: { anchor: line.from },
              });
              return true;
            },
          },
          // ── Bracket navigation ──
          { key: "Mod-Shift-\\", run: cursorMatchingBracket },
        ]),
        languageCompartment.current.of(langSupport ? [langSupport] : []),
        themeCompartment.current.of(createSyntaxHighlighting()),
        baseTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onContentChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            const state = update.state;
            const pos = state.selection.main.head;
            const line = state.doc.lineAt(pos);
            const selected = state.selection.main.empty
              ? 0
              : Math.abs(state.selection.main.to - state.selection.main.from);
            onCursorChangeRef.current?.({
              line: line.number,
              col: pos - line.from + 1,
              lineLength: line.length,
              selected,
              totalLines: state.doc.lines,
            });
          }
          if (update.docChanged || update.geometryChanged || update.viewportChanged) {
            minimapNotifyRef.current?.();
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;
    setEditorView(view);

    // Auto-focus the editor so keyboard shortcuts work immediately
    requestAnimationFrame(() => view.focus());

    return () => {
      view.destroy();
      viewRef.current = null;
      setEditorView(null);
    };
    // Only run on mount/unmount — content and language changes are handled by
    // dedicated effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external content changes (file switch, git discard reload)
  // Uses addToHistory: false so the user can't Cmd+Z back to stale/empty content
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentDoc = view.state.doc.toString();
    if (currentDoc !== content) {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: content,
        },
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }, [content]);

  // Swap language when the language prop changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const langSupport = getLanguageSupport(language);
    view.dispatch({
      effects: languageCompartment.current.reconfigure(langSupport ? [langSupport] : []),
    });
  }, [language]);

  // Toggle word wrap
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap]);

  // Update indentation settings
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: indentCompartment.current.reconfigure(buildIndentExtensions(effectiveIndent)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveIndent.useTabs, effectiveIndent.size]);

  // Load the persisted editor_font_size on mount and apply it to the
  // live view. Default is already set via the compartment's initial
  // value, so a missing setting falls through cleanly.
  useEffect(() => {
    let cancelled = false;
    getSetting("editor_font_size")
      .then((raw) => {
        if (cancelled) return;
        const px = parseEditorFontSize(raw);
        if (px === fontSizePxRef.current) return;
        fontSizePxRef.current = px;
        const view = viewRef.current;
        if (view) {
          view.dispatch({
            effects: fontSizeCompartment.current.reconfigure(buildFontSizeExtension(px)),
          });
        }
      })
      .catch((err) => console.warn("[EditorPane] Failed to load editor_font_size:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Hot-swap syntax colours when the app theme changes
  useEffect(() => {
    const handler = () => {
      const view = viewRef.current;
      if (!view) return;
      // Re-read CSS variables after theme switch and rebuild highlight style
      requestAnimationFrame(() => {
        view.dispatch({
          effects: themeCompartment.current.reconfigure(createSyntaxHighlighting()),
        });
      });
    };
    window.addEventListener("hermes:theme-changed", handler);
    return () => window.removeEventListener("hermes:theme-changed", handler);
  }, []);

  const showMinimap = minimap && editorView;

  return (
    <div className="cm-editor-container">
      <div
        ref={containerRef}
        className="cm-editor-inner"
        style={showMinimap ? { right: 60 } : undefined}
      />
      {showMinimap && <Minimap view={editorView} notifyRef={minimapNotifyRef} />}
    </div>
  );
}
