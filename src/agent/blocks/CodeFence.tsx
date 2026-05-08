import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";

interface CodeFenceProps {
  code: string;
  language: string | null;
}

/**
 * Renders a fenced code block with:
 *   - Language pill in the top-right (mono uppercase, --ink-tertiary).
 *   - Synchronous syntax highlighting via highlight.js (common-language bundle —
 *     ~50 KB; covers JS/TS/JSON/Python/Bash/Rust/Go/CSS/HTML and others).
 *   - Hover-only copy button.
 *   - Special routing: ```mermaid``` is lazy-loaded into <MermaidDiagram>; the
 *     mermaid library itself (~700 KB) is only paid for when a mermaid fence
 *     is actually present in the conversation.
 *
 * The component is purely presentational — no message-store interaction.
 */
export function CodeFence({ code, language }: CodeFenceProps) {
  const lang = (language ?? "").toLowerCase().trim();

  if (lang === "mermaid") {
    return <MermaidDiagram source={code} />;
  }

  return <HighlightedCode code={code} language={lang} />;
}

function HighlightedCode({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const html = useMemo(() => {
    if (!code) return "";
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language, ignoreIllegals: true }).value;
      }
      // No language given (or unrecognized) — render as plain escaped code.
      // hljs's auto-detect aggressively classifies short freeform text as
      // CSS selectors or shell, producing misleading colours.  Plain text is
      // the honest default; the user can always copy the snippet to its
      // proper home for highlighting.
      return escapeHtml(code);
    } catch {
      // Highlighting must never crash the surface; on error return the raw
      // code with HTML escapes so the user still sees their text.
      return escapeHtml(code);
    }
  }, [code, language]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard write can fail in headless contexts — ignore.
    }
  };

  const displayLang = language || "code";

  return (
    <figure className="agent-code-fence" data-language={displayLang}>
      <header className="agent-code-fence-header">
        <span className="agent-code-fence-lang">{displayLang}</span>
        <button
          type="button"
          className="agent-code-fence-copy"
          onClick={onCopy}
          aria-label="Copy code"
          title="Copy"
        >
          {copied ? "copied" : "copy"}
        </button>
      </header>
      <pre className="agent-code-fence-body">
        <code
          className={language ? `language-${language} hljs` : "hljs"}
          // highlight.js returns sanitized HTML — safe to render. We never
          // pass through raw user-controlled HTML; only highlight.js output.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </figure>
  );
}

/**
 * Lazy mermaid loader.  The mermaid bundle is large (~700 KB) so we import
 * it on first render and cache the module-level promise.  Subsequent fences
 * reuse it without paying again.
 */
let mermaidModule: Promise<typeof import("mermaid")> | null = null;
let mermaidCounter = 0;

function MermaidDiagram({ source }: { source: string }) {
  const id = useRef(`mermaid-${++mermaidCounter}`);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!mermaidModule) {
      mermaidModule = import("mermaid").then((m) => {
        m.default.initialize({
          startOnLoad: false,
          theme: "dark",
          fontFamily: "var(--font-mono)",
          securityLevel: "strict",
        });
        return m;
      });
    }
    mermaidModule
      .then((m) => m.default.render(id.current, source))
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
      });
    return () => { cancelled = true; };
  }, [source]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access may fail in headless contexts; ignore.
    }
  };

  if (error) {
    return (
      <figure className="agent-code-fence agent-code-fence-mermaid-error">
        <header className="agent-code-fence-header">
          <span className="agent-code-fence-lang">mermaid</span>
          <span className="agent-code-fence-error">parse error</span>
        </header>
        <pre className="agent-code-fence-body">{source}</pre>
      </figure>
    );
  }

  return (
    <figure className="agent-code-fence agent-code-fence-mermaid">
      <header className="agent-code-fence-header">
        <span className="agent-code-fence-lang">mermaid</span>
        <span className="agent-code-fence-mermaid-actions">
          <button
            type="button"
            className="agent-code-fence-mermaid-toggle"
            onClick={() => setShowSource((s) => !s)}
            aria-pressed={showSource}
            title={showSource ? "Show diagram" : "Show source"}
          >
            {showSource ? "diagram" : "source"}
          </button>
          <button
            type="button"
            className="agent-code-fence-copy"
            onClick={onCopy}
            aria-label="Copy mermaid source"
            title="Copy"
          >
            {copied ? "copied" : "copy"}
          </button>
        </span>
      </header>
      {showSource ? (
        <pre className="agent-code-fence-body">{source}</pre>
      ) : (
        <div
          className="agent-code-fence-mermaid-body"
          // mermaid renders trusted SVG — securityLevel: "strict" is set in
          // initialize() above, which strips foreignObjects and inline scripts.
          dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
        />
      )}
    </figure>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
