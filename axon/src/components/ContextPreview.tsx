import { useState, useCallback } from "react";
import { type ContextManager } from "../hooks/useContextState";

interface ContextPreviewProps {
  manager: ContextManager;
}

export function ContextPreview({ manager }: ContextPreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showInjected, setShowInjected] = useState(false);

  const formatted = manager.formatContext();
  const displayContent = showInjected && manager.injectedContent ? manager.injectedContent : formatted;
  const charCount = displayContent.length;
  const tokenEstimate = Math.ceil(charCount / 4);

  const isDirty = manager.lifecycle === 'dirty' || manager.lifecycle === 'apply_failed';
  const hasInjected = manager.injectedContent !== null;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [displayContent]);

  return (
    <div className="ctx-preview-section">
      <button
        className="ctx-preview-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "\u25BE" : "\u25B8"} Context Preview
        {isDirty && (
          <span className="ctx-preview-outofsync-note">(not yet applied)</span>
        )}
      </button>
      {expanded && (
        <div className="ctx-preview-body">
          <div className="ctx-preview-actions">
            {hasInjected && (
              <div className="ctx-preview-tab-row">
                <button
                  className={`ctx-preview-tab ${!showInjected ? "ctx-preview-tab-active" : ""}`}
                  onClick={() => setShowInjected(false)}
                >
                  Current
                </button>
                <button
                  className={`ctx-preview-tab ${showInjected ? "ctx-preview-tab-active" : ""}`}
                  onClick={() => setShowInjected(true)}
                >
                  Injected
                </button>
              </div>
            )}
            <button className="ctx-preview-copy" onClick={handleCopy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="ctx-preview-content">{displayContent}</pre>
          <div className="ctx-preview-charcount">
            {charCount.toLocaleString()} chars (~{tokenEstimate.toLocaleString()} tokens)
            {showInjected && " (injected)"}
          </div>
        </div>
      )}
    </div>
  );
}
