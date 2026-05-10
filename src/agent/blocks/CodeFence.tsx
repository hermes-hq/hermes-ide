import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import hljs from "highlight.js/lib/common";
import { ExpandedViewModal } from "./ExpandedViewModal";

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

/**
 * Collapse threshold: code blocks longer than this render in a collapsed
 * "show first N lines" state with a "show all" button.  Keeping a quiet
 * preview avoids blowing up the conversation for assistant turns that paste
 * 200-line files — and dramatically reduces React reconciliation cost
 * during streaming, which the user experiences as input latency.
 */
const CODE_FENCE_COLLAPSE_THRESHOLD = 18;
const CODE_FENCE_COLLAPSED_LINES = 14;

function HighlightedCode({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  // Count once.  splitting on "\n" is enough — we only need a length check
  // and to slice the visible head when collapsed.
  const lineCount = useMemo(() => {
    if (!code) return 0;
    const trimmed = code.replace(/\n+$/, "");
    return trimmed.split("\n").length;
  }, [code]);

  const isCollapsible = lineCount > CODE_FENCE_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);

  // Pick the displayed text: the full code when expanded or short, else the
  // first N lines.  Highlight only what we render so the long-block path
  // doesn't pay the full hljs cost up front.
  const displayedCode = useMemo(() => {
    if (!isCollapsible || expanded) return code;
    const trimmed = code.replace(/\n+$/, "");
    return trimmed.split("\n").slice(0, CODE_FENCE_COLLAPSED_LINES).join("\n");
  }, [code, isCollapsible, expanded]);

  const html = useMemo(() => {
    if (!displayedCode) return "";
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(displayedCode, { language, ignoreIllegals: true }).value;
      }
      if (language) {
        // Language hint was given but the common bundle doesn't carry it
        // (e.g. scala, dart, elixir).  Fall back to auto-detection so the
        // user still sees coloured tokens — better than a labelled pill
        // sitting over plain text.
        return hljs.highlightAuto(displayedCode).value;
      }
      // No language given — render as plain escaped code.  hljs's auto-detect
      // aggressively classifies short freeform text as CSS selectors or
      // shell, producing misleading colours.  Plain text is the honest
      // default; the user can always copy the snippet to its proper home
      // for highlighting.
      return escapeHtml(displayedCode);
    } catch {
      // Highlighting must never crash the surface; on error return the raw
      // code with HTML escapes so the user still sees their text.
      return escapeHtml(displayedCode);
    }
  }, [displayedCode, language]);

  const onCopy = async () => {
    try {
      // Always copy the FULL code, even when only the head is rendered.
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard write can fail in headless contexts — ignore.
    }
  };

  const displayLang = language || "code";
  const hiddenLines = lineCount - CODE_FENCE_COLLAPSED_LINES;

  return (
    <figure
      className={`agent-code-fence${isCollapsible && !expanded ? " agent-code-fence-collapsed" : ""}`}
      data-language={displayLang}
    >
      <header className="agent-code-fence-header">
        <span className="agent-code-fence-lang">
          {displayLang}
          {isCollapsible && (
            <span className="agent-code-fence-line-count">
              {" · "}
              {lineCount} lines
            </span>
          )}
        </span>
        <span className="agent-code-fence-actions">
          {isCollapsible && (
            <button
              type="button"
              className="agent-code-fence-toggle"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              title={expanded ? "Collapse" : `Show all ${lineCount} lines`}
            >
              {expanded ? "show less" : `show all (${hiddenLines}+)`}
            </button>
          )}
          <button
            type="button"
            className="agent-code-fence-copy"
            onClick={onCopy}
            aria-label="Copy code"
            title="Copy"
          >
            {copied ? "copied" : "copy"}
          </button>
        </span>
      </header>
      <pre className="agent-code-fence-body">
        <code
          className={language ? `language-${language} hljs` : "hljs"}
          // highlight.js returns sanitized HTML — safe to render. We never
          // pass through raw user-controlled HTML; only highlight.js output.
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {isCollapsible && !expanded && (
          <button
            type="button"
            className="agent-code-fence-show-more"
            onClick={() => setExpanded(true)}
            aria-label={`Show all ${lineCount} lines`}
          >
            ▾ Show {hiddenLines} more lines
          </button>
        )}
        {isCollapsible && expanded && (
          <button
            type="button"
            className="agent-code-fence-show-less"
            onClick={() => setExpanded(false)}
            aria-label="Collapse code block"
          >
            ▴ Collapse
          </button>
        )}
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
  const [expanded, setExpanded] = useState(false);
  const expandTriggerRef = useRef<HTMLButtonElement | null>(null);

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
    <>
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
              ref={expandTriggerRef}
              type="button"
              className="agent-code-fence-expand"
              onClick={() => setExpanded(true)}
              aria-label="Expand diagram"
              title="Expand"
              disabled={!svg}
            >
              expand
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
      {expanded && svg && (
        <ExpandedMermaidView svg={svg} onClose={() => setExpanded(false)} />
      )}
    </>
  );
}

/**
 * Full-screen mermaid viewer.
 *
 * The diagram is auto-fit to the visible viewport on first paint and
 * centered both horizontally and vertically.  The user can:
 *   - Click − / + (or Ctrl/Cmd-wheel) to zoom in 25 % increments.
 *   - Click ↑ ↓ ← → to pan the view, or scroll the container directly.
 *
 * Layout note: instead of CSS `transform: scale()` (which doesn't grow
 * the scroll container) we set explicit pixel width/height on the stage
 * equal to the SVG's natural size × zoom and let the SVG fill the stage
 * via CSS.  That way the surrounding scroll container correctly tracks
 * the scaled bounds and the directional pan buttons / mouse wheel can
 * reach the entire diagram.
 */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.25;
const PAN_AMOUNT = 160;
const FIT_PADDING = 32;

function ExpandedMermaidView({ svg, onClose }: { svg: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [hasFit, setHasFit] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  // Compute the fit-to-viewport zoom — used both for first-paint and the
  // explicit reset action.
  const computeFit = (): number | null => {
    const scroller = scrollerRef.current;
    if (!scroller || !natural) return null;
    const availW = scroller.clientWidth - FIT_PADDING * 2;
    const availH = scroller.clientHeight - FIT_PADDING * 2;
    if (availW <= 0 || availH <= 0) return null;
    const fit = Math.min(availW / natural.w, availH / natural.h, MAX_ZOOM);
    return fit >= MIN_ZOOM ? fit : null;
  };

  // Zoom while keeping the centre of the viewport fixed on the same point
  // of the diagram.  Without this, clicking "+" makes the diagram appear
  // to jump because the surrounding flex/grid layout re-centres around a
  // different anchor each step.
  const zoomBy = (delta: number) => {
    const scroller = scrollerRef.current;
    const old = zoomRef.current;
    const next = clamp(old + delta);
    if (next === old || !scroller) {
      setZoom(next);
      return;
    }
    const cx = scroller.scrollLeft + scroller.clientWidth / 2;
    const cy = scroller.scrollTop + scroller.clientHeight / 2;
    const ratio = next / old;
    setZoom(next);
    // After React commits the new frame size, restore the focal point.
    requestAnimationFrame(() => {
      scroller.scrollLeft = cx * ratio - scroller.clientWidth / 2;
      scroller.scrollTop = cy * ratio - scroller.clientHeight / 2;
    });
  };

  const zoomIn = () => zoomBy(ZOOM_STEP);
  const zoomOut = () => zoomBy(-ZOOM_STEP);

  // Measure the SVG's intrinsic size after `dangerouslySetInnerHTML` lands.
  // mermaid emits an explicit viewBox; that's the source of truth for the
  // diagram's intrinsic aspect / size.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const svgEl = stage.querySelector("svg") as SVGSVGElement | null;
    if (!svgEl) return;
    const vb = svgEl.viewBox?.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) {
      setNatural({ w: vb.width, h: vb.height });
      return;
    }
    const r = svgEl.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      setNatural({ w: r.width, h: r.height });
    }
  }, [svg]);

  // First-paint fit.
  useEffect(() => {
    if (hasFit || !natural) return;
    const fit = computeFit();
    if (fit !== null) {
      setZoom(fit);
      setHasFit(true);
    }
    // computeFit reads natural + scrollerRef; re-evaluate when natural changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural, hasFit]);

  // Re-fit on window resize until the user manually zooms.
  useEffect(() => {
    if (!hasFit) return;
    const onResize = () => {
      const fit = computeFit();
      if (fit !== null) setZoom(fit);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFit, natural]);

  // Wheel-to-zoom on Ctrl/Cmd; native scroll otherwise.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pan = (dx: number, dy: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dx, top: dy, behavior: "smooth" });
  };

  const resetFit = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const fit = computeFit();
    if (fit !== null) setZoom(fit);
    requestAnimationFrame(() => {
      // After fit applies, scroll is irrelevant (content fits) but reset
      // anyway so a previously-panned position doesn't linger.
      scroller.scrollTo({ left: 0, top: 0, behavior: "smooth" });
    });
  };

  // Keyboard shortcuts: arrow keys pan, "0" resets to fit.  Skipped when
  // focus is on a typing surface so we never hijack normal text editing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          pan(0, -PAN_AMOUNT);
          break;
        case "ArrowDown":
          e.preventDefault();
          pan(0, PAN_AMOUNT);
          break;
        case "ArrowLeft":
          e.preventDefault();
          pan(-PAN_AMOUNT, 0);
          break;
        case "ArrowRight":
          e.preventDefault();
          pan(PAN_AMOUNT, 0);
          break;
        case "+":
        case "=":
          e.preventDefault();
          zoomBy(ZOOM_STEP);
          break;
        case "-":
        case "_":
          e.preventDefault();
          zoomBy(-ZOOM_STEP);
          break;
        case "0":
          e.preventDefault();
          resetFit();
          break;
        default:
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural]);

  // Frame holds the scaled bounds (so the scroll container sees a real
  // overflow rect to scroll within).  The stage inside is at natural
  // dimensions and uses transform: scale with origin top-left so visual
  // scaling never reflows the SVG layout — that's what made earlier zoom
  // attempts feel "jumpy".
  const frameStyle = natural
    ? { width: `${natural.w * zoom}px`, height: `${natural.h * zoom}px` }
    : undefined;
  const stageStyle: CSSProperties | undefined = natural
    ? {
        width: `${natural.w}px`,
        height: `${natural.h}px`,
        transform: `scale(${zoom})`,
        transformOrigin: "top left",
      }
    : undefined;

  const actions = (
    <>
      <span className="agent-expand-pan-group" role="group" aria-label="Pan">
        <button
          type="button"
          className="agent-expand-pan"
          onClick={() => pan(0, -PAN_AMOUNT)}
          aria-label="Pan up"
          title="Pan up"
        >
          ↑
        </button>
        <button
          type="button"
          className="agent-expand-pan"
          onClick={() => pan(-PAN_AMOUNT, 0)}
          aria-label="Pan left"
          title="Pan left"
        >
          ←
        </button>
        <button
          type="button"
          className="agent-expand-pan"
          onClick={() => pan(PAN_AMOUNT, 0)}
          aria-label="Pan right"
          title="Pan right"
        >
          →
        </button>
        <button
          type="button"
          className="agent-expand-pan"
          onClick={() => pan(0, PAN_AMOUNT)}
          aria-label="Pan down"
          title="Pan down"
        >
          ↓
        </button>
      </span>
      <button
        type="button"
        className="agent-expand-zoom"
        onClick={zoomOut}
        aria-label="Zoom out"
        title="Zoom out"
        disabled={zoom <= MIN_ZOOM + 1e-6}
      >
        −
      </button>
      <span className="agent-expand-zoom-level" aria-live="polite">
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        className="agent-expand-zoom"
        onClick={zoomIn}
        aria-label="Zoom in"
        title="Zoom in"
        disabled={zoom >= MAX_ZOOM - 1e-6}
      >
        +
      </button>
      <button
        type="button"
        className="agent-expand-reset"
        onClick={resetFit}
        aria-label="Reset zoom to fit"
        title="Reset (0)"
      >
        reset
      </button>
    </>
  );

  return (
    <ExpandedViewModal title="mermaid diagram" onClose={onClose} actions={actions}>
      <div ref={scrollerRef} className="agent-expand-mermaid-scroller">
        <div className="agent-expand-mermaid-frame" style={frameStyle}>
          <div
            ref={stageRef}
            className="agent-expand-mermaid-stage"
            style={stageStyle}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </ExpandedViewModal>
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
