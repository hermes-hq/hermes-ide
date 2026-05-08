/**
 * MemorySection — lists init.memory_paths with inline-expand editors.
 * Visual: §8.8.
 */
import "../styles/components/MemorySection.css";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { classifyMemoryPath } from "../utils/memoryPaths";

interface Props {
  memoryPaths: string[];
}

export function MemorySection({ memoryPaths }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="memory-section">
      {memoryPaths.length === 0 ? (
        <div className="memory-empty">
          <span className="memory-empty-hint">no memory files loaded</span>
        </div>
      ) : (
        <ul className="memory-list">
          {memoryPaths.map((path) => (
            <MemoryRow
              key={path}
              path={path}
              expanded={expanded === path}
              onToggle={() => setExpanded(expanded === path ? null : path)}
            />
          ))}
        </ul>
      )}
      <button type="button" className="memory-add-cta">+ Add memory line</button>
    </div>
  );
}

function MemoryRow({ path, expanded, onToggle }: { path: string; expanded: boolean; onToggle: () => void }) {
  const cls = classifyMemoryPath(path);
  const filename = path.split("/").pop() ?? path;
  return (
    <li className="memory-row">
      <button type="button" className="memory-row-header" onClick={onToggle} aria-expanded={expanded}>
        <span className="memory-row-glyph" aria-hidden="true">◇</span>
        <span className="memory-row-name">{filename}</span>
        <span className="memory-row-class">{cls}</span>
      </button>
      {expanded && <MemoryEditor path={path} />}
    </li>
  );
}

function MemoryEditor({ path }: { path: string }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; content: string; original: string }
    | { kind: "missing" }
    | { kind: "error"; message: string }
    | { kind: "saving" }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    invoke<string>("read_memory_file", { path })
      .then((content) => {
        if (cancelled) return;
        setState({ kind: "ready", content, original: content });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (/not found|no such file/i.test(msg)) setState({ kind: "missing" });
        else setState({ kind: "error", message: msg });
      });
    return () => { cancelled = true; };
  }, [path]);

  if (state.kind === "loading") {
    return <div className="memory-editor-loading">loading…</div>;
  }
  if (state.kind === "missing") {
    return (
      <div className="memory-editor-missing">
        <span>file does not exist yet</span>
        <button
          type="button"
          className="memory-editor-action"
          onClick={async () => {
            await invoke("write_memory_file", { path, content: "" });
            setState({ kind: "ready", content: "", original: "" });
          }}
        >
          create now
        </button>
      </div>
    );
  }
  if (state.kind === "error") {
    return <div className="memory-editor-error">{state.message}</div>;
  }
  if (state.kind === "saving") {
    return <div className="memory-editor-loading">saving…</div>;
  }

  const dirty = state.content !== state.original;

  return (
    <div className="memory-editor">
      <textarea
        className="memory-editor-textarea"
        value={state.content}
        onChange={(e) =>
          setState((prev) =>
            prev.kind === "ready"
              ? { ...prev, content: e.target.value }
              : prev,
          )
        }
        rows={10}
      />
      <div className="memory-editor-actions">
        <button
          type="button"
          className="memory-editor-action memory-editor-revert"
          disabled={!dirty}
          onClick={() => {
            setState((prev) => prev.kind === "ready" ? { ...prev, content: prev.original } : prev);
          }}
        >
          revert
        </button>
        <button
          type="button"
          className="memory-editor-action memory-editor-save"
          disabled={!dirty}
          onClick={async () => {
            const ready = state;
            setState({ kind: "saving" });
            try {
              await invoke("write_memory_file", { path, content: ready.content });
              setState({ kind: "ready", content: ready.content, original: ready.content });
            } catch (err) {
              setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
            }
          }}
        >
          save
        </button>
      </div>
    </div>
  );
}
