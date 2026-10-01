import "../styles/components/ContextPreview.css";
import { useState, useCallback, useRef, useEffect } from "react";
import { type ContextManager } from "../hooks/useContextState";
import { useI18n } from "../i18n/I18nProvider";

interface ContextPreviewProps {
  manager: ContextManager;
}

export function ContextPreview({ manager }: ContextPreviewProps) {
  const { t } = useI18n();
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
        title={t("ctxPanel.togglePreview")}
        aria-expanded={expanded}
      >
        {expanded ? "\u25BE" : "\u25B8"} {t("ctxPanel.preview")}
        {isDirty && (
          <span className="ctx-preview-outofsync-note">{t("ctxPanel.notApplied")}</span>
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
                  title={t("ctxPanel.showCurrent")}
                >
                  {t("ctxPanel.current")}
                </button>
                <button
                  className={`ctx-preview-tab ${showInjected ? "ctx-preview-tab-active" : ""}`}
                  onClick={() => setShowInjected(true)}
                  title={t("ctxPanel.showInjected")}
                >
                  {t("ctxPanel.injected")}
                </button>
              </div>
            )}
            <button className="ctx-preview-copy" onClick={handleCopy} title={t("ctxPanel.copyTitle")}>
              {copied ? t("ctxPanel.copied") : t("ctxPanel.copy")}
            </button>
          </div>
          <pre className="ctx-preview-content">{displayContent}</pre>
          <div className="ctx-preview-charcount">
            {t("ctxPanel.chars", { chars: charCount.toLocaleString(), tokens: tokenEstimate.toLocaleString() })}
            {manager.tokenBudget > 0 && ` | ${t("ctxPanel.ofBudget", { percent: budgetPercent, budget: manager.tokenBudget.toLocaleString() })}`}
            {showInjected && ` ${t("ctxPanel.injectedNote")}`}
          </div>
        </div>
      )}
    </div>
  );
}
