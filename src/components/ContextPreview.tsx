import "../styles/components/ContextPreview.css";
import { useState, useCallback, useRef, useEffect } from "react";
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

  const budgetPercent = manager.tokenBudget > 0
    ? Math.min(100, Math.round((manager.estimatedTokens / manager.tokenBudget) * 100))
    : 0;

  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup copy timer on unmount
  useEffect(() => {
    return () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); };
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn("[ContextPreview] Clipboard write failed:", err);
    }
  }, [displayContent]);

  return (
    <div className="ctx-preview-section">
      <button
        className="ctx-preview-toggle"
        onClick={() => setExpanded(!expanded)}
        title="Toggle context preview"
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
                  title="Show current context"
                >
                  Current
                </button>
                <button
                  className={`ctx-preview-tab ${showInjected ? "ctx-preview-tab-active" : ""}`}
                  onClick={() => setShowInjected(true)}
                  title="Show injected context"
                >
                  Injected
                </button>
              </div>
            )}
            <button className="ctx-preview-copy" onClick={handleCopy} title="Copy context to clipboard">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="ctx-preview-content">{displayContent}</pre>
          <div className="ctx-preview-charcount">
            {charCount.toLocaleString()} chars (~{tokenEstimate.toLocaleString()} tokens)
            {manager.tokenBudget > 0 && ` | ${budgetPercent}% of ${manager.tokenBudget.toLocaleString()} budget`}
            {showInjected && " (injected)"}
          </div>
        </div>
      )}
    </div>
  );
}
